package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
)

func init() {
	setPattern := func(app core.App, pattern string) error {
		collection, err := app.FindCollectionByNameOrId("comments")
		if err != nil {
			return err
		}
		collection.Fields.GetByName("body").(*core.TextField).Pattern = pattern
		return app.Save(collection)
	}
	m.Register(func(app core.App) error {
		return setPattern(app, `[^\s\p{Z}\p{C}\x{034F}\x{115F}\x{1160}\x{17B4}\x{17B5}\x{180B}-\x{180F}\x{2800}\x{3164}\x{FE00}-\x{FE0F}\x{FFA0}\x{E0100}-\x{E01EF}]`)
	},
		func(app core.App) error { return setPattern(app, `[\p{L}\p{M}\p{N}\p{P}\p{S}]`) })
}
