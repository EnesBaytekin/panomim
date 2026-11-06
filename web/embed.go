// Package web embeds the frontend assets into the binary.
package web

import "embed"

//go:embed all:static
var Static embed.FS
