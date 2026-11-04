package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("comments")
		if err != nil {
			return err
		}
		field := collection.Fields.GetByName("body").(*core.TextField)
		field.Pattern = `[^\s\p{Z}\x{0085}]`
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("comments")
		if err != nil {
			return err
		}
		collection.Fields.GetByName("body").(*core.TextField).Pattern = ""
		return app.Save(collection)
	})
}
