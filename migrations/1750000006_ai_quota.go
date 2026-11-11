package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		_, err := app.DB().NewQuery(`CREATE TABLE ai_daily_quota (day TEXT PRIMARY KEY, requests INTEGER NOT NULL CHECK(requests >= 0))`).Execute()
		return err
	}, func(app core.App) error {
		_, err := app.DB().NewQuery(`DROP TABLE ai_daily_quota`).Execute()
		return err
	})
}
