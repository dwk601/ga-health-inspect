package inspection

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

type metadata struct {
	Generation  string `json:"generation"`
	GeneratedAt string `json:"generatedAt"`
	ETag        string `json:"etag"`
	Blob        string `json:"blob"`
}
type pointsCache struct {
	client  *redis.Client
	prefix  string
	mu      sync.Mutex
	filling map[string]*pointFill
	logger  *slog.Logger
}

type pointFill struct {
	done chan struct{}
	meta metadata
	blob []byte
	err  error
}

func (c *pointsCache) fill(ctx context.Context, s *store, generation string, cacheFailed bool) (metadata, []byte, error) {
	c.mu.Lock()
	pending := c.filling[generation]
	if pending == nil {
		pending = &pointFill{done: make(chan struct{})}
		if c.filling == nil {
			c.filling = make(map[string]*pointFill)
		}
		c.filling[generation] = pending
		go func() {
			fillCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			pending.meta, pending.blob, pending.err = s.fill(fillCtx)
			if pending.err == nil {
				(&cacheRequest{cache: c, silent: cacheFailed}).publish(fillCtx, pending.meta, pending.blob)
			}
			c.mu.Lock()
			delete(c.filling, generation)
			close(pending.done)
			c.mu.Unlock()
		}()
	}
	c.mu.Unlock()
	select {
	case <-pending.done:
		return pending.meta, pending.blob, pending.err
	case <-ctx.Done():
		return metadata{}, nil, ctx.Err()
	}
}

func newCache(logger *slog.Logger) *pointsCache {
	environment := os.Getenv("APP_ENV")
	if environment == "" {
		environment = "default"
	}
	c := &pointsCache{prefix: "gahi:" + environment + ":v2:", logger: logger}
	url := os.Getenv("REDIS_URL")
	if url == "" {
		return c
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		logger.Warn("Invalid REDIS_URL; inspection cache disabled")
		return c
	}
	opts.DialTimeout = 100 * time.Millisecond
	opts.ReadTimeout = time.Second
	opts.WriteTimeout = 100 * time.Millisecond
	opts.PoolTimeout = 100 * time.Millisecond
	opts.DialerRetries = 1
	opts.MaxRetries = -1
	opts.ContextTimeoutEnabled = true
	c.client = redis.NewClient(opts)
	return c
}

type cacheRequest struct {
	cache  *pointsCache
	failed bool
	silent bool
}

