package inspection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type aiConfig struct {
	base, model, key                               string
	timeout                                        time.Duration
	tokens, inputBytes, daily, userDaily, inflight int
}

func boundedEnv(name string, fallback, min, max int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}

func loadAIConfig() aiConfig {
	c := aiConfig{base: strings.TrimRight(os.Getenv("AI_BASE_URL"), "/"), model: os.Getenv("AI_MODEL"), key: os.Getenv("AI_API_KEY"), timeout: time.Duration(boundedEnv("AI_TIMEOUT_MS", 10000, 10, 60000)) * time.Millisecond, tokens: boundedEnv("AI_MAX_TOKENS", 1024, 64, 4096), inputBytes: boundedEnv("AI_MAX_INPUT_BYTES", 24000, 512, 64000), daily: boundedEnv("AI_DAILY_LIMIT", 100, 0, 100000), userDaily: boundedEnv("AI_USER_DAILY_LIMIT", 10, 0, 100000), inflight: boundedEnv("AI_MAX_INFLIGHT", 4, 1, 32)}
	u, err := url.Parse(c.base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		c.base = ""
		return c
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if (!local && (u.Scheme != "https" || c.key == "")) || (local && u.Scheme != "http" && u.Scheme != "https") {
		c.base = ""
	}
	return c
}

func (c aiConfig) enabled() bool { return c.base != "" && c.model != "" && c.userDaily > 0 }

var errProvider = errors.New("AI response unavailable")

// Only the configured operator endpoint is contacted. Never follow provider redirects.
func (c aiConfig) complete(ctx context.Context, instructions string, input []byte) ([]byte, error) {
	payload, err := json.Marshal(map[string]any{"model": c.model, "messages": []map[string]string{{"role": "system", "content": instructions}, {"role": "user", "content": string(input)}}, "max_tokens": c.tokens, "stream": false, "response_format": map[string]string{"type": "json_object"}})
	if err != nil {
		return nil, errProvider
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, errProvider
	}
	req.Header.Set("Content-Type", "application/json")
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, errProvider
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil || res.StatusCode != 200 || len(body) > 65536 {
		return nil, errProvider
	}
	var response struct {
		Choices []struct {
			Finish  string `json:"finish_reason"`
			Message struct {
				Content string          `json:"content"`
				Refusal json.RawMessage `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(body, &response) != nil || len(response.Choices) != 1 {
		return nil, errProvider
	}
	choice := response.Choices[0]
	if choice.Finish != "stop" || len(choice.Message.Refusal) > 0 && string(choice.Message.Refusal) != "null" && string(choice.Message.Refusal) != `""` || len(choice.Message.Content) > 16000 {
		return nil, errProvider
	}
	return []byte(choice.Message.Content), nil
}
