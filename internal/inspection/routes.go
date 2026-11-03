package inspection

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"ga-health-inspect/internal/community"
	"ga-health-inspect/internal/httpencoding"
	"ganigeorgiev.com/pocketbase/dbx"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"github.com/jackc/pgx/v5"
)

type service struct {
	store *store
	cache *pointsCache
}

// Register adds read-only inspection routes without requiring either external service at startup.
func Register(e *core.ServeEvent) {
	s := &service{store: newStore(e.App.Logger()), cache: newCache(e.App.Logger())}
	community.RegisterFacilityValidation(e.App, s.store.exists)
	e.App.OnTerminate().BindFunc(func(event *core.TerminateEvent) error {
		if s.store.pool != nil {
			s.store.pool.Close()
		}
		if s.cache.client != nil {
			_ = s.cache.client.Close()
		}
		return event.Next()
	})
	e.Router.GET("/api/inspect/points", s.points)
	e.Router.GET("/api/inspect/search", s.search)
	e.Router.GET("/api/inspect/facilities/{id}", s.detail)
}
func requestContext(e *core.RequestEvent) (context.Context, context.CancelFunc) {
	return context.WithTimeout(e.Request.Context(), 3*time.Second)
}
func (s *service) search(e *core.RequestEvent) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	query := strings.TrimSpace(e.Request.URL.Query().Get("q"))
	permit := strings.TrimSpace(e.Request.URL.Query().Get("permit"))
	if len(query) > 200 || len(permit) > 200 || !validText(query) || !validText(permit) {
		return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid query"})
	}
	ctx, cancel := requestContext(e)
	defer cancel()
	items, err := s.store.search(ctx, query, permit)
	if err != nil {
		return unavailable(e, err)
	}
	return e.JSON(http.StatusOK, map[string]any{"facilities": items})
}
func (s *service) detail(e *core.RequestEvent) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	id := e.Request.PathValue("id")
	if len(id) > 500 || !validText(id) {
		return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid id"})
	}
	ctx, cancel := requestContext(e)
	defer cancel()
	result, err := s.store.detail(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return e.JSON(http.StatusNotFound, map[string]string{"error": "facility not found"})
	}
	if err != nil {
		return unavailable(e, err)
	}
	err = e.App.DB().NewQuery(`SELECT avg(rating) AS ratingAverage, count(*) AS ratingCount FROM ratings WHERE facility_id = {:id}`).Bind(dbx.Params{"id": id}).One(&result.Community)
	if err != nil {
		return e.InternalServerError("Community data unavailable", err)
	}
	return e.JSON(http.StatusOK, result)
}
func validText(s string) bool { return utf8.ValidString(s) && !strings.ContainsRune(s, 0) }
func unavailable(e *core.RequestEvent, err error) error {
	if e.Request.Context().Err() != nil {
		return nil
	}
	e.App.Logger().Warn("Inspection data unavailable", "error", err)
	return e.JSON(http.StatusServiceUnavailable, map[string]string{"error": "inspection data unavailable"})
}
func matches(header, tag string) bool {
	for _, v := range strings.Split(header, ",") {
		v = strings.TrimSpace(v)
		if v == "*" || strings.TrimPrefix(v, "W/") == strings.TrimPrefix(tag, "W/") {
			return true
		}
	}
	return false
}
func servePoints(e *core.RequestEvent, m metadata, blob []byte, stale bool) error {
	h := e.Response.Header()
	h.Set("Vary", "Accept-Encoding")
	if stale {
		h.Set("Cache-Control", "no-store")
		h.Set("Warning", `110 - "Response is stale"`)
		h.Set("X-Inspection-Stale", "true")
	} else {
		h.Set("Cache-Control", "public, max-age=0, must-revalidate")
		h.Set("ETag", m.ETag)
		if matches(e.Request.Header.Get("If-None-Match"), m.ETag) {
			return e.NoContent(http.StatusNotModified)
		}
	}
	if httpencoding.AcceptsGzip(e.Request.Header.Get("Accept-Encoding")) {
		h.Set("Content-Encoding", "gzip")
	} else {
		var err error
		blob, err = unzip(blob)
		if err != nil {
			return unavailable(e, err)
		}
	}
	h.Set("Content-Type", "application/json")
	e.Response.WriteHeader(http.StatusOK)
	_, err := e.Response.Write(blob)
	return err
}
func (s *service) cached(e *core.RequestEvent, ctx context.Context, r *cacheRequest, key string, stale bool) (bool, error) {
	m, err := r.meta(ctx, key)
	if err != nil {
		return false, nil
	}
	if !stale {
		t, err := time.Parse(time.RFC3339Nano, m.GeneratedAt)
		if err != nil || time.Since(t) >= time.Hour {
			return false, nil
		}
	}
	if !stale && matches(e.Request.Header.Get("If-None-Match"), m.ETag) {
		return true, servePoints(e, m, nil, stale)
	}
	blob, err := r.get(ctx, m.Blob, time.Second)
	if err != nil {
		return false, nil
	}
	return true, servePoints(e, m, blob, stale)
}
func (s *service) points(e *core.RequestEvent) error {
	ctx, cancel := context.WithTimeout(e.Request.Context(), 7*time.Second)
	defer cancel()
	r := &cacheRequest{cache: s.cache}
	var gen string
	var err error
	if s.store.pool == nil {
		err = errors.New("source unavailable")
	} else {
		queryCtx, queryCancel := context.WithTimeout(ctx, 3*time.Second)
		gen, err = generation(queryCtx, s.store.pool)
		queryCancel()
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		e.App.Logger().Warn("Inspection source failed", "error", err)
		if ok, err := s.cached(e, ctx, r, s.cache.prefix+"points:last-good", true); ok {
			return err
		}
		return unavailable(e, err)
	}
	if ok, err := s.cached(e, ctx, r, s.cache.metaKey(gen), false); ok {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	m, blob, err := s.cache.fill(ctx, s.store, gen, r.failed)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		e.App.Logger().Warn("Inspection fill failed", "error", err)
		// Retry the last-good cache after a failed fill, even if the initial read timed out.
		retry := &cacheRequest{cache: s.cache}
		if ok, err := s.cached(e, ctx, retry, s.cache.prefix+"points:last-good", true); ok {
			return err
		}
		return unavailable(e, err)
	}
	return servePoints(e, m, blob, false)
}
