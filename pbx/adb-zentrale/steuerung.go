// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"crypto/md5" //nolint:gosec // so zeigt Android den Fingerabdruck
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
)

// Steuerung auf ZW_STEUER_BIND (LAN, nftables: nur CT 220 und lokal).
//
//	Authorization: Bearer <ZW_STEUER_TOKEN>  pbx-api: alles
//	Authorization: Bearer <ZW_LOKAL_TOKEN>   rw-adb im CT: Sitzungen, Zustand
//
//	GET    /gesundheit               Schluessel, Fingerabdruck, Endpunkte
//	GET    /zustand                  je Peer Handshake, Bytes, Sitzung
//	PUT    /peers   {peers:[…]}      ganze Liste ersetzen (pbx-api)
//	DELETE /peers/{ext}              Not-Aus (pbx-api)
//	POST   /sitzungen {ext, person, zweck}  -> {port}
//	POST   /sitzungen/{ext}/befehl {person, befehl}
//	DELETE /sitzungen/{ext}?person=  Sitzung beenden

type recht int

const (
	keins recht = iota
	lokal
	steuer
)

var (
	personRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`)
	zwecke   = map[string]bool{"shell": true, "updater": true, "einrichten": true, "bildschirm": true, "logcat": true, "befehl": true}
)

func (z *Zentrale) recht(r *http.Request) recht {
	t := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	switch {
	case subtle.ConstantTimeCompare([]byte(t), []byte(z.k.SteuerToken)) == 1:
		return steuer
	case subtle.ConstantTimeCompare([]byte(t), []byte(z.k.LokalToken)) == 1:
		return lokal
	}
	return keins
}

func json200(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// AdbFingerabdruck des Schluessels von adbz, wie "USB-Debugging zulassen?" ihn zeigt.
func AdbFingerabdruck(pfad string) string {
	b, err := os.ReadFile(pfad)
	if err != nil {
		return ""
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return ""
	}
	roh, err := base64.StdEncoding.DecodeString(f[0])
	if err != nil {
		return ""
	}
	sum := md5.Sum(roh) //nolint:gosec
	teile := make([]string, len(sum))
	for i, x := range sum {
		teile[i] = fmt.Sprintf("%02X", x)
	}
	return strings.Join(teile, ":")
}

func (z *Zentrale) Steuerung() http.Handler {
	m := http.NewServeMux()
	mit := func(min recht, f http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if z.recht(r) < min {
				json200(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
				return
			}
			f(w, r)
		}
	}
	m.HandleFunc("GET /gesundheit", mit(lokal, func(w http.ResponseWriter, r *http.Request) {
		json200(w, 200, map[string]any{
			"ok": true, "peers": z.Anzahl(), "public_key": z.PublicB64(),
			"adb_fingerabdruck": AdbFingerabdruck(z.k.AdbPub),
			"gateway":           z.eigen.String(), "netz": z.k.Netz.String(),
			"endpoint_extern": z.k.EndpointExtern, "endpoint_intern": z.k.EndpointIntern,
		})
	}))
	m.HandleFunc("GET /zustand", mit(lokal, func(w http.ResponseWriter, r *http.Request) {
		json200(w, 200, map[string]any{"peers": z.Zustand()})
	}))
	m.HandleFunc("PUT /peers", mit(steuer, func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Peers []PeerEintrag `json:"peers"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b) != nil {
			json200(w, 400, map[string]string{"error": "JSON erwartet"})
			return
		}
		if err := z.PeersSetzen(b.Peers, "pbx-api"); err != nil {
			json200(w, 400, map[string]string{"error": err.Error()})
			return
		}
		json200(w, 200, map[string]int{"peers": z.Anzahl()})
	}))
	m.HandleFunc("DELETE /peers/{ext}", mit(steuer, func(w http.ResponseWriter, r *http.Request) {
		ext := r.PathValue("ext")
		if !extRE.MatchString(ext) {
			json200(w, 400, map[string]string{"error": "Nebenstelle ungueltig"})
			return
		}
		durch := r.URL.Query().Get("durch")
		if len(durch) > 120 {
			durch = durch[:120]
		}
		json200(w, 200, map[string]bool{"entfernt": z.NotAus(ext, durch)})
	}))
	m.HandleFunc("POST /sitzungen", mit(lokal, func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Ext, Person, Zweck string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil || !extRE.MatchString(b.Ext) ||
			!personRE.MatchString(b.Person) || !zwecke[b.Zweck] {
			json200(w, 400, map[string]string{"error": "ext, person, zweck (shell|updater|einrichten|bildschirm|logcat|befehl)"})
			return
		}
		// Der Updater-Zweck gehoert der pbx-api, nicht einer Person auf dem CT.
		if b.Zweck == "updater" && z.recht(r) != steuer {
			json200(w, 403, map[string]string{"error": "updater nur ueber die pbx-api"})
			return
		}
		s, err := z.SitzungOeffnen(b.Ext, b.Person, b.Zweck)
		switch {
		case errors.Is(err, ErrUnbekannt):
			json200(w, 404, map[string]string{"error": err.Error()})
		case errors.Is(err, ErrBelegt):
			json200(w, 409, map[string]string{"error": err.Error()})
		case err != nil:
			json200(w, 500, map[string]string{"error": err.Error()})
		default:
			json200(w, 200, map[string]any{"port": s.Port, "sitzung": s.json()})
		}
	}))
	m.HandleFunc("POST /sitzungen/{ext}/befehl", mit(lokal, func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Person, Befehl string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&b) != nil || b.Befehl == "" {
			json200(w, 400, map[string]string{"error": "person, befehl"})
			return
		}
		if err := z.Befehl(r.PathValue("ext"), b.Person, b.Befehl); err != nil {
			json200(w, 409, map[string]string{"error": err.Error()})
			return
		}
		json200(w, 200, map[string]bool{"ok": true})
	}))
	m.HandleFunc("DELETE /sitzungen/{ext}", mit(lokal, func(w http.ResponseWriter, r *http.Request) {
		ext := r.PathValue("ext")
		person := r.URL.Query().Get("person")
		z.mu.Lock()
		s := z.sitzung[ext]
		z.mu.Unlock()
		// Lokal darf nur die eigene Sitzung beendet werden; die pbx-api jede.
		if s != nil && z.recht(r) != steuer && s.Person != person {
			json200(w, 409, map[string]string{"error": "Sitzung gehoert " + s.Person})
			return
		}
		grund := "beendet"
		if person != "" {
			grund = "beendet von " + person
		}
		json200(w, 200, map[string]bool{"beendet": z.SitzungBeenden(ext, grund)})
	}))
	return m
}