func (r *cacheRequest) get(ctx context.Context, key string, timeout time.Duration) ([]byte, error) {
	if r.failed || r.cache.client == nil {
		return nil, errors.New("cache unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	v, err := r.cache.client.Get(ctx, key).Bytes()
	if err != nil && err != redis.Nil {
		r.fail()
	}
	return v, err
}
func (r *cacheRequest) fail() {
	if !r.failed {
		if !r.silent {
			r.cache.logger.Warn("Inspection cache operation failed")
		}
		r.failed = true
	}
}
func (r *cacheRequest) meta(ctx context.Context, key string) (metadata, error) {
	var m metadata
	b, err := r.get(ctx, key, 100*time.Millisecond)
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(b, &m)
	if err == nil && (m.Blob == "" || m.ETag == "" || m.GeneratedAt == "") {
		err = errors.New("invalid metadata")
	}
	return m, err
}
func (c *pointsCache) metaKey(gen string) string { return c.prefix + "etl:" + gen + ":points:meta" }

var pinPattern = regexp.MustCompile(`!3d(-?(?:[0-9]+(?:\.[0-9]+)?))!4d(-?(?:[0-9]+(?:\.[0-9]+)?))(?:[!/?&#]|$)`)

func coordinates(url *string) []float64 {
	if url == nil {
		return nil
	}
	m := pinPattern.FindStringSubmatch(*url)
	if m == nil {
		return nil
	}
	lat, e1 := strconv.ParseFloat(m[1], 64)
	lon, e2 := strconv.ParseFloat(m[2], 64)
	if e1 != nil || e2 != nil || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
		return nil
	}
	return []float64{lon, lat}
}

type point struct {
	ID          string    `json:"id"`
	PermitType  *string   `json:"permitType"`
	Coordinates []float64 `json:"coordinates"`
}
type snapshot struct {
	Generation    string   `json:"generation"`
	GeneratedAt   string   `json:"generatedAt"`
	Points        []point  `json:"points"`
	PermitChoices []string `json:"permitChoices"`
}

func (s *store) fill(ctx context.Context) (metadata, []byte, error) {
	if s.pool == nil {
		return metadata{}, nil, errors.New("source unavailable")
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return metadata{}, nil, err
	}
	defer tx.Rollback(context.Background())
	gen, err := generation(ctx, tx)
	if err != nil {
		return metadata{}, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT source_id,permit_type,google_places FROM public.facilities ORDER BY source_id`)
	if err != nil {
		return metadata{}, nil, err
	}
	snap := snapshot{Generation: gen, GeneratedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"), Points: []point{}, PermitChoices: []string{}}
	permits := map[string]bool{}
	for rows.Next() {
		var p point
		var url *string
		if err = rows.Scan(&p.ID, &p.PermitType, &url); err != nil {
			break
		}
		if p.PermitType != nil && *p.PermitType != "" {
			permits[*p.PermitType] = true
		}
		p.Coordinates = coordinates(url)
		if p.Coordinates != nil {
			snap.Points = append(snap.Points, p)
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return metadata{}, nil, err
	}
	for permit := range permits {
		snap.PermitChoices = append(snap.PermitChoices, permit)
	}
	sort.Strings(snap.PermitChoices)
	if err = tx.Commit(ctx); err != nil {
		return metadata{}, nil, err
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return metadata{}, nil, err
	}
	stable, err := json.Marshal(struct {
		Generation    string   `json:"generation"`
		Points        []point  `json:"points"`
		PermitChoices []string `json:"permitChoices"`
	}{snap.Generation, snap.Points, snap.PermitChoices})
	if err != nil {
		return metadata{}, nil, err
	}
	sum := sha256.Sum256(stable)
	digest := hex.EncodeToString(sum[:])
	blobSum := sha256.Sum256(data)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err = zw.Write(data); err != nil {
		return metadata{}, nil, err
	}
	if err = zw.Close(); err != nil {
		return metadata{}, nil, err
	}
	return metadata{Generation: gen, GeneratedAt: snap.GeneratedAt, ETag: `W/"` + digest + `"`, Blob: hex.EncodeToString(blobSum[:])}, buf.Bytes(), nil
}

// Publication checks both the generation and timestamp in a single Redis operation.
const publishScript = `
local incoming=cjson.decode(ARGV[1])
for _,key in ipairs(KEYS) do
 local value=redis.call('GET', key)
 if value then
  local ok, old=pcall(cjson.decode, value)
  if ok and old.generation and old.generatedAt then
   if (old.generation ~= 'none' and incoming.generation == 'none') or (old.generation ~= 'none' and incoming.generation ~= 'none' and old.generation > incoming.generation) or (old.generation == incoming.generation and old.generatedAt >= incoming.generatedAt) then return 0 end
  end
 end
end
for _,key in ipairs(KEYS) do redis.call('SET',key,ARGV[1],'EX',86400) end
return 1`

func (r *cacheRequest) publish(ctx context.Context, m metadata, blob []byte) {
	if r.failed || r.cache.client == nil {
		return
	}
	m.Blob = r.cache.prefix + "etl:" + m.Generation + ":points:blob:" + m.Blob
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := r.cache.client.Set(ctx, m.Blob, blob, 24*time.Hour).Err(); err != nil {
		r.fail()
		return
	}
	data, _ := json.Marshal(m)
	metaCtx, metaCancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer metaCancel()
	if err := r.cache.client.Eval(metaCtx, publishScript, []string{r.cache.metaKey(m.Generation), r.cache.prefix + "points:last-good"}, data).Err(); err != nil {
		r.fail()
	}
}
func unzip(blob []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}
