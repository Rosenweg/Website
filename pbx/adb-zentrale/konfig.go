// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// Konfig kommt aus der Umgebung (systemd: EnvironmentFile=/etc/adb-zentrale/env, 0640).
// Geheim sind nur ZW_STEUER_TOKEN und ZW_LOKAL_TOKEN.
type Konfig struct {
	WgPort         int          // ZW_WG_PORT, UDP, Standard 51832
	Netz           netip.Prefix // ZW_NETZ, nur im Tunnel, Standard 10.243.44.0/24
	EndpointExtern string       // ZW_ENDPOINT_EXTERN, Standard adb.rosenweg4303.ch:51832
	EndpointIntern string       // ZW_ENDPOINT_INTERN, LAN-Adresse des CT mit Port (im Haus)
	SteuerBind     string       // ZW_STEUER_BIND, LAN-Adresse:8080 (nicht 0.0.0.0)
	SteuerToken    string       // ZW_STEUER_TOKEN: pbx-api (alles) und Rueckmeldung an die pbx-api
	LokalToken     string       // ZW_LOKAL_TOKEN: rw-adb im CT (nur Sitzungen und Zustand)
	Schluessel     string       // ZW_SCHLUESSEL, privater WireGuard-Schluessel (wird angelegt)
	AnlageURL      string       // ZW_ANLAGE_URL, pbx-api, z. B. http://192.0.2.55:8095
	AdbPub         string       // ZW_ADB_PUB, oeffentlicher adb-Schluessel von adbz (nur lesen)
	Leerlauf       time.Duration
	SitzungsBasis  int // ZW_SITZUNG_BASIS: lokaler Port = Basis + Nebenstelle, Standard 20000
}

func umgebung(name, standard string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return standard
}

func KonfigLesen() (Konfig, error) {
	var k Konfig
	var err error
	if k.WgPort, err = strconv.Atoi(umgebung("ZW_WG_PORT", "51832")); err != nil {
		return k, fmt.Errorf("ZW_WG_PORT: %w", err)
	}
	if k.Netz, err = netip.ParsePrefix(umgebung("ZW_NETZ", "10.243.44.0/24")); err != nil || !k.Netz.Addr().Is4() {
		return k, fmt.Errorf("ZW_NETZ ungueltig")
	}
	k.Netz = k.Netz.Masked()
	k.EndpointExtern = umgebung("ZW_ENDPOINT_EXTERN", "adb.rosenweg4303.ch:51832")
	k.EndpointIntern = umgebung("ZW_ENDPOINT_INTERN", "")
	k.SteuerBind = umgebung("ZW_STEUER_BIND", "")
	k.SteuerToken = umgebung("ZW_STEUER_TOKEN", "")
	k.LokalToken = umgebung("ZW_LOKAL_TOKEN", "")
	k.Schluessel = umgebung("ZW_SCHLUESSEL", "/var/lib/adb-zentrale/server.key")
	k.AnlageURL = strings.TrimRight(umgebung("ZW_ANLAGE_URL", ""), "/")
	k.AdbPub = umgebung("ZW_ADB_PUB", "/etc/adb-zentrale/adbkey.pub")
	if k.Leerlauf, err = time.ParseDuration(umgebung("ZW_LEERLAUF", "30m")); err != nil {
		return k, fmt.Errorf("ZW_LEERLAUF: %w", err)
	}
	if k.SitzungsBasis, err = strconv.Atoi(umgebung("ZW_SITZUNG_BASIS", "20000")); err != nil {
		return k, fmt.Errorf("ZW_SITZUNG_BASIS: %w", err)
	}
	// Lieber laut scheitern als mit halber Konfiguration offen stehen.
	switch {
	case k.SteuerBind == "" || strings.HasPrefix(k.SteuerBind, "0.0.0.0") || strings.HasPrefix(k.SteuerBind, ":"):
		return k, errors.New("ZW_STEUER_BIND fehlt (LAN-Adresse:8080, nicht 0.0.0.0)")
	case len(k.SteuerToken) < 32:
		return k, errors.New("ZW_STEUER_TOKEN fehlt oder ist kuerzer als 32 Zeichen")
	case len(k.LokalToken) < 32 || k.LokalToken == k.SteuerToken:
		return k, errors.New("ZW_LOKAL_TOKEN fehlt, ist kuerzer als 32 Zeichen oder gleich ZW_STEUER_TOKEN")
	case k.AnlageURL == "":
		return k, errors.New("ZW_ANLAGE_URL fehlt (pbx-api, z. B. http://<CT 220>:8095)")
	}
	return k, nil
}
