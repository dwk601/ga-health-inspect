package inspection

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	PlaceName           *string  `json:"placeName"`
}

func scanFacility(row interface{ Scan(...any) error }) (facility, error) {
	var f facility
	err := row.Scan(&f.ID, &f.Name, &f.Address, &f.Phone, &f.PermitType, &f.PermitNumber, &f.LastInspectionDate, &f.LastInspectionScore, &f.GooglePlaces)
	f.PlaceName = placeName(f.GooglePlaces)
	return f, err
}

var coordinateName = regexp.MustCompile(`(?i)^[\d\s.,°'′"″+\-NSEW]*\d[\d\s.,°'′"″+\-NSEW]*$`)

// The place segment is the first path segment after /maps/place/, matching the SQL split_part convention below.
func placeName(raw *string) *string {
	if raw == nil {
		return nil
	}
	_, tail, ok := strings.Cut(*raw, "/maps/place/")
	if !ok {
		return nil
	}
	segment, _, _ := strings.Cut(tail, "/")
	name, err := url.QueryUnescape(segment)
	if err != nil || !utf8.ValidString(name) || coordinateName.MatchString(name) || !strings.ContainsFunc(name, unicode.IsLetter) {
		return nil
	}
	return &name
}

func (s *store) search(ctx context.Context, query, permit, sort string) ([]facility, error) {
	if s.pool == nil {
		return nil, errors.New("source unavailable")
	}
	normalized := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.ToLower(query))
	query = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	order := ""
	if sort == "score-asc" {
		order = "last_inspection_score ASC NULLS LAST, "
	} else if sort == "score-desc" {
		order = "last_inspection_score DESC NULLS LAST, "
	}
	nameNorm := `regexp_replace(lower(coalesce(name,'')), '[^a-z0-9]+', '', 'g')`
	placeNorm := `regexp_replace(lower(split_part(split_part(coalesce(google_places,''), '/maps/place/', 2), '/', 1)), '(%[0-9a-f]{2}|[^a-z0-9%])+', '', 'g')`
	// Dropped-pin coordinate labels are not place names (see coordinateName), so they are not searchable.
	searchPlace := `regexp_replace(` + placeNorm + `, '^[nsew]*[0-9][0-9nsew]*$', '')`
	rows, err := s.pool.Query(ctx, `SELECT `+facilityFields+` FROM public.facilities WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' ESCAPE E'\\' OR address ILIKE '%' || $1 || '%' ESCAPE E'\\' OR source_id ILIKE '%' || $1 || '%' ESCAPE E'\\' OR ($3 <> '' AND (strpos(`+nameNorm+`, $3) > 0 OR strpos(`+searchPlace+`, $3) > 0))) AND ($2 = '' OR permit_type = $2) ORDER BY `+order+`CASE WHEN $3 = '' THEN 2 WHEN strpos(`+nameNorm+`, $3) = 1 OR strpos(`+searchPlace+`, $3) = 1 THEN 0 WHEN strpos(`+nameNorm+`, $3) > 0 OR strpos(`+searchPlace+`, $3) > 0 THEN 1 ELSE 2 END, name NULLS LAST, source_id LIMIT 100`, query, permit, normalized)
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

