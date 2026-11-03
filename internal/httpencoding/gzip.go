package httpencoding

import (
	"strconv"
	"strings"
)

// AcceptsGzip reports whether the request permits gzip encoding.
func AcceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		if strings.TrimSpace(fields[0]) != "gzip" {
			continue
		}
		for _, field := range fields[1:] {
			field = strings.TrimSpace(field)
			if strings.HasPrefix(field, "q=") {
				q, err := strconv.ParseFloat(strings.TrimPrefix(field, "q="), 64)
				if err != nil || q <= 0 {
					return false
				}
			}
		}
		return true
	}
	return false
}
