package app

import (
	"fmt"
	"os"
	"strconv"
	"sync"

	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

func configureSettings(app core.App) error {
	stored, err := app.Settings().Clone()
	if err != nil {
		return err
	}
	var settingsMu sync.Mutex
	app.OnSettingsUpdateRequest().BindFunc(func(e *core.SettingsUpdateRequestEvent) error {
		settingsMu.Lock()
		defer settingsMu.Unlock()
		copyManagedSettings(e.NewSettings, stored)
		err := e.Next()
		if err == nil {
			stored, err = e.NewSettings.Clone()
		}
		copyManagedSettings(e.App.Settings(), e.OldSettings)
		return err
	})
	s := app.Settings()
	s.Meta.AppName = os.Getenv("APP_NAME")
	if s.Meta.AppName == "" {
		s.Meta.AppName = "GA Health Inspect"
	}
	if v := os.Getenv("APP_URL"); v != "" {
		s.Meta.AppURL = v
	}
	if v := os.Getenv("SMTP_SENDER_ADDRESS"); v != "" {
		s.Meta.SenderAddress = v
	}
	if v := os.Getenv("SMTP_SENDER_NAME"); v != "" {
		s.Meta.SenderName = v
	}
	s.TrustedProxy.Headers = []string{"X-Forwarded-For"}
	s.TrustedProxy.UseLeftmostIP = false
	s.RateLimits.Enabled = true
	for _, label := range []string{"*:requestVerification", "*:requestPasswordReset"} {
		rules := s.RateLimits.Rules[:0]
		for _, rule := range s.RateLimits.Rules {
			if rule.Label != label {
				rules = append(rules, rule)
			}
		}
		s.RateLimits.Rules = append(rules, core.RateLimitRule{Label: label, MaxRequests: 2, Duration: 60})
	}
	if host := os.Getenv("SMTP_HOST"); host != "" {
		port := 587
		if value := os.Getenv("SMTP_PORT"); value != "" {
			var err error
			port, err = strconv.Atoi(value)
			if err != nil || port < 1 || port > 65535 {
				return fmt.Errorf("invalid SMTP_PORT")
			}
		}
		tls := false
		if value := os.Getenv("SMTP_TLS"); value != "" {
			var err error
			tls, err = strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid SMTP_TLS")
			}
		}
		s.SMTP.Enabled = true
		s.SMTP.Host = host
		s.SMTP.Port = port
		s.SMTP.TLS = tls
		s.SMTP.Username = os.Getenv("SMTP_USERNAME")
		s.SMTP.Password = os.Getenv("SMTP_PASSWORD")
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}
	verification := `<p>Thank you for joining {APP_NAME}.</p><p><a href="{APP_URL}/verify/{TOKEN}">Verify your email</a></p><p>If you didn't register, please ignore this email.</p><p>The {APP_NAME} team</p>`
	reset := `<p>Reset your password for {APP_NAME}.</p><p><a href="{APP_URL}/reset-password/{TOKEN}">Reset password</a></p><p>If you didn't request this, please ignore this email.</p><p>The {APP_NAME} team</p>`
	if users.VerificationTemplate.Body == verification && users.ResetPasswordTemplate.Body == reset {
		return nil
	}
	users.VerificationTemplate.Body = verification
	users.ResetPasswordTemplate.Body = reset
	return app.Save(users)
}

// copyManagedSettings replaces only values supplied by the environment or enforced at startup.
func copyManagedSettings(dst, src *core.Settings) {
	if os.Getenv("APP_URL") != "" {
		dst.Meta.AppURL = src.Meta.AppURL
	}
	if os.Getenv("SMTP_SENDER_ADDRESS") != "" {
		dst.Meta.SenderAddress = src.Meta.SenderAddress
	}
	if os.Getenv("SMTP_SENDER_NAME") != "" {
		dst.Meta.SenderName = src.Meta.SenderName
	}
	if os.Getenv("SMTP_HOST") != "" {
		dst.SMTP = src.SMTP
	}
	dst.RateLimits.Enabled = src.RateLimits.Enabled
	managed := func(label string) bool { return label == "*:requestVerification" || label == "*:requestPasswordReset" }
	rules := make([]core.RateLimitRule, 0, len(dst.RateLimits.Rules)+2)
	for _, rule := range dst.RateLimits.Rules {
		if !managed(rule.Label) {
			rules = append(rules, rule)
		}
	}
	for _, rule := range src.RateLimits.Rules {
		if managed(rule.Label) {
			rules = append(rules, rule)
		}
	}
	dst.RateLimits.Rules = rules
}
