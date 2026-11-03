package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase"
	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

func startTestServer(t *testing.T) (*httptest.Server, *pocketbase.PocketBase) {
	t.Helper()
	pb := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	Register(pb)
	if err := pb.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	if err := pb.RunAppMigrations(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pb.OnTerminate().Trigger(&core.TerminateEvent{App: pb}); err != nil {
			t.Errorf("terminate app: %v", err)
		}
		if err := pb.ResetBootstrapState(); err != nil {
			t.Errorf("reset app: %v", err)
		}
	})
	router, err := apis.NewRouter(pb)
	if err != nil {
		t.Fatal(err)
	}
	var server *httptest.Server
	err = pb.OnServe().Trigger(&core.ServeEvent{App: pb, Router: router}, func(e *core.ServeEvent) error {
		mux, err := e.Router.BuildMux()
		if err != nil {
			return err
		}
		server = httptest.NewServer(mux)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return server, pb
}

func TestInspectionAPI(t *testing.T) {
	database := os.Getenv("DATABASE_URL")
	redisURL := os.Getenv("REDIS_URL")
	t.Setenv("APP_ENV", "test-"+time.Now().UTC().Format("20060102150405.000000000"))
	if database == "" || redisURL == "" {
		t.Skip("scratch services required")
	}
	u, err := url.Parse(database)
	if err != nil || u.Hostname() != "127.0.0.1" || u.Path != "/health_scratch" {
		t.Fatal("tests require scratch database")
	}
	u.User = url.UserPassword("scratch_admin", "scratch-admin-only")
	adminURL := u.String()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	reader, err := pgx.Connect(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Exec(ctx, `DELETE FROM public.facilities WHERE source_id='pin'`); err == nil {
		t.Fatal("reader can write")
	}
	reader.Close(ctx)
	start := func(db, cache string) (*httptest.Server, *pocketbase.PocketBase) {
		t.Helper()
		t.Setenv("DATABASE_URL", db)
		t.Setenv("REDIS_URL", cache)
		return startTestServer(t)
	}
	request := func(server *httptest.Server, path string, headers map[string]string) (int, http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequest("GET", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept-Encoding", "identity")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, res.Header, body
	}
	server, _ := start(database, redisURL)
	// Hold the source query so a second request can join the first fill before its caller cancels.
	lock, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Rollback(context.Background()) })
	if _, err := lock.Exec(ctx, `LOCK TABLE public.facilities IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	leaderCtx, cancelLeader := context.WithCancel(ctx)
	defer cancelLeader()
	leaderRequest, err := http.NewRequestWithContext(leaderCtx, "GET", server.URL+"/api/inspect/points", nil)
	if err != nil {
		t.Fatal(err)
	}
	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		res, _ := http.DefaultClient.Do(leaderRequest)
		if res != nil {
			res.Body.Close()
		}
	}()
	waitForConnections := func(minimum int) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := admin.Exec(ctx, `SELECT pg_catalog.pg_stat_clear_snapshot()`); err != nil {
				t.Fatal(err)
			}
			var total, blocked int
			err := admin.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE wait_event_type = 'Lock') FROM pg_catalog.pg_stat_activity WHERE usename = 'ga_inspect_reader' AND datname = current_database()`).Scan(&total, &blocked)
			if err != nil {
				t.Fatal(err)
			}
			if total >= minimum && blocked >= 1 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("timed out waiting for inspection requests")
	}
	waitForConnections(1)
	waiterDone := make(chan int, 1)
	go func() {
		res, err := http.Get(server.URL + "/api/inspect/points")
		if err != nil {
			waiterDone <- 0
			return
		}
		defer res.Body.Close()
		waiterDone <- res.StatusCode
	}()
	waitForConnections(2)
	time.Sleep(50 * time.Millisecond)
	cancelLeader()
	<-leaderDone
	if err := lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if status := <-waiterDone; status != http.StatusOK {
		t.Fatalf("fill canceled with leader: %d", status)
	}
	code, header, body := request(server, "/api/inspect/points", nil)
	if code != 200 {
		t.Fatalf("points: %d %s", code, body)
	}
	etag := header.Get("ETag")
	if etag == "" || !strings.Contains(header.Get("Vary"), "Accept-Encoding") {
		t.Fatal("missing cache headers")
	}
	var points struct {
		Points []struct {
			ID          string    `json:"id"`
			Coordinates []float64 `json:"coordinates"`
		} `json:"points"`
		PermitChoices []string `json:"permitChoices"`
		GeneratedAt   string   `json:"generatedAt"`
	}
	if err = json.Unmarshal(body, &points); err != nil {
		t.Fatal(err)
	}
	if len(points.Points) != 2 || len(points.PermitChoices) != 2 || points.Points[0].ID != "pin" || points.Points[0].Coordinates[0] != -84.388 || points.Points[0].Coordinates[1] != 33.749 {
		t.Fatalf("points semantics: %s", body)
	}
	code, h, zipped := request(server, "/api/inspect/points", map[string]string{"Accept-Encoding": "gzip"})
	if code != 200 || h.Get("Content-Encoding") != "gzip" || h.Get("ETag") != etag {
		t.Fatal("gzip headers")
	}
	zr, err := gzip.NewReader(bytes.NewReader(zipped))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	zr.Close()
	if err != nil || !bytes.Equal(plain, body) {
		t.Fatal("gzip payload mismatch")
	}
	code, _, notModified := request(server, "/api/inspect/points", map[string]string{"If-None-Match": etag})
	if code != 304 || len(notModified) != 0 {
		t.Fatal("conditional response")
	}
	for _, path := range []string{"/api/inspect/search?q=%00", "/api/inspect/search?permit=%FF", "/api/inspect/facilities/%00", "/api/inspect/facilities/%FF"} {
		code, _, _ := request(server, path, nil)
		if code != 400 {
			t.Fatalf("invalid input %s: %d", path, code)
		}
	}
	code, _, search := request(server, "/api/inspect/search?q=Missing", nil)
	if code != 200 || !strings.Contains(string(search), `"id":"missing"`) || !strings.Contains(string(search), `"lastInspectionScore":null`) {
		t.Fatalf("search %d %s", code, search)
	}
	for _, query := range []string{"%", "_", `\`} {
		code, _, body := request(server, "/api/inspect/search?q="+url.QueryEscape(query), nil)
		var result struct {
			Facilities []struct {
				ID string `json:"id"`
			} `json:"facilities"`
		}
		if err := json.Unmarshal(body, &result); code != 200 || err != nil || len(result.Facilities) != 1 || result.Facilities[0].ID != "123456789012345678" {
			t.Fatalf("literal search %q: %d %s", query, code, body)
		}
	}
	code, h, detail := request(server, "/api/inspect/facilities/pin", nil)
	var decoded struct {
		Facility struct {
			LastInspectionDate string `json:"lastInspectionDate"`
		} `json:"facility"`
		Inspections []struct {
			ID string `json:"id"`
		} `json:"inspections"`
	}
	err = json.Unmarshal(detail, &decoded)
	if code != 200 || err != nil || h.Get("Cache-Control") != "no-store" || decoded.Facility.LastInspectionDate != "2025-02-01" || len(decoded.Inspections) != 2 || decoded.Inspections[1].ID != "9007199254740993" || strings.Contains(string(detail), "superseded") || !strings.Contains(string(detail), "historical violation") {
		t.Fatalf("detail %d %s", code, detail)
	}
	code, _, detail = request(server, "/api/inspect/facilities/123456789012345678", nil)
	if code != 200 || !strings.Contains(string(detail), "123456789012345678") {
		t.Fatalf("numeric id %d %s", code, detail)
	}
	if _, err = admin.Exec(ctx, `INSERT INTO public.etl_runs (started,finished,status,options,next_page) VALUES (now(), '2098-01-01', 'failed', '{}', 1)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(ctx, adminURL)
		if err == nil {
			defer c.Close(ctx)
			_, _ = c.Exec(ctx, `DELETE FROM public.etl_runs WHERE finished='2098-01-01'`)
		}
	})
	code, _, _ = request(server, "/api/inspect/points", map[string]string{"If-None-Match": etag})
	if code != 304 {
		t.Fatalf("failed run invalidated cache: %d", code)
	}
	if _, err = admin.Exec(ctx, `INSERT INTO public.etl_runs (started,finished,status,options,next_page) VALUES (now(), '2099-01-01', 'caught_up', '{}', 1)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin, err := pgx.Connect(ctx, adminURL)
		if err == nil {
			defer admin.Close(ctx)
			admin.Exec(ctx, `DELETE FROM public.etl_runs WHERE finished='2099-01-01'`)
		}
	})
	code, h, updated := request(server, "/api/inspect/points", map[string]string{"If-None-Match": etag})
	if code != 200 || h.Get("ETag") == etag || bytes.Equal(body, updated) {
		t.Fatalf("generation did not invalidate: %d", code)
	}
	updatedETag := h.Get("ETag")
	deadDB := "postgres://ga_inspect_reader:scratch-reader-only@127.0.0.1:1/health_scratch?sslmode=disable&connect_timeout=1"
	stale, _ := start(deadDB, redisURL)
	var staleBody []byte
	deadline := time.Now().Add(2 * time.Second)
	for {
		code, h, staleBody = request(stale, "/api/inspect/points", map[string]string{"If-None-Match": updatedETag})
		if bytes.Equal(staleBody, updated) || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code != 200 || h.Get("X-Inspection-Stale") != "true" || h.Get("Cache-Control") != "no-store" || h.Get("ETag") != "" || !bytes.Equal(staleBody, updated) {
		t.Fatalf("stale: %d %s", code, staleBody)
	}
	// A transient cache timeout followed by a blocked fill must retry the snapshot.
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cache := redis.NewClient(opts)
	defer cache.Close()
	fillLock, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer fillLock.Rollback(ctx)
	if _, err = fillLock.Exec(ctx, `LOCK TABLE public.facilities IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	if err = cache.Do(ctx, "CLIENT", "PAUSE", "500", "ALL").Err(); err != nil {
		t.Fatal(err)
	}
	code, h, fallbackBody := request(server, "/api/inspect/points", nil)
	if code != 200 || h.Get("X-Inspection-Stale") != "true" || !bytes.Equal(fallbackBody, updated) {
		t.Fatalf("fill failure fallback: %d %s", code, fallbackBody)
	}
	if err = fillLock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cold, _ := start(deadDB, "redis://127.0.0.1:1/0")
	code, _, _ = request(cold, "/api/inspect/points", nil)
	if code != 503 {
		t.Fatalf("cold: %d", code)
	}
	down, downPB := start(database, "redis://127.0.0.1:1/0")
	users, err := downPB.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	owner := core.NewRecord(users)
	owner.SetEmail("visitor@example.test")
	owner.SetPassword("password1234")
	owner.Set("name", "Visitor")
	owner.Set("role", "user")
	if err := downPB.Save(owner); err != nil {
		t.Fatal(err)
	}
	ratings, err := downPB.FindCollectionByNameOrId("ratings")
	if err != nil {
		t.Fatal(err)
	}
	rating := core.NewRecord(ratings)
	rating.Set("owner", owner.Id)
	rating.Set("facility_id", "pin")
	rating.Set("rating", 4)
	if err := downPB.Save(rating); err != nil {
		t.Fatal(err)
	}
	code, downHeader, _ := request(down, "/api/inspect/points", nil)
	if code != 200 || downHeader.Get("ETag") != updatedETag {
		t.Fatalf("redis down points: %d, ETag changed without data change", code)
	}
	code, _, detail = request(down, "/api/inspect/facilities/pin", nil)
	var live struct {
		Community struct {
			RatingAverage *float64 `json:"ratingAverage"`
			RatingCount   int      `json:"ratingCount"`
		} `json:"community"`
	}
	if err := json.Unmarshal(detail, &live); code != 200 || err != nil || live.Community.RatingCount != 1 || live.Community.RatingAverage == nil || *live.Community.RatingAverage != 4 {
		t.Fatalf("redis down detail: %d %s", code, detail)
	}
	for _, db := range []string{adminURL, adminURL + "&role=ga_inspect_reader"} {
		super, _ := start(db, "")
		code, _, _ = request(super, "/api/inspect/search", nil)
		if code != 503 {
			t.Fatalf("superuser not rejected: %d", code)
		}
	}
}

