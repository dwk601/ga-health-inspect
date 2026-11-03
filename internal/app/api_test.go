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
)

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
	start := func(db, cache string) *httptest.Server {
		t.Helper()
		t.Setenv("DATABASE_URL", db)
		t.Setenv("REDIS_URL", cache)
		pb := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
		if err := pb.Bootstrap(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pb.ResetBootstrapState() })
		Register(pb)
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
		return server
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
	server := start(database, redisURL)
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
			Score       *float64  `json:"score"`
		} `json:"points"`
		PermitChoices []string `json:"permitChoices"`
		GeneratedAt   string   `json:"generatedAt"`
	}
	if err = json.Unmarshal(body, &points); err != nil {
		t.Fatal(err)
	}
	if len(points.Points) != 2 || len(points.PermitChoices) != 2 || points.Points[0].ID != "pin" || points.Points[0].Coordinates[0] != -84.388 || points.Points[0].Coordinates[1] != 33.749 || points.Points[1].Score == nil || *points.Points[1].Score != 0 {
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
	deadDB := "postgres://ga_inspect_reader:scratch-reader-only@127.0.0.1:1/health_scratch?sslmode=disable&connect_timeout=1"
	stale := start(deadDB, redisURL)
	code, h, staleBody := request(stale, "/api/inspect/points", nil)
	if code != 200 || h.Get("X-Inspection-Stale") != "true" || !bytes.Equal(staleBody, updated) {
		t.Fatalf("stale: %d %s", code, staleBody)
	}
	cold := start(deadDB, "redis://127.0.0.1:1/0")
	code, _, _ = request(cold, "/api/inspect/points", nil)
	if code != 503 {
		t.Fatalf("cold: %d", code)
	}
	down := start(database, "redis://127.0.0.1:1/0")
	code, _, _ = request(down, "/api/inspect/points", nil)
	if code != 200 {
		t.Fatalf("redis down points: %d", code)
	}
	code, _, _ = request(down, "/api/inspect/facilities/pin", nil)
	if code != 200 {
		t.Fatalf("redis down detail: %d", code)
	}
	super := start(adminURL, "")
	code, _, _ = request(super, "/api/inspect/search", nil)
	if code != 503 {
		t.Fatalf("superuser not rejected: %d", code)
	}
}
