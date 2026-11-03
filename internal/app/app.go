package app

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"ga-health-inspect/internal/community"
	"ga-health-inspect/internal/httpencoding"
	"ga-health-inspect/internal/inspection"
	_ "ga-health-inspect/migrations"
	"ga-health-inspect/web"
	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

// Register installs the embedded application without shadowing PocketBase APIs.
func Register(app core.App) {
	community.Register(app)
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		if err := configureSettings(e.App); err != nil {
			return err
		}
		e.InstallerFunc = nil
		e.Router.BindFunc(func(e *core.RequestEvent) error {
			e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://unpkg.com; worker-src 'self' blob: https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; font-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
			return e.Next()
		})
		inspection.Register(e)
		assets := web.Assets()
		type asset struct {
			blob        []byte
			contentType string
		}
		compressed := make(map[string]asset)
		if err := fs.WalkDir(assets, "assets", func(name string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			data, err := fs.ReadFile(assets, name)
			if err != nil {
				return err
			}
			var buf bytes.Buffer
			writer := gzip.NewWriter(&buf)
			if _, err = writer.Write(data); err != nil {
				return err
			}
			if err = writer.Close(); err != nil {
				return err
			}
			contentType := mime.TypeByExtension(path.Ext(name))
			if path.Ext(name) == ".ttf" {
				contentType = "font/ttf"
			}
			if contentType == "" {
				contentType = http.DetectContentType(data)
			}
			compressed["/"+name] = asset{buf.Bytes(), contentType}
			return nil
		}); err != nil {
			return err
		}
		static := apis.Static(assets, false)
		spa := apis.Static(assets, true)
		e.Router.GET("/{path...}", func(r *core.RequestEvent) error {
			p := r.Request.URL.Path
			if asset, ok := compressed[p]; ok {
				r.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				r.Response.Header().Add("Vary", "Accept-Encoding")
				if httpencoding.AcceptsGzip(r.Request.Header.Get("Accept-Encoding")) {
					r.Set("__skipSuccessActivityLogger", true)
					r.Response.Header().Set("Content-Encoding", "gzip")
					r.Response.Header().Set("Content-Type", asset.contentType)
					r.Response.Header().Set("Content-Length", fmt.Sprint(len(asset.blob)))
					http.ServeContent(r.Response, r.Request, path.Base(p), time.Time{}, bytes.NewReader(asset.blob))
					return nil
				}
				return static(r)
			}
			if p == "/index.html" {
				r.Response.Header().Set("Cache-Control", "no-cache")
			}
			if p == "/api" || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/assets/") || path.Ext(p) != "" {
				return static(r)
			}
			r.Response.Header().Set("Cache-Control", "no-cache")
			return spa(r)
		})
		return e.Next()
	})
}
