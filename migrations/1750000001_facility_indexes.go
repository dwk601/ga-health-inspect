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
			index := "CREATE INDEX idx_" + name + "_facility_id ON " + name + " (facility_id)"
			found := false
			for _, existing := range c.Indexes {
				if existing == index {
					found = true
					break
				}
			}
			if !found {
				c.Indexes = append(c.Indexes, index)
				if err := app.Save(c); err != nil {
					return err
				}
			}
		}
		return nil
	}, nil)
}
