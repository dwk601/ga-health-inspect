package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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

func TestManagedSettingsUpdate(t *testing.T) {
	t.Setenv("APP_URL", "https://settings.example.test")
	t.Setenv("SMTP_HOST", "smtp.example.test")
	t.Setenv("SMTP_SENDER_ADDRESS", "settings@example.test")
	server, pb := startTestServer(t)
	collection, err := pb.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatal(err)
	}
	super := core.NewRecord(collection)
	super.SetEmail("super@example.test")
	super.SetPassword("password1234")
	if err := pb.Save(super); err != nil {
		t.Fatal(err)
	}
	token, err := super.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodPatch, http.MethodGet} {
		var body io.Reader
		if method == http.MethodPatch {
			body = strings.NewReader(`{"meta":{"appName":"Updated"},"rateLimits":{"enabled":false,"rules":[]}}`)
		}
		req, err := http.NewRequest(method, server.URL+"/api/settings", body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", token)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var settings struct {
			Meta struct {
				AppURL string `json:"appURL"`
			} `json:"meta"`
			SMTP struct {
				Enabled bool   `json:"enabled"`
				Host    string `json:"host"`
			} `json:"smtp"`
			RateLimits struct {
				Enabled bool `json:"enabled"`
				Rules   []struct {
					Label       string `json:"label"`
					MaxRequests int    `json:"maxRequests"`
				} `json:"rules"`
			} `json:"rateLimits"`
		}
		err = json.NewDecoder(res.Body).Decode(&settings)
		res.Body.Close()
		if err != nil || res.StatusCode != http.StatusOK || settings.Meta.AppURL != "https://settings.example.test" || !settings.SMTP.Enabled || settings.SMTP.Host != "smtp.example.test" || !settings.RateLimits.Enabled {
			t.Fatalf("%s settings: status=%d settings=%+v error=%v", method, res.StatusCode, settings, err)
		}
		for _, label := range []string{"POST /api/inspect/ai/explain", "POST /api/inspect/ai/search"} {
			found := 0
			for _, rule := range settings.RateLimits.Rules {
				if rule.Label == label && rule.MaxRequests == 12 {
					found++
				}
			}
			if found != 1 {
				t.Fatalf("%s managed AI rule %s: %+v", method, label, settings.RateLimits)
			}
		}
	}
}

