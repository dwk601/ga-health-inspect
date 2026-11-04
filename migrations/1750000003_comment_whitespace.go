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
		return setPattern(app, `[^\s\v\p{Z}\x{0085}\x{FEFF}]`)
	}, func(app core.App) error {
		return setPattern(app, `[^\s\p{Z}\x{0085}]`)
	})
}
