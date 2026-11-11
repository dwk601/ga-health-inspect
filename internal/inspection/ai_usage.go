package inspection

import (
	"errors"
	"strconv"
	"time"

	"ganigeorgiev.com/pocketbase/dbx"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

type aiUsage struct {
	Enabled   bool   `json:"enabled"`
	Limit     int    `json:"limit"`
	Used      int    `json:"used"`
	Remaining int    `json:"remaining"`
	ResetsAt  string `json:"resetsAt"`
}

func (s *service) userAIUsage(e *core.RequestEvent) (aiUsage, error) {
	var row struct {
		Today    string `db:"today"`
		Day      string `db:"day"`
		Requests int    `db:"requests"`
		ResetsAt string `db:"resetsAt"`
	}
	err := e.App.DB().NewQuery(`SELECT date('now') AS today,
		strftime('%Y-%m-%dT00:00:00Z','now','+1 day') AS resetsAt,
		coalesce(u.day,'') AS day, coalesce(u.requests,0) AS requests
		FROM (SELECT 1) LEFT JOIN ai_user_usage u ON u.user_id={:user}`).
		Bind(dbx.Params{"user": e.Auth.Id}).WithContext(e.Request.Context()).One(&row)
	if err != nil {
		return aiUsage{}, err
	}
	// Never interpret a future row as a fresh allowance or move its day backward.
	if row.Day > row.Today {
		return aiUsage{}, errors.New("AI usage day is ahead of UTC")
	}
	used := 0
	if row.Day == row.Today {
		used = row.Requests
	}
	limit := s.ai.config.userDaily
	return aiUsage{Enabled: s.ai.config.enabled(), Limit: limit, Used: used, Remaining: max(0, limit-used), ResetsAt: row.ResetsAt}, nil
}

func usageHeaders(e *core.RequestEvent, usage aiUsage) {
	h := e.Response.Header()
	h.Set("X-AI-Usage-Enabled", strconv.FormatBool(usage.Enabled))
	h.Set("X-AI-Usage-Limit", strconv.Itoa(usage.Limit))
	h.Set("X-AI-Usage-Used", strconv.Itoa(usage.Used))
	h.Set("X-AI-Usage-Remaining", strconv.Itoa(usage.Remaining))
	h.Set("X-AI-Usage-Resets-At", usage.ResetsAt)
}

func (s *service) aiUsage(e *core.RequestEvent) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	usage, err := s.userAIUsage(e)
	if err != nil {
		return aiError(e, 503, "quota_unavailable")
	}
	usageHeaders(e, usage)
	return e.JSON(200, usage)
}

// Each accepted HTTP action reserves once, including cache hits and dedup joins.
// SQLite's UTC clock and conditional upsert protect the cap across app instances.
// Provider failures/global-budget rejection may consume the action; no refunds.
func (s *service) reserveUserAI(e *core.RequestEvent) (bool, error) {
	result, err := e.App.DB().NewQuery(`INSERT INTO ai_user_usage(user_id,day,requests)
		SELECT {:user},date('now'),1 WHERE {:limit}>0
		ON CONFLICT(user_id) DO UPDATE SET day=excluded.day,
		requests=CASE WHEN ai_user_usage.day<excluded.day THEN 1 ELSE ai_user_usage.requests+1 END
		WHERE ai_user_usage.day<excluded.day OR
		(ai_user_usage.day=excluded.day AND ai_user_usage.requests<{:limit})`).
		Bind(dbx.Params{"user": e.Auth.Id, "limit": s.ai.config.userDaily}).WithContext(e.Request.Context()).Execute()
	if err != nil {
		return false, aiError(e, 503, "quota_unavailable")
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, aiError(e, 503, "quota_unavailable")
	}
	usage, err := s.userAIUsage(e)
	if err != nil {
		return false, aiError(e, 503, "quota_unavailable")
	}
	usageHeaders(e, usage)
	if count == 0 {
		reset, _ := time.Parse(time.RFC3339, usage.ResetsAt)
		e.Response.Header().Set("Retry-After", strconv.Itoa(max(1, int(time.Until(reset).Seconds())+1)))
		return false, aiError(e, 429, "user_daily_limit")
	}
	return true, nil
}
