package inspection

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type store struct{ pool *pgxpool.Pool }

func newStore(logger *slog.Logger) *store {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return &store{}
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		logger.Warn("Invalid DATABASE_URL; inspection source disabled")
		return &store{}
	}
	config.MaxConns = 4
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		var super bool
		if err := c.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolsuper AND pg_has_role(session_user, r.oid, 'MEMBER'))`).Scan(&super); err != nil {
			return err
		}
		if super {
			return errors.New("superuser inspection connection rejected")
		}
		return nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		logger.Warn("Could not create inspection database pool; inspection source disabled")
		return &store{}
	}
	return &store{pool}
}

const generationSQL = `SELECT max(finished) FROM public.etl_runs WHERE status IN ('exhausted', 'caught_up')`

func generation(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (string, error) {
	var t *time.Time
	if err := q.QueryRow(ctx, generationSQL).Scan(&t); err != nil {
		return "", err
	}
	if t == nil {
		return "none", nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000000Z"), nil
}

const facilityFields = `source_id, name, address, phone, permit_type, permit_number, to_char(last_inspection_date, 'YYYY-MM-DD'), last_inspection_score, google_places`

type facility struct {
	ID                  string   `json:"id"`
	Name                *string  `json:"name"`
	Address             *string  `json:"address"`
	Phone               *string  `json:"phone"`
	PermitType          *string  `json:"permitType"`
	PermitNumber        *string  `json:"permitNumber"`
	LastInspectionDate  *string  `json:"lastInspectionDate"`
	LastInspectionScore *float64 `json:"lastInspectionScore"`
	GooglePlaces        *string  `json:"googlePlaces"`
}

func scanFacility(row interface{ Scan(...any) error }) (facility, error) {
	var f facility
	err := row.Scan(&f.ID, &f.Name, &f.Address, &f.Phone, &f.PermitType, &f.PermitNumber, &f.LastInspectionDate, &f.LastInspectionScore, &f.GooglePlaces)
	return f, err
}

func (s *store) search(ctx context.Context, query, permit string) ([]facility, error) {
	if s.pool == nil {
		return nil, errors.New("source unavailable")
	}
	query = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	rows, err := s.pool.Query(ctx, `SELECT `+facilityFields+` FROM public.facilities WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' ESCAPE E'\\' OR address ILIKE '%' || $1 || '%' ESCAPE E'\\' OR source_id ILIKE '%' || $1 || '%' ESCAPE E'\\') AND ($2 = '' OR permit_type = $2) ORDER BY name NULLS LAST, source_id LIMIT 100`, query, permit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []facility{}
	for rows.Next() {
		f, err := scanFacility(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, f)
	}
	return result, rows.Err()
}

func (s *store) lookup(ctx context.Context, ids []string) ([]facility, error) {
	if s.pool == nil {
		return nil, errors.New("source unavailable")
	}
	rows, err := s.pool.Query(ctx, `SELECT `+facilityFields+` FROM public.facilities WHERE source_id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := make(map[string]facility, len(ids))
	for rows.Next() {
		f, err := scanFacility(rows)
		if err != nil {
			return nil, err
		}
		found[f.ID] = f
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]facility, 0, len(found))
	for _, id := range ids {
		if f, ok := found[id]; ok {
			result = append(result, f)
		}
	}
	return result, nil
}

type detailResult struct {
	Facility    facility           `json:"facility"`
	Inspections []json.RawMessage  `json:"inspections"`
	Community   communityAggregate `json:"community"`
}

type communityAggregate struct {
	RatingAverage *float64 `db:"ratingAverage" json:"ratingAverage"`
	RatingCount   int      `db:"ratingCount" json:"ratingCount"`
}

func (s *store) exists(ctx context.Context, id string) (bool, error) {
	if s.pool == nil {
		return false, errors.New("source unavailable")
	}
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.facilities WHERE source_id=$1)`, id).Scan(&exists)
	return exists, err
}

func (s *store) detail(ctx context.Context, id string) (*detailResult, error) {
	if s.pool == nil {
		return nil, errors.New("source unavailable")
	}
	f, err := scanFacility(s.pool.QueryRow(ctx, `SELECT `+facilityFields+` FROM public.facilities WHERE source_id=$1`, id))
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT json_build_object('id', i.source_id::text, 'reportTemplate', i.report_template, 'inspectionDate', i.inspection_date, 'purpose', i.purpose, 'score', i.score, 'inspector', i.inspector, 'printableUrl', i.printable_url, 'violations', COALESCE((SELECT json_agg(json_build_object('sourceKey',v.source_key,'codeTitle',v.code_title,'regulation',v.regulation,'points',v.points,'corrected',v.corrected,'repeat',v.repeat,'notes',v.notes) ORDER BY v.source_key) FROM public.current_violations v WHERE v.facility_id=i.facility_id AND v.inspection_id=i.source_id), '[]'::json)) FROM public.inspections i WHERE i.facility_id=$1 ORDER BY i.inspection_date DESC NULLS LAST, i.source_id DESC LIMIT 500`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	inspections := []json.RawMessage{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		inspections = append(inspections, data)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &detailResult{Facility: f, Inspections: inspections}, nil
}
