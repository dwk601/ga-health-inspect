package community

import (
	"context"
	"net/http"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

// Register installs the user role protections and public author-name enrichment.
func Register(app core.App) {
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		e.Record.Set("role", "user")
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
		ctx, cancel := context.WithTimeout(e.Request.Context(), 3*time.Second)
		defer cancel()
		found, err := exists(ctx, e.Record.GetString("facility_id"))
		if err != nil {
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
