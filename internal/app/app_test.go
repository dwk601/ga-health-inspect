package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"ganigeorgiev.com/pocketbase/pocketbase"
	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

func TestStaticRouting(t *testing.T) {
	dir := t.TempDir()
	pb := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dir})
	if err := pb.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer pb.ResetBootstrapState()
	Register(pb)
	router, err := apis.NewRouter(pb)
	if err != nil {
		t.Fatal(err)
	}
	event := &core.ServeEvent{App: pb, Router: router}
	if err := pb.OnServe().Trigger(event, func(e *core.ServeEvent) error {
		mux, err := e.Router.BuildMux()
		if err != nil {
			return err
		}
		for _, tc := range []struct {
			path   string
			status int
		}{
			{"/facilities/example", http.StatusOK},
			{"/assets/nope", http.StatusNotFound},
			{"/api/unknown", http.StatusNotFound},
		} {
			t.Run(tc.path, func(t *testing.T) {
				response := httptest.NewRecorder()
				mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))
				if response.Code != tc.status {
					t.Errorf("status = %d, want %d", response.Code, tc.status)
				}
			})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
