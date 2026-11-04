package community

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

// Register installs the user role protections and public author-name enrichment.
func Register(app core.App) {
	var mu sync.Mutex
	recent := make(map[string]time.Time)
	allowEmail := func(kind, email string) bool {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		for key, at := range recent {
			if now.Sub(at) >= time.Minute {
				delete(recent, key)
			}
		}
		key := kind + ":" + strings.ToLower(strings.TrimSpace(email))
		if _, exists := recent[key]; exists || len(recent) >= 10000 {
			return false
		}
		recent[key] = now
		return true
	}
	app.OnRecordRequestVerificationRequest("users").BindFunc(func(e *core.RecordRequestVerificationRequestEvent) error {
		if !allowEmail("verify", e.Record.Email()) {
			return e.NoContent(http.StatusNoContent)
		}
		return e.Next()
	})
	app.OnRecordRequestPasswordResetRequest("users").BindFunc(func(e *core.RecordRequestPasswordResetRequestEvent) error {
		if !allowEmail("reset", e.Record.Email()) {
			return e.NoContent(http.StatusNoContent)
		}
		return e.Next()
	})
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.Record.GetString("role") == "" {
			e.Record.Set("role", "user")
		}
		return e.Next()
	})
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth != nil && e.Auth.Id != e.Record.Id {
			info, err := e.RequestInfo()
			if err != nil {
				return err
			}
			if len(info.Body) != 1 {
				return e.BadRequestError("Only role may be changed", nil)
			}
			if _, ok := info.Body["role"]; !ok {
				return e.BadRequestError("Only role may be changed", nil)
			}
		}
		return e.Next()
	})
	app.OnRecordEnrich("ratings", "comments").BindFunc(func(e *core.RecordEnrichEvent) error {
		owner, err := e.App.FindRecordById("users", e.Record.GetString("owner"))
		if err != nil {
			return err
		}
		e.Record.WithCustomData(true).Set("authorName", owner.GetString("name"))
		return e.Next()
	})
}

// RegisterFacilityValidation checks source existence before contribution writes.
func RegisterFacilityValidation(app core.App, exists func(context.Context, string) (bool, error)) {
	validate := func(e *core.RecordRequestEvent) error {
		id := e.Record.GetString("facility_id")
		if utf8.RuneCountInString(id) > 500 || strings.ContainsRune(id, '\x00') {
			return e.BadRequestError("Invalid facility id", nil)
		}
		ctx, cancel := context.WithTimeout(e.Request.Context(), 3*time.Second)
		defer cancel()
		found, err := exists(ctx, id)
		if err != nil {
			e.App.Logger().Error("Facility existence lookup failed", "error", err)
			return e.Error(http.StatusServiceUnavailable, "Inspection data unavailable", nil)
		}
		if !found {
			return e.BadRequestError("Facility not found", nil)
		}
		return e.Next()
	}
	app.OnRecordCreateRequest("ratings", "comments").BindFunc(validate)
	app.OnRecordUpdateRequest("ratings", "comments").BindFunc(func(e *core.RecordRequestEvent) error {
		if !e.HasSuperuserAuth() {
			info, err := e.RequestInfo()
			if err != nil {
				return err
			}
			field := "body"
			if e.Collection.Name == "ratings" {
				field = "rating"
			}
			for key := range info.Body {
				if key != field && key != "owner" && key != "facility_id" {
					return e.BadRequestError("Only the contribution value may be changed", nil)
				}
			}
		}
		return validate(e)
	})
}
