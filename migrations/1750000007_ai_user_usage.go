package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		_, err := app.DB().NewQuery(`CREATE TABLE ai_user_usage (
			user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			day TEXT NOT NULL,
			requests INTEGER NOT NULL CHECK(requests >= 0)
		)`).Execute()
		return err
	}, func(app core.App) error {
		_, err := app.DB().NewQuery(`DROP TABLE ai_user_usage`).Execute()
		return err
	})
}
