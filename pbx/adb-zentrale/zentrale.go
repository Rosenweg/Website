// SPDX-License-Identifier: GPL-3.0-or-later

// adb-zentrale: Endpunkt des dauerhaften adb-Tunnels der geteilten Telefone.
//
//	Telefon ──WireGuard UDP 51832──► adb-zentrale (Netzstapel im Prozess, kein TUN)
//	  netstack des Telefons: nur 10.243.44.n:5555 (adbd) und :7000 (Anzeige)
//	                                            │
//	  127.0.0.1:<Basis+ext>  ── nur waehrend einer Sitzung ──►  10.243.44.n:5555
//	  <LAN>:8080             Steuerung: pbx-api (Peers, Not-Aus, Zustand), rw-adb (Sitzungen)
//
// Die Telefone oeffnen den Tunnel, die Zentrale nie das WLAN eines Telefons.
// Durch den Tunnel erreicht sie nur die beiden Ports des Telefons; vom Telefon
// aus ist hier nichts erreichbar (der Netzstapel hoert im Tunnel auf nichts).
// Ein lokaler Port je Telefon ist nur offen, solange eine angemeldete Sitzung
// laeuft; die Sitzung meldet dem Telefon vorher, wer kommt (Band am Telefon).
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

var extRE = regexp.MustCompile(`^[0-9]{4}$`)

// Peer: ein geteiltes Telefon, fest (kommt von der pbx-api, nicht von der App).
type Peer struct {
	Ext    string
	IP     netip.Addr
	Public [32]byte
}

// Sitzung: ein offener lokaler Port zu einem Telefon.
type Sitzung struct {
	Ext, Person, Zweck string
	Beginn             time.Time
	Port               int

	ln       net.Listener
	letzte   atomic.Int64 // Unix-Nanosekunden des letzten Verkehrs
	hin, her atomic.Uint64
	offen    atomic.Int32
	anzeige  atomic.Bool // dem Telefon gemeldet

	mu      sync.Mutex
	befehle []string
	conns   map[net.Conn]struct{}
	zu      chan struct{}
	once    sync.Once
}

type Zentrale struct {
	k      Konfig
	dev    *device.Device
	tnet   *netstack.Net
	eigen  netip.Addr
	public [32]byte
	log    *Protokoll
	anlage *Anlage
	jetzt  func() time.Time

	mu       sync.Mutex
	peers    map[string]*Peer // nach Nebenstelle
	sitzung  map[string]*Sitzung
	wartende sync.WaitGroup
}

func schluesselLaden(pfad string) ([32]byte, error) {
	var k [32]byte
	if b, err := os.ReadFile(pfad); err == nil {
		d, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(d) != 32 {
			return k, errors.New("Server-Schluessel unlesbar")
		}
		copy(k[:], d)
		return k, nil
	}
	if _, err := rand.Read(k[:]); err != nil {
		return k, err
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	if err := os.MkdirAll(filepath.Dir(pfad), 0o700); err != nil {
		return k, err
	}
	return k, os.WriteFile(pfad, []byte(base64.StdEncoding.EncodeToString(k[:])+"\n"), 0o600)
}

func NeueZentrale(k Konfig, log *Protokoll, anlage *Anlage) (*Zentrale, error) {
	privat, err := schluesselLaden(k.Schluessel)
	if err != nil {
		return nil, err
	}
	pub, err := curve25519.X25519(privat[:], curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	eigen := k.Netz.Addr().Next()
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{eigen}, nil, 1420)
	if err != nil {
		return nil, err
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "adb-zentrale: "))
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n", hex.EncodeToString(privat[:]), k.WgPort)); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	z := &Zentrale{k: k, dev: dev, tnet: tnet, eigen: eigen, log: log, anlage: anlage, jetzt: time.Now,
		peers: map[string]*Peer{}, sitzung: map[string]*Sitzung{}}
	copy(z.public[:], pub)
	return z, nil
}

func (z *Zentrale) PublicB64() string { return base64.StdEncoding.EncodeToString(z.public[:]) }

func (z *Zentrale) Schliessen() {
	z.mu.Lock()
	alle := make([]*Sitzung, 0, len(z.sitzung))
	for _, s := range z.sitzung {
		alle = append(alle, s)
	}
	z.mu.Unlock()
	for _, s := range alle {
		z.SitzungBeenden(s.Ext, "dienst beendet")
	}
	z.dev.Close()
}

// PeerEintrag: so liefert und erwartet die Steuerung einen Peer.
type PeerEintrag struct {
	Ext       string `json:"ext"`
	PublicKey string `json:"public_key"`
	IP        string `json:"ip"`
}

