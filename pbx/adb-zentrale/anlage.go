// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Anlage: die pbx-api auf CT 220. Quelle der Peers, Ziel des Verlaufs.
// Beide Richtungen mit demselben Steuer-Token (ZW_STEUER_TOKEN =
// PBX_ADB_ZENTRALE_TOKEN der pbx-api).
type Anlage struct {
	url, token string
	http       *http.Client
	log        *Protokoll
}

func NeueAnlage(k Konfig, log *Protokoll) *Anlage {
	return &Anlage{url: k.AnlageURL, token: k.SteuerToken, http: &http.Client{Timeout: 10 * time.Second}, log: log}
}

// SitzungMeldung: Beginn ("auf") und Ende ("zu") einer Sitzung fuer
// telefon_log und den Verlauf auf /smartphones.
type SitzungMeldung struct {
	Art      string   `json:"art"`
	Ext      string   `json:"ext"`
	Person   string   `json:"person"`
	Zweck    string   `json:"zweck"`
	Beginn   int64    `json:"beginn"`
	Ende     int64    `json:"ende,omitempty"`
	BytesHin uint64   `json:"bytes_hin,omitempty"`
	BytesHer uint64   `json:"bytes_her,omitempty"`
	Befehle  []string `json:"befehle,omitempty"`
	Grund    string   `json:"grund,omitempty"`
}

func (a *Anlage) anfrage(methode, pfad string, rein, raus any) error {
	if a == nil || a.url == "" {
		return fmt.Errorf("keine Anlage eingestellt")
	}
	var body *bytes.Reader
	if rein != nil {
		b, _ := json.Marshal(rein)
		body = bytes.NewReader(b)
	} else {
		body = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(methode, a.url+pfad, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Content-Type", "application/json")
	r, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("pbx-api %s: HTTP %d", pfad, r.StatusCode)
	}
	if raus != nil {
		return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(raus)
	}
	return nil
}

// Peers holt die feste Liste (nur bestaetigte, nicht ausgeschaltete Telefone).
func (a *Anlage) Peers() ([]PeerEintrag, error) {
	var d struct {
		Peers []PeerEintrag `json:"peers"`
	}
	err := a.anfrage("GET", "/api/pbx/fernwartung/peers", nil, &d)
	return d.Peers, err
}

// SitzungMelden im Hintergrund, mit einem zweiten Versuch. Scheitert es,
// steht die Sitzung trotzdem im Journal des CT.
func (a *Anlage) SitzungMelden(m SitzungMeldung) {
	if a == nil {
		return
	}
	go func() {
		for i := 0; i < 2; i++ {
			if err := a.anfrage("POST", "/api/pbx/fernwartung/sitzung", m, nil); err == nil {
				return
			} else if i == 1 {
				a.log.Schreiben(Eintrag{Aktion: "anlage", Ext: m.Ext, Ergebnis: "fehler", Grund: "Sitzung melden: " + err.Error()})
			}
			time.Sleep(5 * time.Second)
		}
	}()
}
