// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const (
	steuerTok = "steuer-0123456789abcdef0123456789abcdef"
	lokalTok  = "lokal-0123456789abcdef0123456789abcdef0"
)

func paar(t *testing.T) (priv, pub []byte) {
	priv = make([]byte, 32)
	rand.Read(priv)
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func freierUDP() int {
	u, _ := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	defer u.Close()
	return u.LocalAddr().(*net.UDPAddr).Port
}

// telefon spielt Rosenweg Geraet nach: eigener Netzstapel auf ip, :5555 = Echo
// (statt adbd), :7000 = Anzeige; merkt sich die letzte Anzeige.
type telefon struct {
	dev     *device.Device
	mu      sync.Mutex
	anzeige string
}

func neuesTelefon(t *testing.T, ip string, priv []byte, zentralePub string, zentralePort int) *telefon {
	t.Helper()
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr(ip)}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "telefon: "))
	zp, _ := base64.StdEncoding.DecodeString(zentralePub)
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\npublic_key=%s\nendpoint=127.0.0.1:%d\npersistent_keepalive_interval=1\nallowed_ip=10.243.44.1/32\n",
		hex.EncodeToString(priv), hex.EncodeToString(zp), zentralePort)); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	tel := &telefon{dev: dev}
	adb, _ := tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP(ip), Port: 5555})
	anz, _ := tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP(ip), Port: 7000})
	go func() {
		for {
			c, err := adb.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	go func() {
		for {
			c, err := anz.Accept()
			if err != nil {
				return
			}
			z, _ := bufio.NewReader(c).ReadString('\n')
			tel.mu.Lock()
			tel.anzeige = strings.TrimSpace(z)
			tel.mu.Unlock()
			io.WriteString(c, "ok\n")
			c.Close()
		}
	}()
	t.Cleanup(dev.Close)
	return tel
}

type anlageAttrappe struct {
	mu       sync.Mutex
	peers    []PeerEintrag
	meldung  []SitzungMeldung
	srv      *httptest.Server
	ohneAuth int
}

func neueAnlage(t *testing.T) *anlageAttrappe {
	a := &anlageAttrappe{}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+steuerTok {
			a.mu.Lock()
			a.ohneAuth++
			a.mu.Unlock()
			w.WriteHeader(401)
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		switch r.URL.Path {
		case "/api/pbx/fernwartung/peers":
			json.NewEncoder(w).Encode(map[string]any{"peers": a.peers})
		case "/api/pbx/fernwartung/sitzung":
			var m SitzungMeldung
			json.NewDecoder(r.Body).Decode(&m)
			a.meldung = append(a.meldung, m)
			w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(a.srv.Close)
	return a
}

func (a *anlageAttrappe) meldungen() []SitzungMeldung {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]SitzungMeldung(nil), a.meldung...)
}

type testUmg struct {
	t      *testing.T
	l      *Laufend
	anlage *anlageAttrappe
	log    *bytes.Buffer
	logMu  *sync.Mutex
}

type sicherPuffer struct {
	mu *sync.Mutex
	b  *bytes.Buffer
}

func (s sicherPuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func neueUmgebung(t *testing.T, peers []PeerEintrag) *testUmg {
	t.Helper()
	a := neueAnlage(t)
	a.peers = peers
	dir := t.TempDir()
	pub := filepath.Join(dir, "adbkey.pub")
	os.WriteFile(pub, []byte(base64.StdEncoding.EncodeToString([]byte("adb-schluessel"))+" adbz@adb-zentrale\n"), 0o644)
	k := Konfig{WgPort: freierUDP(), Netz: netip.MustParsePrefix("10.243.44.0/24"), EndpointExtern: "adb.example:51832",
		SteuerBind: "127.0.0.1:0", SteuerToken: steuerTok, LokalToken: lokalTok, Schluessel: filepath.Join(dir, "server.key"),
		AnlageURL: a.srv.URL, AdbPub: pub, Leerlauf: time.Hour, SitzungsBasis: 30000}
	buf, mu := &bytes.Buffer{}, &sync.Mutex{}
	l, err := Starten(k, &Protokoll{aus: sicherPuffer{mu, buf}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Stoppen)
	return &testUmg{t: t, l: l, anlage: a, log: buf, logMu: mu}
}

func (u *testUmg) rufen(methode, pfad, token string, body any) (int, map[string]any) {
	u.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(methode, "http://"+u.l.SteuerAdresse()+pfad, r)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		u.t.Fatal(err)
	}
	defer res.Body.Close()
	var m map[string]any
	json.NewDecoder(res.Body).Decode(&m)
	return res.StatusCode, m
}

func warten(t *testing.T, was string, f func() bool) {
	t.Helper()
	for ende := time.Now().Add(10 * time.Second); time.Now().Before(ende); time.Sleep(50 * time.Millisecond) {
		if f() {
			return
		}
	}
	t.Fatalf("wartet vergeblich: %s", was)
}

func TestSitzungEndeZuEnde(t *testing.T) {
	tPriv, tPub := paar(t)
	peer := PeerEintrag{Ext: "2002", PublicKey: base64.StdEncoding.EncodeToString(tPub), IP: "10.243.44.12"}
	u := neueUmgebung(t, []PeerEintrag{peer})
	warten(t, "Peers vom Abgleich", func() bool { return u.l.Anzahl() == 1 })

	st, g := u.rufen("GET", "/gesundheit", lokalTok, nil)
	if st != 200 || g["public_key"] == "" || !strings.Contains(fmt.Sprint(g["adb_fingerabdruck"]), ":") {
		t.Fatalf("gesundheit: %d %v", st, g)
	}
	tel := neuesTelefon(t, "10.243.44.12", tPriv, g["public_key"].(string), u.l.k.WgPort)

	// ohne Token nichts, Lokal-Token nicht fuer Peers
	if st, _ := u.rufen("GET", "/zustand", "falsch", nil); st != 401 {
		t.Fatalf("ohne Token: %d", st)
	}
	if st, _ := u.rufen("PUT", "/peers", lokalTok, map[string]any{"peers": []any{}}); st != 401 {
		t.Fatalf("Lokal-Token darf Peers setzen: %d", st)
	}
	if st, _ := u.rufen("POST", "/sitzungen", lokalTok, map[string]string{"ext": "2002", "person": "stefan", "zweck": "updater"}); st != 403 {
		t.Fatalf("updater lokal: %d", st)
	}

	st, s := u.rufen("POST", "/sitzungen", lokalTok, map[string]string{"ext": "2002", "person": "stefan", "zweck": "shell"})
	if st != 200 || s["port"].(float64) != 32002 {
		t.Fatalf("Sitzung: %d %v", st, s)
	}
	// eine zweite Person bekommt die belegte Sitzung nicht
	if st, _ := u.rufen("POST", "/sitzungen", lokalTok, map[string]string{"ext": "2002", "person": "anna", "zweck": "shell"}); st != 409 {
		t.Fatalf("belegt: %d", st)
	}
	warten(t, "Anzeige am Telefon", func() bool {
		tel.mu.Lock()
		defer tel.mu.Unlock()
		return strings.Contains(tel.anzeige, `"person":"stefan"`)
	})

	c, err := net.Dial("tcp", "127.0.0.1:32002")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(c, "host::features\n")
	zeile, _ := bufio.NewReader(c).ReadString('\n')
	if zeile != "host::features\n" {
		t.Fatalf("durch den Tunnel: %q", zeile)
	}
	u.rufen("POST", "/sitzungen/2002/befehl", lokalTok, map[string]string{"person": "stefan", "befehl": "shell dumpsys battery"})
	_, zst := u.rufen("GET", "/zustand", steuerTok, nil)
	p0 := zst["peers"].([]any)[0].(map[string]any)
	if p0["letzter_handshake"].(float64) == 0 || p0["sitzung"] == nil {
		t.Fatalf("zustand: %v", p0)
	}
	c.Close()

	if st, _ := u.rufen("DELETE", "/sitzungen/2002?person=anna", lokalTok, nil); st != 409 {
		t.Fatalf("fremde Sitzung beendet: %d", st)
	}
	u.rufen("DELETE", "/sitzungen/2002?person=stefan", lokalTok, nil)
	if _, err := net.DialTimeout("tcp", "127.0.0.1:32002", time.Second); err == nil {
		t.Fatal("Port nach Sitzungsende noch offen")
	}
	warten(t, "Meldungen an die Anlage", func() bool { return len(u.anlage.meldungen()) == 2 })
	m := u.anlage.meldungen()
	ende := m[0]
	if m[1].Art == "zu" {
		ende = m[1]
	}
	if ende.Art != "zu" || ende.Person != "stefan" || ende.BytesHin == 0 || ende.BytesHer == 0 ||
		len(ende.Befehle) != 1 || ende.Befehle[0] != "shell dumpsys battery" {
		t.Fatalf("Ende-Meldung: %+v", ende)
	}

	// Not-Aus: Peer weg, keine Sitzung mehr moeglich
	u.rufen("POST", "/sitzungen", lokalTok, map[string]string{"ext": "2002", "person": "stefan", "zweck": "shell"})
	if st, r := u.rufen("DELETE", "/peers/2002?durch=stefan", steuerTok, nil); st != 200 || r["entfernt"] != true {
		t.Fatalf("Not-Aus: %d %v", st, r)
	}
	if st, _ := u.rufen("POST", "/sitzungen", lokalTok, map[string]string{"ext": "2002", "person": "stefan", "zweck": "shell"}); st != 404 {
		t.Fatalf("nach Not-Aus: %d", st)
	}
	u.logMu.Lock()
	log := u.log.String()
	u.logMu.Unlock()
	for _, w := range []string{`"aktion":"sitzung-auf"`, `"aktion":"sitzung"`, `"aktion":"not-aus"`} {
		if !strings.Contains(log, w) {
			t.Fatalf("Protokoll ohne %s:\n%s", w, log)
		}
	}
	if strings.Contains(log, steuerTok) || strings.Contains(log, lokalTok) {
		t.Fatal("Token im Protokoll")
	}
}

func TestPeersPruefen(t *testing.T) {
	_, pub := paar(t)
	k := base64.StdEncoding.EncodeToString(pub)
	// Starten gleicht die Peers einmal im Hintergrund mit der Anlage ab. Kaeme
	// dieser Abgleich nach dem PeersSetzen unten, setzte er die Liste wieder auf
	// den Stand der Anlage (Rennen, rot in der CI). Darum erst darauf warten.
	gueltig := []PeerEintrag{{Ext: "2002", PublicKey: k, IP: "10.243.44.5"}}
	u := neueUmgebung(t, gueltig)
	warten(t, "erster Abgleich", func() bool { return u.l.Anzahl() == 1 })
	for _, falsch := range [][]PeerEintrag{
		{{Ext: "20x2", PublicKey: k, IP: "10.243.44.5"}},
		{{Ext: "2002", PublicKey: k, IP: "10.243.44.1"}},   // Adresse der Zentrale
		{{Ext: "2002", PublicKey: k, IP: "10.243.44.255"}}, // Broadcast
		{{Ext: "2002", PublicKey: k, IP: "10.0.0.5"}},
		{{Ext: "2002", PublicKey: "kurz", IP: "10.243.44.5"}},
		{{Ext: "2002", PublicKey: k, IP: "10.243.44.5"}, {Ext: "2003", PublicKey: k, IP: "10.243.44.6"}},
	} {
		if err := u.l.PeersSetzen(falsch, "test"); err == nil {
			t.Fatalf("angenommen: %+v", falsch)
		}
	}
	if err := u.l.PeersSetzen(gueltig, "test"); err != nil || u.l.Anzahl() != 1 {
		t.Fatal(err)
	}
	if err := u.l.PeersSetzen(nil, "test"); err != nil || u.l.Anzahl() != 0 {
		t.Fatal("leere Liste")
	}
}

func TestLeerlauf(t *testing.T) {
	_, pub := paar(t)
	u := neueUmgebung(t, []PeerEintrag{{Ext: "2003", PublicKey: base64.StdEncoding.EncodeToString(pub), IP: "10.243.44.13"}})
	warten(t, "Peers", func() bool { return u.l.Anzahl() == 1 })
	if _, err := u.l.SitzungOeffnen("2003", "stefan", "shell"); err != nil {
		t.Fatal(err)
	}
	u.l.jetzt = func() time.Time { return time.Now().Add(2 * time.Hour) }
	u.l.Aufraeumen()
	if len(u.l.Zustand()) != 1 || u.l.Zustand()[0].Sitzung != nil {
		t.Fatal("Sitzung nach Leerlauf noch offen")
	}
}

func TestKonfigVerlangtTokens(t *testing.T) {
	t.Setenv("ZW_STEUER_BIND", "0.0.0.0:8080")
	if _, err := KonfigLesen(); err == nil {
		t.Fatal("0.0.0.0 angenommen")
	}
	t.Setenv("ZW_STEUER_BIND", "192.0.2.68:8080")
	t.Setenv("ZW_STEUER_TOKEN", steuerTok)
	t.Setenv("ZW_LOKAL_TOKEN", steuerTok)
	t.Setenv("ZW_ANLAGE_URL", "http://192.0.2.55:8095")
	if _, err := KonfigLesen(); err == nil {
		t.Fatal("gleiche Tokens angenommen")
	}
	t.Setenv("ZW_LOKAL_TOKEN", lokalTok)
	if k, err := KonfigLesen(); err != nil || k.WgPort != 51832 || k.Netz.String() != "10.243.44.0/24" {
		t.Fatalf("%v %+v", err, k)
	}
}
