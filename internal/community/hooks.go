package community

import (
	"context"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	validation "ganigeorgiev.com/pocketbase/ozzo-validation/v4"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

// Register installs the user role protections and public author-name enrichment.
func Register(app core.App) {
	var mu sync.Mutex
	recent := make(map[string]time.Time)
	type entry struct {
		key string
		at  time.Time
	}
	queue := make([]entry, 0, 10000)
	head := 0
	allowEmail := func(kind, email string) bool {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		for head < len(queue) && now.Sub(queue[head].at) >= time.Minute {
			delete(recent, queue[head].key)
			queue[head] = entry{}
			head++
		}
		key := kind + ":" + strings.ToLower(strings.TrimSpace(email))
		if _, exists := recent[key]; exists {
			return false
		}
		if len(recent) >= 10000 {
			delete(recent, queue[head].key)
			queue[head] = entry{}
			head++
		}
		if head >= 10000 {
			queue = append(queue[:0], queue[head:]...)
			head = 0
		}
		recent[key] = now
		queue = append(queue, entry{key, now})
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

const (
	maxLocationAccuracyMeters = 100
	maxFacilityDistanceMeters = 150
	earthRadiusMeters         = 6371000
)

func requireOnSite(body map[string]any, pin []float64) error {
	fail := func(field, code, message string) error {
		return validation.Errors{field: validation.NewError(code, message)}
	}
	if len(pin) != 2 {
		return fail("latitude", "location_unmapped", "This facility has no usable map location.")
	}
	values := make([]float64, 3)
	for i, field := range []string{"latitude", "longitude", "accuracy"} {
		v, ok := body[field].(float64)
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) || (i == 0 && math.Abs(v) > 90) || (i == 1 && math.Abs(v) > 180) || (i == 2 && v < 0) {
			return fail(field, "location_required", "A valid current location is required.")
		}
		values[i] = v
	}
	if values[2] > maxLocationAccuracyMeters {
		return fail("accuracy", "location_inaccurate", "Location is not accurate enough.")
	}
	const radians = math.Pi / 180
	dlat, dlon := (values[0]-pin[1])*radians, (values[1]-pin[0])*radians
	h := math.Pow(math.Sin(dlat/2), 2) + math.Cos(values[0]*radians)*math.Cos(pin[1]*radians)*math.Pow(math.Sin(dlon/2), 2)
	if 2*earthRadiusMeters*math.Asin(math.Sqrt(math.Min(1, h))) > maxFacilityDistanceMeters {
		return fail("latitude", "location_too_far", "You must be at the facility to rate it.")
	}
	return nil
}

// RegisterFacilityValidation checks source existence before contribution writes.
func RegisterFacilityValidation(app core.App, location func(context.Context, string) (bool, []float64, error)) {
	validate := func(e *core.RecordRequestEvent) error {
		id := e.Record.GetString("facility_id")
		if utf8.RuneCountInString(id) > 500 || strings.ContainsRune(id, '\x00') {
			return e.BadRequestError("Invalid facility id", nil)
		}
		ctx, cancel := context.WithTimeout(e.Request.Context(), 3*time.Second)
		defer cancel()
		found, pin, err := location(ctx, id)
		if err != nil {
			e.App.Logger().Error("Facility location lookup failed", "error", err)
			return e.Error(http.StatusServiceUnavailable, "Inspection data unavailable", nil)
		}
		if !found {
			return e.BadRequestError("Facility not found", nil)
		}
		if e.Collection.Name == "ratings" && !e.HasSuperuserAuth() {
			info, err := e.RequestInfo()
			if err != nil {
				return err
			}
			if err := requireOnSite(info.Body, pin); err != nil {
				return e.BadRequestError("Location validation failed", err)
			}
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
				if key != field && key != "owner" && key != "facility_id" && !(e.Collection.Name == "ratings" && (key == "latitude" || key == "longitude" || key == "accuracy")) {
					return e.BadRequestError("Only the contribution value may be changed", nil)
				}
			}
		}
		return validate(e)
	})
}
