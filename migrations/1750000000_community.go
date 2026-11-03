package migrations

import (
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	m "ganigeorgiev.com/pocketbase/pocketbase/migrations"
	"ganigeorgiev.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		users.Fields.RemoveByName("avatar")
		users.OAuth2.MappedFields.AvatarURL = ""
		users.Fields.Add(&core.TextField{Name: "name", Required: true, Max: 60})
		users.Fields.Add(&core.SelectField{Name: "role", Values: []string{"user", "moderator", "admin"}, MaxSelect: 1, Required: true})
		users.CreateRule = types.Pointer(`@request.body.role:isset = false`)
		users.UpdateRule = types.Pointer(`(id = @request.auth.id && @request.body.role:changed = false) || (id != @request.auth.id && @request.auth.verified = true && @request.auth.role = 'admin')`)
		if err := app.Save(users); err != nil {
			return err
		}
		for _, name := range []string{"ratings", "comments"} {
			c := core.NewBaseCollection(name)
			c.ListRule = types.Pointer("")
			c.ViewRule = types.Pointer("")
			c.CreateRule = types.Pointer(`@request.auth.id != '' && @request.auth.verified = true && owner = @request.auth.id`)
			c.UpdateRule = types.Pointer(`@request.auth.id != '' && @request.auth.verified = true && owner = @request.auth.id && @request.body.owner:changed = false && @request.body.facility_id:changed = false`)
			c.DeleteRule = types.Pointer(`@request.auth.id != '' && @request.auth.verified = true && (owner = @request.auth.id || @request.auth.role = 'moderator' || @request.auth.role = 'admin')`)
			c.Fields.Add(&core.RelationField{Name: "owner", CollectionId: users.Id, Required: true, MaxSelect: 1, CascadeDelete: true}, &core.TextField{Name: "facility_id", Required: true, Max: 500})
			if name == "ratings" {
				min, max := float64(1), float64(5)
				c.Fields.Add(&core.NumberField{Name: "rating", Min: &min, Max: &max, OnlyInt: true, Required: true})
				c.Indexes = append(c.Indexes, "CREATE UNIQUE INDEX idx_ratings_owner_facility ON ratings (owner, facility_id)")
			} else {
				c.Fields.Add(&core.TextField{Name: "body", Required: true, Max: 2000})
			}
			c.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true}, &core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
			if err := app.Save(c); err != nil {
				return err
			}
		}
		return nil
	}, nil)
}