func (z *Zentrale) peerPruefen(e PeerEintrag) (*Peer, error) {
	if !extRE.MatchString(e.Ext) {
		return nil, fmt.Errorf("Nebenstelle %q ungueltig", e.Ext)
	}
	ip, err := netip.ParseAddr(e.IP)
	if err != nil || !z.k.Netz.Contains(ip) || ip == z.eigen || ip == z.k.Netz.Addr() || !z.k.Netz.Contains(ip.Next()) {
		return nil, fmt.Errorf("Adresse %q nicht im Tunnelnetz", e.IP)
	}
	roh, err := base64.StdEncoding.DecodeString(e.PublicKey)
	if err != nil || len(roh) != 32 {
		return nil, fmt.Errorf("Schluessel von %s ungueltig", e.Ext)
	}
	p := &Peer{Ext: e.Ext, IP: ip}
	copy(p.Public[:], roh)
	return p, nil
}

// PeersSetzen ersetzt die ganze Liste (pbx-api ist die Quelle). Was fehlt,
// verschwindet samt offener Sitzung; Unveraendertes bleibt unberuehrt.
func (z *Zentrale) PeersSetzen(liste []PeerEintrag, grund string) error {
	neu := map[string]*Peer{}
	ips, keys := map[netip.Addr]bool{}, map[[32]byte]bool{}
	for _, e := range liste {
		p, err := z.peerPruefen(e)
		if err != nil {
			return err
		}
		if neu[p.Ext] != nil || ips[p.IP] || keys[p.Public] {
			return fmt.Errorf("doppelter Eintrag bei %s", p.Ext)
		}
		neu[p.Ext], ips[p.IP], keys[p.Public] = p, true, true
	}
	var weg []string
	z.mu.Lock()
	var b strings.Builder
	for ext, alt := range z.peers {
		if n := neu[ext]; n == nil || n.Public != alt.Public || n.IP != alt.IP {
			fmt.Fprintf(&b, "public_key=%s\nremove=true\n", hex.EncodeToString(alt.Public[:]))
			weg = append(weg, ext)
		}
	}
	dazu := 0
	for ext, n := range neu {
		if alt := z.peers[ext]; alt == nil || alt.Public != n.Public || alt.IP != n.IP {
			fmt.Fprintf(&b, "public_key=%s\nreplace_allowed_ips=true\nallowed_ip=%s/32\n", hex.EncodeToString(n.Public[:]), n.IP)
			dazu++
		}
	}
	if b.Len() > 0 {
		if err := z.dev.IpcSet(b.String()); err != nil {
			z.mu.Unlock()
			return err
		}
	}
	z.peers = neu
	z.mu.Unlock()
	for _, ext := range weg {
		z.SitzungBeenden(ext, "peer weg ("+grund+")")
	}
	if len(weg) > 0 || dazu > 0 {
		z.log.Schreiben(Eintrag{Aktion: "peers", Ergebnis: "ok", Grund: fmt.Sprintf("%s: %d neu/geaendert, %d weg, %d gesamt", grund, dazu, len(weg), len(neu))})
	}
	return nil
}

// NotAus: Peer sofort entfernen und die Sitzung kappen (wirkt, auch wenn das
// Telefon nicht antwortet). Die pbx-api nimmt ihn aus der Liste, damit er beim
// naechsten Abgleich nicht zurueckkommt.
func (z *Zentrale) NotAus(ext, durch string) bool {
	z.mu.Lock()
	p := z.peers[ext]
	if p != nil {
		z.dev.IpcSet(fmt.Sprintf("public_key=%s\nremove=true\n", hex.EncodeToString(p.Public[:])))
		delete(z.peers, ext)
	}
	z.mu.Unlock()
	z.SitzungBeenden(ext, "not-aus")
	z.log.Schreiben(Eintrag{Aktion: "not-aus", Ext: ext, Person: durch, Ergebnis: map[bool]string{true: "ok", false: "kein peer"}[p != nil]})
	return p != nil
}

type wgStand struct {
	handshake time.Time
	rx, tx    uint64
}

func (z *Zentrale) wgStaende() map[[32]byte]wgStand {
	m := map[[32]byte]wgStand{}
	text, err := z.dev.IpcGet()
	if err != nil {
		return m
	}
	var akt [32]byte
	for _, zl := range strings.Split(text, "\n") {
		name, wert, _ := strings.Cut(zl, "=")
		st := m[akt]
		switch name {
		case "public_key":
			b, _ := hex.DecodeString(wert)
			copy(akt[:], b)
			continue
		case "last_handshake_time_sec":
			if s, _ := strconv.ParseInt(wert, 10, 64); s > 0 {
				st.handshake = time.Unix(s, 0)
			}
		case "rx_bytes":
			st.rx, _ = strconv.ParseUint(wert, 10, 64)
		case "tx_bytes":
			st.tx, _ = strconv.ParseUint(wert, 10, 64)
		default:
			continue
		}
		m[akt] = st
	}
	return m
}