func (s *store) location(ctx context.Context, id string) (bool, []float64, error) {
	if s.pool == nil {
		return false, nil, errors.New("source unavailable")
	}
	var placeURL *string
	err := s.pool.QueryRow(ctx, `SELECT google_places FROM public.facilities WHERE source_id=$1`, id).Scan(&placeURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	return err == nil, coordinates(placeURL), err
}

// Findings completeness is independent of printable-report enrichment and ETL generation.
const inspectionsSQL = `SELECT data FROM (
 SELECT i.inspection_date AS day, i.source_id::text AS sort_id, json_build_object('id', i.source_id::text, 'inspectionDate', i.inspection_date, 'purpose', i.purpose, 'score', i.score, 'grade', NULLIF(i.report_fields->>'grade', ''), 'timeIn', NULLIF(i.report_fields->>'time_in', ''), 'timeOut', NULLIF(i.report_fields->>'time_out', ''), 'comments', NULL, 'inspector', i.inspector, 'printableUrl', i.printable_url,
  'recordFingerprint', md5(to_jsonb(i)::text),
  'evidence', json_build_object('source', 'state', 'findingsStatus', CASE WHEN jsonb_typeof(i.raw->'violations') = 'object' THEN CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(i.raw->'violations') r WHERE NOT EXISTS (SELECT 1 FROM public.current_violations v WHERE v.facility_id=i.facility_id AND v.inspection_id=i.source_id AND v.source_key=r.key AND v.raw=r.value)) AND (SELECT count(*) FROM public.current_violations v WHERE v.facility_id=i.facility_id AND v.inspection_id=i.source_id) = (SELECT count(*) FROM jsonb_object_keys(i.raw->'violations')) THEN 'available' ELSE 'incomplete' END ELSE 'unavailable' END, 'findingsAttemptedAt', NULL, 'reportStatus', CASE WHEN i.report_error IS NOT NULL THEN CASE WHEN i.report_fields IS NOT NULL THEN 'refresh_failed' ELSE 'failed' END WHEN i.report_fields IS NOT NULL THEN 'available' WHEN i.report_fetched_at IS NOT NULL THEN 'failed' ELSE 'not_fetched' END, 'reportAttemptedAt', i.report_fetched_at),
  'violations', COALESCE((SELECT json_agg(json_build_object('sourceKey',v.source_key,'codeTitle',v.code_title,'regulation',v.regulation,'points',v.points,'corrected',v.corrected,'repeat',v.repeat,'notes',v.notes) ORDER BY v.source_key) FROM public.current_violations v WHERE v.facility_id=i.facility_id AND v.inspection_id=i.source_id), '[]'::json)) AS data
 FROM public.inspections i WHERE i.facility_id=$1
 UNION ALL
 SELECT g.inspection_date, g.source_id, json_build_object('id', g.source_id, 'inspectionDate', g.inspection_date, 'purpose', concat_ws(' · ', g.purpose, g.inspection_type), 'score', g.score, 'grade', g.grade, 'timeIn', g.time_in::text, 'timeOut', NULL, 'comments', NULLIF(btrim(g.comments), ''), 'inspector', NULL, 'printableUrl', 'https://inspections.myhealthdepartment.com/gwinnett-ga/inspection/?inspectionID=' || g.source_id,
  'recordFingerprint', md5(to_jsonb(g)::text),
  'evidence', json_build_object('source', 'gnr', 'findingsStatus', CASE WHEN g.detail_fetched_at IS NULL THEN CASE WHEN g.observations IS NOT NULL THEN 'pending_refresh' ELSE 'not_fetched' END WHEN g.detail_error IS NOT NULL THEN CASE WHEN g.observations IS NOT NULL THEN 'refresh_failed' ELSE 'failed' END WHEN jsonb_typeof(g.observations) = 'array' THEN 'available' ELSE 'unavailable' END, 'findingsAttemptedAt', g.detail_fetched_at, 'reportStatus', 'external', 'reportAttemptedAt', NULL),
  'violations', COALESCE((SELECT json_agg(json_build_object('sourceKey',o.n::text,'codeTitle',substring(o.text from '^([0-9A-Za-z-]+):'),'regulation',NULL,'points',NULL,'corrected',NULL,'repeat',NULL,'notes',NULLIF(btrim(regexp_replace(o.text, '^[0-9A-Za-z-]+:', '')), '')) ORDER BY o.n) FROM jsonb_array_elements_text(g.observations) WITH ORDINALITY o(text, n)), '[]'::json))
 FROM public.gnr_inspections g WHERE g.facility_id=$1
) history ORDER BY day DESC NULLS LAST, lpad(sort_id, 40, '0') DESC LIMIT 500`

func (s *store) detail(ctx context.Context, id string) (*detailResult, error) {
	if s.pool == nil {
		return nil, errors.New("source unavailable")
	}
	f, err := scanFacility(s.pool.QueryRow(ctx, `SELECT `+facilityFields+` FROM public.facilities WHERE source_id=$1`, id))
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, inspectionsSQL, id)
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
		var record map[string]json.RawMessage
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, err
		}
		hash := fmt.Sprintf("%x", sha256.Sum256(data))
		delete(record, "recordFingerprint")
		record["contentHash"], _ = json.Marshal(hash)
		data, err = json.Marshal(record)
		if err != nil {
			return nil, err
		}
		inspections = append(inspections, data)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &detailResult{Facility: f, Inspections: inspections}, nil
}
