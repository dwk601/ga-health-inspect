package main

import (
	"log"

	"ga-health-inspect/internal/app"
	"ganigeorgiev.com/pocketbase/pocketbase"
)

func main() {
	pb := pocketbase.New()
	app.Register(pb)
	if err := pb.Start(); err != nil {
		log.Fatal(err)
	}
}