type SitzungJSON struct {
	Person   string `json:"person"`
	Zweck    string `json:"zweck"`
	Beginn   int64  `json:"beginn"`
	Port     int    `json:"port"`
	Offen    int    `json:"offen"`
	BytesHin uint64 `json:"bytes_hin"`
	BytesHer uint64 `json:"bytes_her"`
	Anzeige  bool   `json:"anzeige"`
}

type PeerZustand struct {
	Ext              string       `json:"ext"`
	IP               string       `json:"ip"`
	LetzterHandshake int64        `json:"letzter_handshake"`
	Empfangen        uint64       `json:"empfangen"`
	Gesendet         uint64       `json:"gesendet"`
	Sitzung          *SitzungJSON `json:"sitzung"`
}

func (s *Sitzung) json() *SitzungJSON {
	return &SitzungJSON{Person: s.Person, Zweck: s.Zweck, Beginn: s.Beginn.Unix(), Port: s.Port,
		Offen: int(s.offen.Load()), BytesHin: s.hin.Load(), BytesHer: s.her.Load(), Anzeige: s.anzeige.Load()}
}

func (z *Zentrale) Zustand() []PeerZustand {
	st := z.wgStaende()
	z.mu.Lock()
	defer z.mu.Unlock()
	out := make([]PeerZustand, 0, len(z.peers))
	for _, p := range z.peers {
		w := st[p.Public]
		pz := PeerZustand{Ext: p.Ext, IP: p.IP.String(), Empfangen: w.rx, Gesendet: w.tx}
		if !w.handshake.IsZero() {
			pz.LetzterHandshake = w.handshake.Unix()
		}
		if s := z.sitzung[p.Ext]; s != nil {
			pz.Sitzung = s.json()
		}
		out = append(out, pz)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ext < out[j].Ext })
	return out
}

func (z *Zentrale) Anzahl() int {
	z.mu.Lock()
	defer z.mu.Unlock()
	return len(z.peers)
}

// ─── Sitzungen ──────────────────────────────────────────────────────────────

var (
	ErrUnbekannt = errors.New("kein Fernwartungs-Peer fuer diese Nebenstelle")
	ErrBelegt    = errors.New("Sitzung laeuft schon fuer jemand anderen")
)

// SitzungOeffnen oeffnet (oder uebernimmt bei gleicher Person) den lokalen Port.
func (z *Zentrale) SitzungOeffnen(ext, person, zweck string) (*Sitzung, error) {
	z.mu.Lock()
	p := z.peers[ext]
	if p == nil {
		z.mu.Unlock()
		return nil, ErrUnbekannt
	}
	if s := z.sitzung[ext]; s != nil {
		z.mu.Unlock()
		if s.Person != person {
			return nil, fmt.Errorf("%w (%s, %s)", ErrBelegt, s.Person, s.Zweck)
		}
		s.letzte.Store(z.jetzt().UnixNano())
		return s, nil
	}
	nr, _ := strconv.Atoi(ext)
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(z.k.SitzungsBasis+nr)))
	if err != nil {
		z.mu.Unlock()
		return nil, fmt.Errorf("lokaler Port: %w", err)
	}
	s := &Sitzung{Ext: ext, Person: person, Zweck: zweck, Beginn: z.jetzt(), Port: ln.Addr().(*net.TCPAddr).Port,
		ln: ln, conns: map[net.Conn]struct{}{}, zu: make(chan struct{})}
	s.letzte.Store(s.Beginn.UnixNano())
	z.sitzung[ext] = s
	ziel := netip.AddrPortFrom(p.IP, 5555)
	anzeige := netip.AddrPortFrom(p.IP, 7000)
	z.mu.Unlock()

	z.log.Schreiben(Eintrag{Aktion: "sitzung-auf", Ext: ext, Person: person, Zweck: zweck, Beginn: s.Beginn.UTC().Format(time.RFC3339), Ergebnis: "ok"})
	z.anlage.SitzungMelden(SitzungMeldung{Art: "auf", Ext: ext, Person: person, Zweck: zweck, Beginn: s.Beginn.Unix()})
	z.anzeigeSenden(s, anzeige)
	z.wartende.Add(1)
	go func() {
		defer z.wartende.Done()
		z.annehmen(s, ziel, anzeige)
	}()
	return s, nil
}

// anzeigeSenden: dem Telefon sagen, wer kommt. Klappt es nicht (Telefon
// schlaeft), zeigt es das Band trotzdem ("unbekannt"); bei der naechsten
// Verbindung wird es erneut versucht.
func (z *Zentrale) anzeigeSenden(s *Sitzung, ziel netip.AddrPort) {
	if s.anzeige.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	c, err := z.tnet.DialContextTCPAddrPort(ctx, ziel)
	if err != nil {
		return
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(4 * time.Second))
	b, _ := json.Marshal(map[string]string{"person": s.Person, "zweck": s.Zweck})
	if _, err := c.Write(append(b, '\n')); err != nil {
		return
	}
	if a, _ := bufio.NewReader(c).ReadString('\n'); a == "ok\n" {
		s.anzeige.Store(true)
	}
}