func TestCommunityPermissions(t *testing.T) {
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("scratch services required")
	}
	server, pb := startTestServer(t)
	request := func(method, path, token string, data any, want int) map[string]any {
		t.Helper()
		var body io.Reader
		if data != nil {
			b, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			body = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, server.URL+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, res.StatusCode, want, b)
		}
		result := map[string]any{}
		if len(b) > 0 {
			if err := json.Unmarshal(b, &result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	mkuser := func(name, role string, verified bool) (*core.Record, string) {
		t.Helper()
		col, err := pb.FindCollectionByNameOrId("users")
		if err != nil {
			t.Fatal(err)
		}
		r := core.NewRecord(col)
		r.SetEmail(name + "@example.test")
		r.SetPassword("password1234")
		r.Set("name", name)
		r.Set("role", role)
		r.SetVerified(verified)
		if err := pb.Save(r); err != nil {
			t.Fatal(err)
		}
		token, err := r.NewAuthToken()
		if err != nil {
			t.Fatal(err)
		}
		return r, token
	}
	owner, ownerToken := mkuser("Owner", "user", true)
	other, otherToken := mkuser("Other", "user", true)
	mod, modToken := mkuser("Moderator", "moderator", true)
	admin, adminToken := mkuser("Admin", "admin", true)
	unverified, unverifiedToken := mkuser("Unverified", "user", false)
	_, unverifiedAdminToken := mkuser("UnverifiedAdmin", "admin", false)
	superCol, err := pb.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatal(err)
	}
	super := core.NewRecord(superCol)
	super.SetEmail("super@example.test")
	super.SetPassword("password1234")
	if err := pb.Save(super); err != nil {
		t.Fatal(err)
	}
	superToken, err := super.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	users := "/api/collections/users/records"
	ratings := "/api/collections/ratings/records"
	comments := "/api/collections/comments/records"
	signup := map[string]any{"email": "signup@example.test", "password": "password1234", "passwordConfirm": "password1234", "name": "Signup", "role": "admin"}
	request("POST", users, "", signup, 400)
	delete(signup, "role")
	signup["role+"] = "admin"
	request("POST", users, "", signup, 400)
	delete(signup, "role+")
	created := request("POST", users, "", signup, 200)
	if created["role"] != "user" {
		t.Fatalf("signup role: %v", created)
	}
	request("PATCH", users+"/"+owner.Id, ownerToken, map[string]any{"role": "admin"}, 404)
	request("PATCH", users+"/"+other.Id, modToken, map[string]any{"role": "admin"}, 404)
	request("PATCH", users+"/"+admin.Id, adminToken, map[string]any{"role": "user"}, 404)
	request("PATCH", users+"/"+other.Id, unverifiedAdminToken, map[string]any{"role": "moderator"}, 404)
	request("PATCH", users+"/"+other.Id, adminToken, map[string]any{"role": "moderator", "name": "hacked"}, 400)
	request("PATCH", users+"/"+other.Id, adminToken, map[string]any{"name": "hacked"}, 400)
	request("PATCH", users+"/"+other.Id, adminToken, map[string]any{"password": "newpassword1234", "passwordConfirm": "newpassword1234"}, 400)
	request("PATCH", users+"/"+other.Id, superToken, map[string]any{"role": "admin", "verified": true}, 200)
	moderator := request("POST", users, superToken, map[string]any{"email": "supercreated@example.test", "password": "password1234", "passwordConfirm": "password1234", "name": "Super Created", "role": "moderator"}, 200)
	if moderator["role"] != "moderator" {
		t.Fatalf("superuser-created role: %v", moderator)
	}
	defaultRole := request("POST", users, superToken, map[string]any{"email": "superdefault@example.test", "password": "password1234", "passwordConfirm": "password1234", "name": "Super Default"}, 200)
	if defaultRole["role"] != "user" {
		t.Fatalf("superuser default role: %v", defaultRole)
	}
	request("PATCH", users+"/"+other.Id, adminToken, map[string]any{"role": "user"}, 200)
	rating := map[string]any{"owner": owner.Id, "facility_id": "missing", "rating": 4}
	request("POST", ratings, unverifiedToken, map[string]any{"owner": unverified.Id, "facility_id": "missing", "rating": 4}, 400)
	request("POST", ratings, otherToken, rating, 400)
	invalid := map[string]any{"owner": owner.Id, "facility_id": "does-not-exist", "rating": 4}
	request("POST", ratings, ownerToken, invalid, 400)
	for _, value := range []any{0, 6, 2.5} {
		request("POST", ratings, ownerToken, map[string]any{"owner": owner.Id, "facility_id": "missing", "rating": value}, 400)
	}
	r := request("POST", ratings, ownerToken, rating, 200)
	rid := r["id"].(string)
	if r["authorName"] != "Owner" {
		t.Fatalf("author enrichment: %v", r)
	}
	request("POST", ratings, ownerToken, rating, 400)
	request("PATCH", ratings+"/"+rid, ownerToken, map[string]any{"facility_id": "pin"}, 404)
	request("PATCH", ratings+"/"+rid, ownerToken, map[string]any{"owner": other.Id}, 404)
	request("PATCH", ratings+"/"+rid, modToken, map[string]any{"rating": 1}, 404)
	request("PATCH", ratings+"/"+rid, ownerToken, map[string]any{"created": "2000-01-01 00:00:00.000Z"}, 400)
	request("PATCH", ratings+"/"+rid, ownerToken, map[string]any{"rating": 5}, 200)
	c := request("POST", comments, ownerToken, map[string]any{"owner": owner.Id, "facility_id": "missing", "body": "hello"}, 200)
	cid := c["id"].(string)
	list := request("GET", comments, "", nil, 200)
	items := list["items"].([]any)
	item := items[0].(map[string]any)
	if item["authorName"] != "Owner" || item["email"] != nil || item["expand"] != nil {
		t.Fatalf("public fields: %v", item)
	}
	expanded := request("GET", comments+"?expand=owner", "", nil, 200)
	if fields, ok := expanded["items"].([]any)[0].(map[string]any)["expand"].(map[string]any); ok && fields["owner"] != nil {
		t.Fatalf("private owner expansion: %v", expanded)
	}
	request("GET", users+"/"+owner.Id, "", nil, 404)
	request("PATCH", comments+"/"+cid, ownerToken, map[string]any{"body": strings.Repeat("x", 2001)}, 400)
	request("PATCH", comments+"/"+cid, otherToken, map[string]any{"body": "hacked"}, 404)
	request("PATCH", comments+"/"+cid, ownerToken, map[string]any{"body": "updated"}, 200)
	request("DELETE", comments+"/"+cid, otherToken, nil, 404)
	request("DELETE", comments+"/"+cid, modToken, nil, 204)
	commentCollection, err := pb.FindCollectionByNameOrId("comments")
	if err != nil {
		t.Fatal(err)
	}
	unverifiedComment := core.NewRecord(commentCollection)
	unverifiedComment.Set("owner", unverified.Id)
	unverifiedComment.Set("facility_id", "missing")
	unverifiedComment.Set("body", "existing")
	if err := pb.Save(unverifiedComment); err != nil {
		t.Fatal(err)
	}
	request("PATCH", comments+"/"+unverifiedComment.Id, unverifiedToken, map[string]any{"body": "changed"}, 404)
	request("DELETE", comments+"/"+unverifiedComment.Id, unverifiedToken, nil, 404)
	request("DELETE", ratings+"/"+rid, unverifiedAdminToken, nil, 404)
	detail := request("GET", "/api/inspect/facilities/missing", "", nil, 200)
	aggregate := detail["community"].(map[string]any)
	if aggregate["ratingCount"] != float64(1) || aggregate["ratingAverage"] != float64(5) {
		t.Fatalf("aggregate: %v", aggregate)
	}
	request("PATCH", users+"/"+mod.Id, adminToken, map[string]any{"role": "user"}, 200)
	request("DELETE", ratings+"/"+rid, modToken, nil, 404)
	request("DELETE", ratings+"/"+rid, adminToken, nil, 204)
	detail = request("GET", "/api/inspect/facilities/missing", "", nil, 200)
	aggregate = detail["community"].(map[string]any)
	if aggregate["ratingCount"] != float64(0) || aggregate["ratingAverage"] != nil {
		t.Fatalf("aggregate after delete: %v", aggregate)
	}

	// A source outage blocks new and edited contributions, not reads or moderation.
	t.Setenv("DATABASE_URL", "postgres://ga_inspect_reader:scratch-reader-only@127.0.0.1:1/health_scratch?sslmode=disable&connect_timeout=1")
	server, down := startTestServer(t)
	downUsers, err := down.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	downOwner := core.NewRecord(downUsers)
	downOwner.SetEmail("offline@example.test")
	downOwner.SetPassword("password1234")
	downOwner.Set("name", "Offline")
	downOwner.Set("role", "user")
	downOwner.SetVerified(true)
	if err := down.Save(downOwner); err != nil {
		t.Fatal(err)
	}
	downToken, err := downOwner.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	downComments, err := down.FindCollectionByNameOrId("comments")
	if err != nil {
		t.Fatal(err)
	}
	downComment := core.NewRecord(downComments)
	downComment.Set("owner", downOwner.Id)
	downComment.Set("facility_id", "missing")
	downComment.Set("body", "existing")
	if err := down.Save(downComment); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{strings.Repeat("x", 501), "bad\x00id"} {
		request("POST", comments, downToken, map[string]any{"owner": downOwner.Id, "facility_id": id, "body": "new"}, 400)
	}
	request("POST", comments, downToken, map[string]any{"owner": downOwner.Id, "facility_id": "missing", "body": "new"}, 503)
	request("PATCH", comments+"/"+downComment.Id, downToken, map[string]any{"body": "edit"}, 503)
	request("GET", comments+"/"+downComment.Id, "", nil, 200)
	request("DELETE", comments+"/"+downComment.Id, downToken, nil, 204)
}
