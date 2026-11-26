// Package echteip ist ein lokales Traefik-Plugin (Edge CT 245): Es setzt
// X-Forwarded-For und X-Real-Ip auf die echte Client-Adresse.
//
//   - Verbindung von einer Cloudflare-Adresse (TrustedCIDRs) mit gueltigem
//     Cf-Connecting-Ip: diese Adresse ist der Client.
//   - Sonst: die Verbindungsadresse ist der Client; Cf-Connecting-Ip und
//     Cf-Visitor werden entfernt (sonst koennte jeder direkt verbindende Client
//     eine fremde Adresse vorschieben).
//
// X-Forwarded-For wird ueberschrieben, nicht ergaenzt: Cloudflare haengt an
// einen vom Client mitgeschickten Kopf nur an, der erste Eintrag waere damit
// frei waehlbar. Die Dienste dahinter (API, Frontends, Authentik) nehmen den
// ersten Eintrag.
package echteip

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// Config wird aus der dynamischen Konfiguration gelesen.
type Config struct {
	TrustedCIDRs []string `json:"trustedCIDRs,omitempty"`
}

// CreateConfig liefert die Standardkonfiguration.
func CreateConfig() *Config {
	return &Config{}
}

// EchteIP ist die Middleware.
type EchteIP struct {
	next    http.Handler
	name    string
	trusted []*net.IPNet
}

// New baut die Middleware; ohne gueltige Netze startet sie nicht.
func New(_ context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	e := &EchteIP{next: next, name: name}
	for _, c := range config.TrustedCIDRs {
		_, n, err := net.ParseCIDR(strings.TrimSpace(c))
		if err != nil {
			return nil, fmt.Errorf("echteip: ungueltiges Netz %q: %w", c, err)
		}
		e.trusted = append(e.trusted, n)
	}
	if len(e.trusted) == 0 {
		return nil, fmt.Errorf("echteip: trustedCIDRs fehlt")
	}
	return e, nil
}

func (e *EchteIP) vertraut(ip net.IP) bool {
	for _, n := range e.trusted {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func (e *EchteIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	client := host
	direkt := net.ParseIP(host)
	if direkt != nil && e.vertraut(direkt) {
		if cf := net.ParseIP(strings.TrimSpace(req.Header.Get("Cf-Connecting-Ip"))); cf != nil {
			client = cf.String()
		}
	} else {
		req.Header.Del("Cf-Connecting-Ip")
		req.Header.Del("Cf-Visitor")
	}
	req.Header.Set("X-Forwarded-For", client)
	req.Header.Set("X-Real-Ip", client)
	e.next.ServeHTTP(rw, req)
}
