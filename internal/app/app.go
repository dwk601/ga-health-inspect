package app

import (
	"path"
	"strings"

	"ga-health-inspect/web"
	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

// Register installs the embedded application without shadowing PocketBase APIs.
func Register(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.BindFunc(func(e *core.RequestEvent) error {
			e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://unpkg.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; font-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
			return e.Next()
		})
		assets := web.Assets()
		static := apis.Static(assets, false)
		spa := apis.Static(assets, true)
		e.Router.GET("/{path...}", func(r *core.RequestEvent) error {
			p := r.Request.URL.Path
			if p == "/api" || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/assets/") || path.Ext(p) != "" {
				return static(r)
			}
			return spa(r)
		})
		return e.Next()
	})
}