func TestPlainHTTPRedirect(t *testing.T) {
	server, _ := startTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		visitor string
		path    string
		want    int
	}{
		{visitor: "{\"scheme\":\"http\"}", path: "/", want: http.StatusPermanentRedirect},
		{visitor: "{\"scheme\":\"http\"}", path: "/api/health", want: http.StatusOK},
		{visitor: "{\"scheme\":\"https\"}", path: "/", want: http.StatusOK},
		{visitor: "", path: "/", want: http.StatusOK},
	}
	for _, tc := range cases {
		req, err := http.NewRequest(http.MethodGet, server.URL+tc.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Forwarded-Proto", "http")
		if tc.visitor != "" {
			req.Header.Set("CF-Visitor", tc.visitor)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != tc.want {
			t.Fatalf("%s %s: status %d, want %d", tc.visitor, tc.path, res.StatusCode, tc.want)
		}
		if tc.want == http.StatusPermanentRedirect {
			got, err := res.Location()
			if err != nil {
				t.Fatal(err)
			}
			want := "https://" + base.Host + tc.path
			if got.String() != want {
				t.Fatalf("location %s, want %s", got, want)
			}
		}
	}
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
	request := func(server *httptest.Server, path string, headers map[string]string, data ...string) (int, http.Header, []byte) {
		t.Helper()
		method := http.MethodGet
		var payload io.Reader
		if len(data) > 0 {
			method = http.MethodPost
			payload = strings.NewReader(data[0])
		}
		req, err := http.NewRequest(method, server.URL+path, payload)
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
		GeneratedAt   *string  `json:"generatedAt"`
	}
	if err = json.Unmarshal(body, &points); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339Nano, header.Get("X-Inspection-Generated-At")); err != nil || points.GeneratedAt != nil {
		t.Fatalf("snapshot timestamp header/body: %v %s", err, body)
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
	for _, path := range []string{"/api/inspect/search?sort=bogus", "/api/inspect/search?q=%00", "/api/inspect/search?permit=%FF", "/api/inspect/facilities/%00", "/api/inspect/facilities/%FF"} {
		code, _, _ := request(server, path, nil)
		if code != 400 {
			t.Fatalf("invalid input %s: %d", path, code)
		}
	}
	for _, tc := range []struct{ query, id, place string }{
		{"q=" + url.QueryEscape("peach & pie"), "pin", "Peach & Pie Diner"},
		{"q=Example&sort=score-asc", "zero", ""},
		{"q=Example&sort=score-desc", "pin", "Peach & Pie Diner"},
	} {
		code, _, body := request(server, "/api/inspect/search?"+tc.query, nil)
		var result struct {
			Facilities []struct {
				ID        string  `json:"id"`
				PlaceName *string `json:"placeName"`
			} `json:"facilities"`
		}
		if err := json.Unmarshal(body, &result); code != 200 || err != nil || len(result.Facilities) == 0 || result.Facilities[0].ID != tc.id || (tc.place != "" && (result.Facilities[0].PlaceName == nil || *result.Facilities[0].PlaceName != tc.place)) {
			t.Errorf("search %s: %d %s", tc.query, code, body)
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
	for _, segment := range []string{`33.7°N 84.3°W`, `33.7490° N, 84.3880° W`, `33°44'56.4"N 84°23'16.8"W`} {
		_, err := admin.Exec(ctx, `INSERT INTO public.facilities (source_id, raw, google_places) VALUES ('coordinate-test', '{}', $1)`, "https://maps.example/maps/place/"+url.QueryEscape(segment)+"/rest")
		if err != nil {
			t.Fatal(err)
		}
		code, _, body := request(server, "/api/inspect/facilities/coordinate-test", nil)
		// 33 is a digit run in every normalized segment; a place-only match would return the row.
		searchCode, _, searchBody := request(server, "/api/inspect/search?q=33", nil)
		_, deleteErr := admin.Exec(ctx, `DELETE FROM public.facilities WHERE source_id='coordinate-test'`)
		if deleteErr != nil {
			t.Fatal(deleteErr)
		}
		var result struct {
			Facility struct {
				PlaceName *string `json:"placeName"`
			} `json:"facility"`
		}
		if err := json.Unmarshal(body, &result); code != 200 || err != nil || result.Facility.PlaceName != nil {
			t.Errorf("coordinate place name %q: %d %s", segment, code, body)
		}
		if searchCode != 200 || strings.Contains(string(searchBody), `"id":"coordinate-test"`) {
			t.Errorf("coordinate place %q search: %d %s", segment, searchCode, searchBody)
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
	code, _, detail = request(server, "/api/inspect/facilities/gnr:example", nil)
	if code != 200 || !strings.Contains(string(detail), `"id":"GNR-EXAMPLE"`) || !strings.Contains(string(detail), "Example county observation") || !strings.Contains(string(detail), `"grade":"B"`) {
		t.Fatalf("county detail %d %s", code, detail)
	}
	func() {
		_, err := admin.Exec(ctx, `INSERT INTO public.facilities(source_id,raw) VALUES ('evidence-test','{}');
INSERT INTO public.inspections(facility_id,source_id,report_template,raw,violations_hash,report_fetched_at,report_error) VALUES ('evidence-test',1,'test','{"violations":{"a":["Title","Rule"]}}','snap','2025-01-01','private failure');
INSERT INTO public.violations(facility_id,inspection_id,snapshot_hash,source_key,raw,corrected,repeat) VALUES ('evidence-test',1,'snap','a','["Title","Rule"]',true,true);
INSERT INTO public.gnr_inspections(source_id,facility_id,inspection_date,observations,raw,detail_fetched_at,detail_error) VALUES
('unfetched','evidence-test','2025-01-01',NULL,'{}',NULL,NULL),
('empty','evidence-test','2025-01-01','[]','{}','2025-01-01',NULL),
('failed','evidence-test','2025-01-01',NULL,'{}','2025-01-01','private failure'),
('retained','evidence-test','2025-01-01','["Old"]','{}','2025-01-01','private failure'),
('changed','evidence-test','2025-01-01','["Old"]','{}',NULL,NULL)`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, err := admin.Exec(ctx, `DELETE FROM public.violations WHERE facility_id='evidence-test'; DELETE FROM public.inspections WHERE facility_id='evidence-test'; DELETE FROM public.gnr_inspections WHERE facility_id='evidence-test'; DELETE FROM public.facilities WHERE source_id='evidence-test'`)
			if err != nil {
				t.Error(err)
			}
		}()
		code, _, body := request(server, "/api/inspect/facilities/evidence-test", nil)
		var result struct {
			Inspections []struct {
				ID       string `json:"id"`
				Hash     string `json:"contentHash"`
				Evidence struct {
					Status  string  `json:"findingsStatus"`
					Attempt *string `json:"findingsAttemptedAt"`
					Report  string  `json:"reportStatus"`
				} `json:"evidence"`
				Violations []struct {
					Corrected *bool `json:"corrected"`
					Repeat    *bool `json:"repeat"`
				} `json:"violations"`
			} `json:"inspections"`
		}
		if err := json.Unmarshal(body, &result); err != nil || code != 200 || len(result.Inspections) != 6 || bytes.Contains(body, []byte("private failure")) {
			t.Fatalf("evidence: %d %s", code, body)
		}
		want := map[string]string{"1": "available", "unfetched": "not_fetched", "empty": "available", "failed": "failed", "retained": "refresh_failed", "changed": "pending_refresh"}
		for _, i := range result.Inspections {
			if i.Evidence.Status != want[i.ID] || len(i.Hash) != 64 {
				t.Errorf("evidence %s: %+v", i.ID, i)
			}
			if i.ID == "changed" && i.Evidence.Attempt != nil {
				t.Error("invented refresh timestamp")
			}
			if i.ID == "1" && (i.Evidence.Report != "failed" || len(i.Violations) != 1 || i.Violations[0].Corrected == nil || !*i.Violations[0].Corrected || i.Violations[0].Repeat == nil || !*i.Violations[0].Repeat) {
				t.Errorf("state flags/report: %+v", i)
			}
		}
		if _, err := admin.Exec(ctx, `UPDATE public.inspections SET violations_hash='missing' WHERE facility_id='evidence-test'`); err != nil {
			t.Fatal(err)
		}
		_, _, changed := request(server, "/api/inspect/facilities/evidence-test", nil)
		if bytes.Equal(body, changed) || !bytes.Contains(changed, []byte(`"findingsStatus":"incomplete"`)) {
			t.Fatalf("snapshot change: %s", changed)
		}
	}()
	func() {
		_, err := admin.Exec(ctx, `INSERT INTO public.facilities(source_id,name,address,permit_type,last_inspection_score,raw,google_places)
SELECT 'filter-test-'||n, CASE WHEN n=125 THEN 'Z qualifying' ELSE 'A candidate '||n END, 'Filter Lane', 'Restaurant', CASE WHEN n=125 THEN 99 ELSE 10 END, '{}', 'https://maps.example/!3d'||CASE WHEN n=125 THEN '33.9' ELSE (33.749+n*0.0001)::text END||'!4d-84.388' FROM generate_series(1,125) n;
INSERT INTO public.facilities(source_id,name,address,permit_type,last_inspection_score,raw) VALUES ('filter-test-unmapped','Z unmapped','Filter Lane','Restaurant',99,'{}')`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := admin.Exec(ctx, `DELETE FROM public.facilities WHERE source_id LIKE 'filter-test-%'`); err != nil {
				t.Error(err)
			}
		}()
		for _, tc := range []struct {
			query  string
			count  int
			first  string
			status int
		}{
			{"address=Filter+Lane&permit=Restaurant&minScore=90&maxScore=100", 2, "filter-test-125", 200},
			{"address=Filter+Lane&permit=Restaurant&minScore=90&maxScore=100&lat=33.749&lon=-84.388&radius=25", 1, "filter-test-125", 200},
			{"address=Filter+Lane&lat=33.749&lon=-84.388&radius=25&sort=score-desc", 20, "filter-test-125", 200},
			{"address=Filter+Lane&minScore=90&lat=33.749&lon=-84.388&radius=1", 0, "", 200},
			{"address=Filter+Lane&maxScore=10", 100, "", 200},
			{"name=qualifying&address=Filter+Lane", 1, "filter-test-125", 200},
			{"name=Filter+Lane", 0, "", 200},
			{"minScore=100&maxScore=10", 0, "", 400},
			{"minScore=NaN", 0, "", 400},
			{"radius=5", 0, "", 400},
		} {
			code, _, body := request(server, "/api/inspect/search?"+tc.query, nil)
			var result struct {
				Facilities []struct {
					ID string `json:"id"`
				} `json:"facilities"`
			}
			if err := json.Unmarshal(body, &result); err != nil || code != tc.status || len(result.Facilities) != tc.count || tc.first != "" && result.Facilities[0].ID != tc.first {
				t.Errorf("authoritative filters %s: %d %s", tc.query, code, body)
			}
		}
	}()
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
	for _, tc := range []struct {
		name   string
		body   string
		server *httptest.Server
		status int
		ids    []string
		scores []*float64
	}{
		{name: "ordered deduplicated", body: `{"ids":["zero","unknown","123456789012345678","zero","pin"]}`, status: 200, ids: []string{"zero", "123456789012345678", "pin"}, scores: []*float64{new(float64), nil, func() *float64 { v := 92.0; return &v }()}},
		{name: "unknown", body: `{"ids":["unknown"]}`, status: 200, ids: []string{}},
		{name: "twenty ids", body: `{"ids":[` + strings.Repeat(`"pin",`, 19) + `"pin"]}`, status: 200, ids: []string{"pin"}},
		{name: "maximum id length", body: `{"ids":["` + strings.Repeat("x", 500) + `"]}`, status: 200, ids: []string{}},
		{name: "missing", body: `{}`, status: 400},
		{name: "empty", body: `{"ids":[]}`, status: 400},
		{name: "null array", body: `{"ids":null}`, status: 400},
		{name: "null id", body: `{"ids":[null]}`, status: 400},
		{name: "number", body: `{"ids":[123]}`, status: 400},
		{name: "empty id", body: `{"ids":[""]}`, status: 400},
		{name: "nul", body: `{"ids":["\u0000"]}`, status: 400},
		{name: "utf8", body: "{\"ids\":[\"\xff\"]}", status: 400},
		{name: "long id", body: `{"ids":["` + strings.Repeat("x", 501) + `"]}`, status: 400},
		{name: "too many before dedupe", body: `{"ids":[` + strings.Repeat(`"pin",`, 20) + `"pin"]}`, status: 400},
		{name: "malformed", body: `{"ids":["pin"]} {}`, status: 400},
		{name: "oversize", body: strings.Repeat(" ", 16*1024+1), status: 413},
		{name: "source failure", body: `{"ids":["pin"]}`, server: stale, status: 503},
	} {
		t.Run("lookup/"+tc.name, func(t *testing.T) {
			target := tc.server
			if target == nil {
				target = server
			}
			status, headers, body := request(target, "/api/inspect/facilities/lookup", nil, tc.body)
			if status != tc.status || headers.Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d headers=%v body=%s", status, headers, body)
			}
			if status != 200 {
				return
			}
			var result struct {
				Facilities []struct {
					ID    string   `json:"id"`
					Score *float64 `json:"lastInspectionScore"`
				} `json:"facilities"`
			}
			if err := json.Unmarshal(body, &result); err != nil || result.Facilities == nil || len(result.Facilities) != len(tc.ids) {
				t.Fatalf("invalid response: %s (%v)", body, err)
			}
			for i, id := range tc.ids {
				f := result.Facilities[i]
				if f.ID != id {
					t.Fatalf("order: %s", body)
				}
				if tc.scores != nil && ((f.Score == nil) != (tc.scores[i] == nil) || (f.Score != nil && *f.Score != *tc.scores[i])) {
					t.Fatalf("score: %s", body)
				}
			}
		})
	}
	var staleBody []byte
	deadline := time.Now().Add(2 * time.Second)
	for {
		code, h, staleBody = request(stale, "/api/inspect/points", map[string]string{"If-None-Match": updatedETag})
		if bytes.Equal(staleBody, updated) || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code != 200 || h.Get("X-Inspection-Stale") != "true" || h.Get("Cache-Control") != "no-store" || h.Get("ETag") != "" || h.Get("X-Inspection-Generated-At") == "" || !bytes.Equal(staleBody, updated) {
		t.Fatalf("stale: %d %s", code, staleBody)
	}
	// A transient cache timeout followed by a blocked fill must retry the snapshot.
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cache := redis.NewClient(opts)
	defer cache.Close()
	// Force identical snapshots to expire and rebuild, waiting for each publication.
	keys, err := cache.Keys(ctx, "gahi:"+os.Getenv("APP_ENV")+":*:points:meta").Result()
	if err != nil || len(keys) < 1 {
		t.Fatalf("metadata discovery: %v %v", keys, err)
	}
	var metaKey string
	for _, key := range keys {
		b, _ := cache.Get(ctx, key).Bytes()
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["etag"] == updatedETag {
			metaKey = key
		}
	}
	if metaKey == "" {
		t.Fatal("current metadata missing")
	}
	before, err := cache.Keys(ctx, "gahi:"+os.Getenv("APP_ENV")+":*").Result()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		b, err := cache.Get(ctx, metaKey).Bytes()
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		m["generatedAt"] = "2000-01-01T00:00:00.000000000Z"
		b, _ = json.Marshal(m)
		if err := cache.Set(ctx, metaKey, b, time.Hour).Err(); err != nil {
			t.Fatal(err)
		}
		code, _, _ = request(server, "/api/inspect/points", nil)
		if code != 200 {
			t.Fatalf("rebuild: %d", code)
		}
		deadline := time.Now().Add(2 * time.Second)
		for {
			b, _ = cache.Get(ctx, metaKey).Bytes()
			_ = json.Unmarshal(b, &m)
			if m["generatedAt"] != "2000-01-01T00:00:00.000000000Z" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("rebuild not published")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	after, err := cache.Keys(ctx, "gahi:"+os.Getenv("APP_ENV")+":*").Result()
	if err != nil || len(after) != len(before) {
		t.Fatalf("identical rebuilds grew cache: %d -> %d (%v)", len(before), len(after), err)
	}
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
	coords := map[string]any{"latitude": 33.749, "longitude": -84.388, "accuracy": 100}
	withCoords := func(fields map[string]any) map[string]any {
		result := map[string]any{}
		for k, v := range coords {
			result[k] = v
		}
		for k, v := range fields {
			result[k] = v
		}
		return result
	}
	rating := withCoords(map[string]any{"owner": owner.Id, "facility_id": "pin", "rating": 4})
	request("POST", ratings, unverifiedToken, withCoords(map[string]any{"owner": unverified.Id, "facility_id": "pin", "rating": 4}), 400)
	request("POST", ratings, otherToken, rating, 400)
	request("POST", ratings, ownerToken, withCoords(map[string]any{"owner": owner.Id, "facility_id": "does-not-exist", "rating": 4}), 400)
	for _, value := range []any{0, 6, 2.5} {
		request("POST", ratings, ownerToken, withCoords(map[string]any{"owner": owner.Id, "facility_id": "pin", "rating": value}), 400)
	}
	for _, tc := range []struct {
		fields      map[string]any
		field, code string
	}{
		{map[string]any{"owner": owner.Id, "facility_id": "pin", "rating": 4}, "latitude", "location_required"},
		{withCoords(map[string]any{"owner": owner.Id, "facility_id": "pin", "rating": 4, "accuracy": 100.01}), "accuracy", "location_inaccurate"},
		{withCoords(map[string]any{"owner": owner.Id, "facility_id": "pin", "rating": 4, "latitude": 33.7517}), "latitude", "location_too_far"},
		{withCoords(map[string]any{"owner": owner.Id, "facility_id": "missing", "rating": 4}), "latitude", "location_unmapped"},
	} {
		result := request("POST", ratings, ownerToken, tc.fields, 400)
		if result["data"].(map[string]any)[tc.field].(map[string]any)["code"] != tc.code {
			t.Fatalf("location error: %v", result)
		}
	}
	r := request("POST", ratings, ownerToken, rating, 200)
	rid := r["id"].(string)
	if r["authorName"] != "Owner" {
		t.Fatalf("author enrichment: %v", r)
	}
	request("POST", ratings, ownerToken, rating, 400)
	request("PATCH", ratings+"/"+rid, ownerToken, withCoords(map[string]any{"facility_id": "zero"}), 404)
	request("PATCH", ratings+"/"+rid, ownerToken, withCoords(map[string]any{"owner": other.Id}), 404)
	request("PATCH", ratings+"/"+rid, modToken, withCoords(map[string]any{"rating": 1}), 404)
	request("PATCH", ratings+"/"+rid, ownerToken, withCoords(map[string]any{"created": "2000-01-01 00:00:00.000Z"}), 400)
	result := request("PATCH", ratings+"/"+rid, ownerToken, map[string]any{"rating": 5}, 400)
	if result["data"].(map[string]any)["latitude"].(map[string]any)["code"] != "location_required" {
		t.Fatalf("update location: %v", result)
	}
	readback := request("GET", ratings+"/"+rid, "", nil, 200)
	if readback["rating"] != float64(4) || readback["latitude"] != nil || readback["longitude"] != nil || readback["accuracy"] != nil {
		t.Fatalf("rating readback: %v", readback)
	}
	request("PATCH", ratings+"/"+rid, ownerToken, withCoords(map[string]any{"rating": 5, "latitude": 33.74945}), 200)
	superRating := request("POST", ratings, superToken, map[string]any{"owner": other.Id, "facility_id": "missing", "rating": 3}, 200)
	request("DELETE", ratings+"/"+superRating["id"].(string), superToken, nil, 204)
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
	for _, body := range []string{" \t\n ", "\v", "\ufeff", "\u200b", "\u3164", "\u2800", "\ufe0f"} {
		request("PATCH", comments+"/"+cid, ownerToken, map[string]any{"body": body}, 400)
	}
	for _, body := range []string{"👩‍🍳", "1️⃣", "中文", "العربية", "देवनागरी", "a\u0301"} {
		request("PATCH", comments+"/"+cid, ownerToken, map[string]any{"body": body}, 200)
	}
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
	detail := request("GET", "/api/inspect/facilities/pin", "", nil, 200)
	aggregate := detail["community"].(map[string]any)
	if aggregate["ratingCount"] != float64(1) || aggregate["ratingAverage"] != float64(5) {
		t.Fatalf("aggregate: %v", aggregate)
	}
	request("PATCH", users+"/"+mod.Id, adminToken, map[string]any{"role": "user"}, 200)
	request("DELETE", ratings+"/"+rid, modToken, nil, 404)
	request("DELETE", ratings+"/"+rid, adminToken, nil, 204)
	detail = request("GET", "/api/inspect/facilities/pin", "", nil, 200)
	aggregate = detail["community"].(map[string]any)
	if aggregate["ratingCount"] != float64(0) || aggregate["ratingAverage"] != nil {
		t.Fatalf("aggregate after delete: %v", aggregate)
	}

	for _, endpoint := range []string{"request-verification", "request-password-reset"} {
		for _, status := range []int{204, 204, 429} {
			request("POST", "/api/collections/users/"+endpoint, "", map[string]any{"email": "unknown@example.test"}, status)
		}
	}

	// Count requests that pass the email gate, before PocketBase dispatches mail.
	var verificationCalls, resetCalls atomic.Int32
	pb.OnRecordRequestVerificationRequest("users").BindFunc(func(e *core.RecordRequestVerificationRequestEvent) error {
		verificationCalls.Add(1)
		return e.Next()
	})
	pb.OnRecordRequestPasswordResetRequest("users").BindFunc(func(e *core.RecordRequestPasswordResetRequestEvent) error {
		resetCalls.Add(1)
		return e.Next()
	})
	for _, endpoint := range []string{"request-verification", "request-password-reset"} {
		var wg sync.WaitGroup
		statuses := make(chan int, 12)
		for i := 0; i < 12; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				req, _ := http.NewRequest("POST", server.URL+"/api/collections/users/"+endpoint, strings.NewReader(`{"email":"signup@example.test"}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i+1))
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					statuses <- 0
					return
				}
				resp.Body.Close()
				statuses <- resp.StatusCode
			}(i)
		}
		wg.Wait()
		close(statuses)
		for status := range statuses {
			if status != 204 {
				t.Errorf("%s: got %d", endpoint, status)
			}
		}
	}
	if verificationCalls.Load() != 1 || resetCalls.Load() != 1 {
		t.Fatalf("email gate: verification=%d reset=%d", verificationCalls.Load(), resetCalls.Load())
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
