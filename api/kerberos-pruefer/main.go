// SPDX-License-Identifier: GPL-3.0-or-later
//
// kerberos-pruefer — prüft ein SPNEGO/Kerberos-Token gegen die Keytab der
// Stationen-API und sagt, welches Konto sich damit ausweist.
//
// Warum ein eigenes kleines Programm und kein npm-Paket: die API läuft auf
// node:22-alpine. Das Paket "kerberos" braucht dort libkrb5, Python und einen
// Compiler im Image und bindet C-Code in den API-Prozess. gokrb5 ist reines Go,
// das Ergebnis eine statische Datei, die die API wie openssl per execFile
// aufruft — ein Absturz hier reisst die API nicht mit. Gebraucht wird es selten:
// nur bei der Anmeldung eines Agenten (Dienststart, verlorenes Token), nicht bei
// jedem Lebenszeichen.
//
// Aufruf (Token als Base64 auf stdin, eine Zeile):
//
//	kerberos-pruefer -keytab /run/secrets/stationen-api.keytab -spn HTTP/www.rosenweg4303.ch
//
// Ausgabe auf stdout, immer genau ein JSON-Objekt:
//
//	{"ok":true,"principal":"WIN11-1$","realm":"AD.ROSENWEG4303.CH","gueltig_bis":"…"}
//	{"ok":false,"grund":"…"}
//
// Exit-Code 0 = gültig, 1 = abgelehnt, 2 = Aufruf/Keytab kaputt.
//
// Was hier NICHT geprüft wird und darum die API tut: dass es ein
// Computerkonto ist (Name endet auf $), dass der Realm stimmt, dass das Token
// nicht schon einmal kam (Wiederholung — die Replay-Liste von gokrb5 lebt nur
// in diesem kurzen Prozess und wäre wirkungslos).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/nametype"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/service"
	"github.com/jcmturner/gokrb5/v8/spnego"
	"github.com/jcmturner/gokrb5/v8/types"
)

type ergebnis struct {
	OK         bool   `json:"ok"`
	Principal  string `json:"principal,omitempty"`
	Realm      string `json:"realm,omitempty"`
	GueltigBis string `json:"gueltig_bis,omitempty"`
	Grund      string `json:"grund,omitempty"`
}

// Kerberos-Tokens von Windows sind wenige Kilobyte, mit PAC selten über 12 KB.
const maxToken = 64 * 1024

func main() {
	ktPfad := flag.String("keytab", os.Getenv("STATION_KRB5_KEYTAB"), "Keytab der API")
	spn := flag.String("spn", envOder("STATION_KRB5_SPN", "HTTP/www.rosenweg4303.ch"), "erwarteter Dienstname")
	flag.Parse()

	kt, err := keytabLaden(*ktPfad)
	if err != nil {
		ausgeben(ergebnis{Grund: err.Error()}, 2)
	}
	zeile, err := bufio.NewReader(io.LimitReader(os.Stdin, maxToken*2)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		ausgeben(ergebnis{Grund: "stdin: " + err.Error()}, 2)
	}
	e := pruefen(kt, *spn, strings.TrimSpace(zeile))
	code := 0
	if !e.OK {
		code = 1
	}
	ausgeben(e, code)
}

func envOder(name, vorgabe string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return vorgabe
}

func keytabLaden(pfad string) (*keytab.Keytab, error) {
	if pfad == "" {
		return nil, errors.New("keine Keytab angegeben (-keytab oder STATION_KRB5_KEYTAB)")
	}
	b, err := os.ReadFile(pfad)
	if err != nil {
		return nil, fmt.Errorf("Keytab nicht lesbar: %v", err)
	}
	kt := keytab.New()
	if err := kt.Unmarshal(b); err != nil {
		return nil, fmt.Errorf("Keytab kaputt: %v", err)
	}
	return kt, nil
}

