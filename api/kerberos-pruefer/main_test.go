// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/base64"
	"testing"
	"time"

	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/etypeID"
	"github.com/jcmturner/gokrb5/v8/iana/nametype"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/spnego"
	"github.com/jcmturner/gokrb5/v8/types"
)

// Ohne KDC: das Ticket stellt der Test selbst aus, mit dem Schlüssel aus einer
// Keytab — genau so, wie der KDC es mit dem Schlüssel des Dienstkontos täte.

const (
	realm = "AD.ROSENWEG4303.CH"
	spn   = "HTTP/www.rosenweg4303.ch"
)

func keytabMit(t *testing.T, passwort string) *keytab.Keytab {
	t.Helper()
	kt := keytab.New()
	if err := kt.AddEntry(spn, realm, passwort, time.Now(), 2, etypeID.AES256_CTS_HMAC_SHA1_96); err != nil {
		t.Fatal(err)
	}
	return kt
}

type ticketArt struct {
	dienst      string
	gueltigBis  time.Duration
	keytab      *keytab.Keytab
	rechner     string
	mechanismus asn1.ObjectIdentifier
}

func token(t *testing.T, a ticketArt) string {
	t.Helper()
	jetzt := time.Now().UTC()
	cname := types.NewPrincipalName(nametype.KRB_NT_PRINCIPAL, a.rechner)
	sname := types.NewPrincipalName(nametype.KRB_NT_SRV_INST, a.dienst)
	tkt, key, err := messages.NewTicket(cname, realm, sname, realm,
		types.NewKrbFlags(), a.keytab, etypeID.AES256_CTS_HMAC_SHA1_96, 2,
		jetzt.Add(-time.Minute), jetzt.Add(-time.Minute), jetzt.Add(a.gueltigBis), jetzt.Add(a.gueltigBis))
	if err != nil {
		t.Fatal(err)
	}
	cl := client.NewWithPassword(a.rechner, realm, "egal", config.New())
	k5, err := spnego.NewKRB5TokenAPREQ(cl, tkt, key, []int{gssapi.ContextFlagInteg, gssapi.ContextFlagConf}, []int{})
	if err != nil {
		t.Fatal(err)
	}
	kb, err := k5.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	st := spnego.SPNEGOToken{Init: true, NegTokenInit: spnego.NegTokenInit{
		MechTypes:      []asn1.ObjectIdentifier{a.mechanismus},
		MechTokenBytes: kb,
	}}
	b, err := st.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func normal(kt *keytab.Keytab) ticketArt {
	return ticketArt{dienst: spn, gueltigBis: 10 * time.Hour, keytab: kt, rechner: "WIN11-1$", mechanismus: gssapi.OIDMSLegacyKRB5.OID()}
}

func TestGueltigesTicket(t *testing.T) {
	kt := keytabMit(t, "geheim-des-dienstkontos")
	e := pruefen(kt, spn, token(t, normal(kt)))
	if !e.OK || e.Principal != "WIN11-1$" || e.Realm != realm {
		t.Fatalf("erwartet gültig, bekam %+v", e)
	}
	// Mit "Negotiate " davor, wie es im Header steht.
	if e := pruefen(kt, spn, "Negotiate "+token(t, normal(kt))); !e.OK {
		t.Fatalf("mit Präfix: %+v", e)
	}
}

func TestFremderSchluessel(t *testing.T) {
	echt := keytabMit(t, "geheim-des-dienstkontos")
	falsch := keytabMit(t, "ein-anderes-geheimnis")
	a := normal(falsch) // vom "falschen KDC" ausgestellt
	if e := pruefen(echt, spn, token(t, a)); e.OK {
		t.Fatalf("fremder Schlüssel angenommen: %+v", e)
	}
}

func TestFalscherDienst(t *testing.T) {
	// Keytab enthält zusätzlich einen anderen Dienst; ein Ticket dafür darf
	// hier nicht gelten.
	kt := keytabMit(t, "geheim")
	if err := kt.AddEntry("HTTP/authentik.rosenweg4303.ch", realm, "geheim", time.Now(), 2, etypeID.AES256_CTS_HMAC_SHA1_96); err != nil {
		t.Fatal(err)
	}
	a := normal(kt)
	a.dienst = "HTTP/authentik.rosenweg4303.ch"
	if e := pruefen(kt, spn, token(t, a)); e.OK {
		t.Fatalf("Ticket für anderen Dienst angenommen: %+v", e)
	}
}

func TestAbgelaufen(t *testing.T) {
	kt := keytabMit(t, "geheim")
	a := normal(kt)
	a.gueltigBis = -time.Hour
	if e := pruefen(kt, spn, token(t, a)); e.OK {
		t.Fatalf("abgelaufenes Ticket angenommen: %+v", e)
	}
}

func TestMechanismus(t *testing.T) {
	kt := keytabMit(t, "geheim")
	a := normal(kt)
	a.mechanismus = gssapi.OIDKRB5.OID()
	if e := pruefen(kt, spn, token(t, a)); !e.OK {
		t.Fatalf("Standard-OID abgelehnt: %+v", e)
	}
	a.mechanismus = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 2, 2, 10} // NTLMSSP
	if e := pruefen(kt, spn, token(t, a)); e.OK {
		t.Fatalf("NTLM-OID angenommen: %+v", e)
	}
}

func TestMuell(t *testing.T) {
	kt := keytabMit(t, "geheim")
	for _, roh := range []string{"", "!!!", base64.StdEncoding.EncodeToString([]byte("NTLMSSP\x00\x01")), base64.StdEncoding.EncodeToString([]byte{0x60, 0x01, 0x00})} {
		if e := pruefen(kt, spn, roh); e.OK {
			t.Fatalf("%q angenommen", roh)
		}
	}
}

func TestVeraendert(t *testing.T) {
	kt := keytabMit(t, "geheim")
	b, _ := base64.StdEncoding.DecodeString(token(t, normal(kt)))
	b[len(b)-10] ^= 0xff
	if e := pruefen(kt, spn, base64.StdEncoding.EncodeToString(b)); e.OK {
		t.Fatalf("verändertes Token angenommen: %+v", e)
	}
}
