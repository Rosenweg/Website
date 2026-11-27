# adb-zentrale

Endpunkt des dauerhaften adb-Tunnels der geteilten Rosenweg-Telefone. Überblick, Bedienung und
Regeln: [`../GETEILTE-TELEFONE.md`](../GETEILTE-TELEFONE.md), Abschnitt „Fernwartung über den
dauerhaften adb-Tunnel“. Plan: `adb-tunnel-telefone-plan.md` (27.11.2026).

```
Telefon ──WireGuard UDP 51832──► adb-zentrale  (wireguard-go + gVisor im Prozess, kein TUN)
                                   127.0.0.1:<20000+ext>  nur während einer Sitzung → 10.243.44.n:5555
                                   <LAN>:8080             Steuerung: pbx-api (alles), rw-adb (Sitzungen)
pbx-api (CT 220) ◄── Peers holen alle 5 Min., Sitzungen melden ── adb-zentrale
Technik ──SSH──► adb-zentrale: rw-adb <ext> …  (sudo -u adbz, Schlüssel nur bei adbz)
```

| Datei | Zweck |
|---|---|
| `zentrale.go` | Peers (fest, von der pbx-api), Sitzungsports, Not-Aus, Zustand, Leerlauf |
| `steuerung.go` | HTTP-Steuerung, zwei Tokens: `ZW_STEUER_TOKEN` (pbx-api) und `ZW_LOKAL_TOKEN` (rw-adb, nur Sitzungen) |
| `anlage.go` | pbx-api: `GET /api/pbx/fernwartung/peers`, `POST /api/pbx/fernwartung/sitzung` |
| `protokoll.go` | JSON-Zeile je Aktion ins Journal (nie Tokens oder Schlüssel) |
| `rw-adb`, `rw-adb-intern` | Werkzeug für Technik; ruft adb als `adbz` auf, schreibt Befehle ins Protokoll, lehnt Neustart/Deinstallieren ab |
| `adb-zentrale.service`, `nftables.conf`, `nft-adressen.beispiel.conf`, `setup.sh` | Einrichtung im CT |

## CT

CT **148** `adb-zentrale` auf **pve2** (local-lvm, 4 GB), Debian 13, unprivilegiert, ohne
nesting und ohne TUN, 1 vCPU, 256 MB, **100.64.2.68/24** (vmbr2). Angelegt 27.11.2026, noch leer.
Rückweg: `pct stop 148 && pct destroy 148`.

## Einrichten

```bash
# Mac: bauen
(cd pbx/adb-zentrale && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" \
   -o build/adb-zentrale-linux-amd64 .)
# auf den CT (über pve2: pct push 148 …) samt diesem Verzeichnis und scripts/geteiltes-telefon-einrichten.sh
# im CT als root:
./setup.sh build/adb-zentrale-linux-amd64
#   /etc/adb-zentrale/env:       ZW_STEUER_BIND=100.64.2.68:8080, ZW_ENDPOINT_INTERN=100.64.2.68:51832,
#                                ZW_ANLAGE_URL=http://<CT 220>:8095
#   /etc/adb-zentrale/rw-adb.env: ZW_URL=http://100.64.2.68:8080
#   /etc/adb-zentrale/nft-adressen.conf: echte Adressen, dann nftables einspielen (Hinweis von setup.sh)
systemctl enable --now adb-zentrale
rw-adb schluessel            # Fingerabdruck der Zentrale (steht auch auf /smartphones)
```

CT 220, `/etc/default/pbx-api`: `PBX_ADB_ZENTRALE_URL=http://100.64.2.68:8080`,
`PBX_ADB_ZENTRALE_TOKEN=<ZW_STEUER_TOKEN>`, dann pbx-api neu starten. Ohne diese beiden bleibt
alles wie bisher.

SSH für Technik: Host in die Zugriffsmatrix (`docs/ssh-zugang.md`, `rw-ssh-aufnehmen.sh`), Regel
nur für die Gruppe Technik, `sudo` nicht nötig (rw-adb hat seine eigene sudoers-Regel für
`rw-verwaltet` → `adbz`).

## Netz von außen (noch nicht umgesetzt, erst nach Rückfrage)

Für Telefone im Haus reicht `ZW_ENDPOINT_INTERN` (Telefone nehmen ihn, solange das Juro- bzw.
Haus-DNS `adb.rosenweg4303.ch` nicht intern auflöst). Für Telefone ausserhalb (z. B. Juronetz):

1. **DNS** (Cloudflare): `adb.rosenweg4303.ch` CNAME `kooperation.rosenweg4303.ch`, **nur DNS**
   (graue Wolke, kein Proxy – UDP geht nicht durch Cloudflare), wie `sip.`.
2. **Internes DNS**: `adb.rosenweg4303.ch` A `100.64.2.68` (dort, wo auch `sip.` intern auf CT 220 zeigt).
3. **UniFi-Portweiterleitung**: WAN UDP **51832** → `100.64.2.68:51832`, nur UDP, Quelle beliebig.
4. Prüfen: `rw-adb liste` zeigt für ein Telefon ausserhalb einen frischen Handshake.

Rückweg: Weiterleitung und DNS-Einträge löschen; die Telefone fallen auf `ZW_ENDPOINT_INTERN` zurück.

## Tests

`go test -race ./...`: echter WireGuard-Handshake zwischen Zentrale und einem nachgebauten Telefon
(Echo statt adbd), Sitzung auf/zu, Anzeige am Telefon, Bytes und Befehle im Verlauf, belegte
Sitzung, Not-Aus, Leerlauf, Prüfung der Peers und der Konfiguration.
