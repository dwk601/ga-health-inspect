package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		for _, name := range []string{"ratings", "comments"} {
			c, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				return err
			}
			c.Indexes = append(c.Indexes, "CREATE INDEX IF NOT EXISTS idx_"+name+"_facility_id ON "+name+" (facility_id)")
			if err := app.Save(c); err != nil {
				return err
			}
		}
		return nil
	}, nil)
}
