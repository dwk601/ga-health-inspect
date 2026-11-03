package app

import (
	"fmt"
	"os"
	"strconv"

	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

func configureSettings(app core.App) error {
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
	users.VerificationTemplate.Body = `<p>Thank you for joining {APP_NAME}.</p><p><a href="{APP_URL}/verify/{TOKEN}">Verify your email</a></p><p>If you didn't register, please ignore this email.</p><p>The {APP_NAME} team</p>`
	users.ResetPasswordTemplate.Body = `<p>Reset your password for {APP_NAME}.</p><p><a href="{APP_URL}/reset-password/{TOKEN}">Reset password</a></p><p>If you didn't request this, please ignore this email.</p><p>The {APP_NAME} team</p>`
	return app.Save(users)
}
