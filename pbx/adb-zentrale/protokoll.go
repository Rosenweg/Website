// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

// Protokoll: jede Aktion als JSON-Zeile (systemd: ins Journal). Nie Tokens oder
// Schluessel; Personen nur mit ihrem Anmeldenamen auf dem CT.
type Protokoll struct {
	mu  sync.Mutex
	aus io.Writer
}

type Eintrag struct {
	Zeit     string   `json:"zeit"`
	Aktion   string   `json:"aktion"`
	Ext      string   `json:"ext,omitempty"`
	Person   string   `json:"person,omitempty"`
	Zweck    string   `json:"zweck,omitempty"`
	Beginn   string   `json:"beginn,omitempty"`
	Ende     string   `json:"ende,omitempty"`
	BytesHin uint64   `json:"bytes_hin,omitempty"` // zum Telefon
	BytesHer uint64   `json:"bytes_her,omitempty"` // vom Telefon
	Befehle  []string `json:"befehle,omitempty"`
	Ergebnis string   `json:"ergebnis"`
	Grund    string   `json:"grund,omitempty"`
}

func (p *Protokoll) Schreiben(e Eintrag) {
	e.Zeit = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.Marshal(e)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.aus.Write(append(b, '\n'))
}