type zaehler struct {
	io.Writer
	n    *atomic.Uint64
	zeit *atomic.Int64
}

func (w zaehler) Write(b []byte) (int, error) {
	n, err := w.Writer.Write(b)
	w.n.Add(uint64(n))
	w.zeit.Store(time.Now().UnixNano())
	return n, err
}

func (z *Zentrale) annehmen(s *Sitzung, ziel, anzeige netip.AddrPort) {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		z.wartende.Add(1)
		go func() {
			defer z.wartende.Done()
			defer c.Close()
			z.anzeigeSenden(s, anzeige)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			t, err := z.tnet.DialContextTCPAddrPort(ctx, ziel)
			cancel()
			if err != nil {
				return
			}
			defer t.Close()
			s.mu.Lock()
			s.conns[c], s.conns[t] = struct{}{}, struct{}{}
			s.mu.Unlock()
			s.offen.Add(1)
			defer func() {
				s.offen.Add(-1)
				s.letzte.Store(time.Now().UnixNano())
				s.mu.Lock()
				delete(s.conns, c)
				delete(s.conns, t)
				s.mu.Unlock()
			}()
			fertig := make(chan struct{}, 2)
			go func() { io.Copy(zaehler{t, &s.hin, &s.letzte}, c); halbZu(t); fertig <- struct{}{} }()
			go func() { io.Copy(zaehler{c, &s.her, &s.letzte}, t); halbZu(c); fertig <- struct{}{} }()
			select {
			case <-fertig:
				select {
				case <-fertig:
				case <-time.After(5 * time.Second):
				}
			case <-s.zu:
			}
		}()
	}
}

func halbZu(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	}
}

// Befehl merkt eine Befehlszeile von rw-adb fuer das Protokoll.
func (z *Zentrale) Befehl(ext, person, befehl string) error {
	z.mu.Lock()
	s := z.sitzung[ext]
	z.mu.Unlock()
	if s == nil {
		return errors.New("keine Sitzung")
	}
	if s.Person != person {
		return ErrBelegt
	}
	if r := []rune(befehl); len(r) > 200 {
		befehl = string(r[:200]) + "…"
	}
	s.mu.Lock()
	if len(s.befehle) < 200 {
		s.befehle = append(s.befehle, befehl)
	}
	s.mu.Unlock()
	s.letzte.Store(time.Now().UnixNano())
	return nil
}

// SitzungBeenden schliesst Port und Verbindungen und protokolliert.
func (z *Zentrale) SitzungBeenden(ext, grund string) bool {
	z.mu.Lock()
	s := z.sitzung[ext]
	delete(z.sitzung, ext)
	z.mu.Unlock()
	if s == nil {
		return false
	}
	s.once.Do(func() {
		close(s.zu)
		s.ln.Close()
		s.mu.Lock()
		for c := range s.conns {
			c.Close()
		}
		befehle := append([]string(nil), s.befehle...)
		s.mu.Unlock()
		ende := z.jetzt()
		z.log.Schreiben(Eintrag{Aktion: "sitzung", Ext: ext, Person: s.Person, Zweck: s.Zweck,
			Beginn: s.Beginn.UTC().Format(time.RFC3339), Ende: ende.UTC().Format(time.RFC3339),
			BytesHin: s.hin.Load(), BytesHer: s.her.Load(), Befehle: befehle, Ergebnis: "ok", Grund: grund})
		z.anlage.SitzungMelden(SitzungMeldung{Art: "zu", Ext: ext, Person: s.Person, Zweck: s.Zweck,
			Beginn: s.Beginn.Unix(), Ende: ende.Unix(), BytesHin: s.hin.Load(), BytesHer: s.her.Load(),
			Befehle: befehle, Grund: grund})
	})
	return true
}

// Aufraeumen beendet Sitzungen ohne Verkehr seit ZW_LEERLAUF. Offene
// Verbindungen zaehlen nicht: der adb-Server haelt seine Verbindung zu adbd
// auch ohne Befehle offen.
func (z *Zentrale) Aufraeumen() {
	grenze := z.jetzt().Add(-z.k.Leerlauf).UnixNano()
	var weg []string
	z.mu.Lock()
	for ext, s := range z.sitzung {
		if s.letzte.Load() < grenze {
			weg = append(weg, ext)
		}
	}
	z.mu.Unlock()
	for _, ext := range weg {
		z.SitzungBeenden(ext, "leerlauf")
	}
}