// pruefen ist ohne Ein-/Ausgabe, damit der Test es direkt aufrufen kann.
func pruefen(kt *keytab.Keytab, spn, b64 string) ergebnis {
	b64 = strings.TrimPrefix(b64, "Negotiate ")
	if b64 == "" || len(b64) > maxToken*4/3+4 {
		return ergebnis{Grund: "kein Token oder zu gross"}
	}
	roh, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ergebnis{Grund: "Token ist kein Base64"}
	}
	// NTLM erkennt man am Anfang. Kommt es, hat der Rechner kein Kerberos-
	// Ticket bekommen — meist fehlt der SPN im AD oder die Uhr geht falsch.
	if strings.HasPrefix(string(roh), "NTLMSSP") {
		return ergebnis{Grund: "NTLM statt Kerberos (SPN im AD? Uhrzeit?)"}
	}
	var tok spnego.SPNEGOToken
	if err := tok.Unmarshal(roh); err != nil {
		return ergebnis{Grund: "kein SPNEGO-Token: " + err.Error()}
	}
	if !tok.Init || len(tok.NegTokenInit.MechTokenBytes) == 0 {
		return ergebnis{Grund: "SPNEGO ohne Kerberos-Teil"}
	}

	// Der Mechanismus muss Kerberos sein (Windows nennt die alte Microsoft-
	// Kennung zuerst). Danach wird der AP-REQ selbst geprüft und NICHT über
	// SPNEGOService.AcceptSecContext: das meldet bei einem KRB-ERROR-Token
	// "ok" (StatusUnavailable) ohne Anmeldedaten — ein Fehler, der hier
	// später als Leerstelle auffiele, ist eine Lücke, die man nicht braucht.
	if len(tok.NegTokenInit.MechTypes) == 0 ||
		!(tok.NegTokenInit.MechTypes[0].Equal(gssapi.OIDKRB5.OID()) ||
			tok.NegTokenInit.MechTypes[0].Equal(gssapi.OIDMSLegacyKRB5.OID())) {
		return ergebnis{Grund: "Mechanismus ist nicht Kerberos"}
	}
	var k5 spnego.KRB5Token
	if err := k5.Unmarshal(tok.NegTokenInit.MechTokenBytes); err != nil {
		return ergebnis{Grund: "Kerberos-Teil unlesbar: " + err.Error()}
	}
	if !k5.IsAPReq() {
		return ergebnis{Grund: "kein AP-REQ"}
	}
	// Ausdrücklich der eine Dienstname: ohne diese Prüfung nähme gokrb5 jeden
	// Namen aus dem Ticket, für den die Keytab einen Schlüssel hat.
	erwartet := types.NewPrincipalName(nametype.KRB_NT_SRV_INST, spn)
	if !k5.APReq.Ticket.SName.Equal(erwartet) {
		return ergebnis{Grund: "Ticket für " + k5.APReq.Ticket.SName.PrincipalNameString() + ", erwartet " + spn}
	}
	einst := service.NewSettings(kt,
		service.KeytabPrincipal(spn),
		service.DecodePAC(false),
		service.MaxClockSkew(5*time.Minute))
	ok, creds, err := service.VerifyAPREQ(&k5.APReq, einst)
	if err != nil || !ok || creds == nil {
		grund := "ungültig"
		if err != nil {
			grund = err.Error()
		}
		return ergebnis{Grund: "abgelehnt: " + grund}
	}
	name := creds.CName().PrincipalNameString()
	if name == "" || creds.Domain() == "" {
		return ergebnis{Grund: "leerer Name"}
	}
	return ergebnis{
		OK:         true,
		Principal:  name,
		Realm:      creds.Domain(),
		GueltigBis: creds.ValidUntil().UTC().Format(time.RFC3339),
	}
}

func ausgeben(e ergebnis, code int) {
	_ = json.NewEncoder(os.Stdout).Encode(e)
	os.Exit(code)
}
