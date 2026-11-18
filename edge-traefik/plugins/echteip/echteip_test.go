package echteip

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func lauf(t *testing.T, remote string, kopf map[string]string) http.Header {
	t.Helper()
	cfg := CreateConfig()
	cfg.TrustedCIDRs = []string{"173.245.48.0/20", "2400:cb00::/32"}
	var gesehen http.Header
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { gesehen = r.Header.Clone() })
	h, err := New(context.Background(), next, cfg, "t")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://x/", nil)
	req.RemoteAddr = remote
	for k, v := range kopf {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return gesehen
}

func TestCloudflareMitKopf(t *testing.T) {
	h := lauf(t, "173.245.48.10:443", map[string]string{"Cf-Connecting-Ip": "198.51.100.7", "X-Forwarded-For": "6.6.6.6"})
	if h.Get("X-Forwarded-For") != "198.51.100.7" || h.Get("X-Real-Ip") != "198.51.100.7" {
		t.Fatalf("erwartet 198.51.100.7, bekommen %v", h)
	}
}

func TestCloudflareIPv6(t *testing.T) {
	h := lauf(t, "[2400:cb00::1]:443", map[string]string{"Cf-Connecting-Ip": "2001:db8::5"})
	if h.Get("X-Forwarded-For") != "2001:db8::5" {
		t.Fatalf("bekommen %v", h)
	}
}

func TestFremdMitGefaelschtemKopf(t *testing.T) {
	h := lauf(t, "203.0.113.4:5000", map[string]string{"Cf-Connecting-Ip": "198.51.100.7", "X-Forwarded-For": "6.6.6.6", "Cf-Visitor": "x"})
	if h.Get("X-Forwarded-For") != "203.0.113.4" || h.Get("Cf-Connecting-Ip") != "" || h.Get("Cf-Visitor") != "" {
		t.Fatalf("Faelschung nicht entfernt: %v", h)
	}
}

func TestCloudflareKaputterKopf(t *testing.T) {
	h := lauf(t, "173.245.48.10:443", map[string]string{"Cf-Connecting-Ip": "kein-ip"})
	if h.Get("X-Forwarded-For") != "173.245.48.10" {
		t.Fatalf("bekommen %v", h)
	}
}

func TestOhneNetzeStartetNicht(t *testing.T) {
	if _, err := New(context.Background(), http.NotFoundHandler(), CreateConfig(), "t"); err == nil {
		t.Fatal("ohne trustedCIDRs muss New scheitern")
	}
	cfg := CreateConfig()
	cfg.TrustedCIDRs = []string{"kaputt"}
	if _, err := New(context.Background(), http.NotFoundHandler(), cfg, "t"); err == nil {
		t.Fatal("ungueltiges Netz muss scheitern")
	}
}
