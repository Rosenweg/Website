# CrowdSec-Melder

Die Zentrale (LAPI) läuft auf dem Edge-Traefik, CT 245, `100.64.2.40:8080`. Sie entscheidet und
sperrt am Eingang: Traefik-Bouncer, Firewall-Bouncer, PMG. Die Systeme dahinter bekommen nur
einen **Melder**. Das ist CrowdSec ohne eigene Zentrale: Er liest die Logs vor Ort und meldet
Fehlversuche an den Edge. Die Logs selbst verlassen das System nicht.

Regel (Stefan, 25.11.2026): **Nach 8 gescheiterten Anmeldungen wird die Adresse 24 h gesperrt**,
direkt am Edge. Eigene Netze sind ausgenommen (`../rosenweg-intern-whitelist.yaml`). Diese
Ausnahme muss auf **jedem Melder** liegen, weil die Meldung schon dort entsteht.

## Melder einrichten

Auf dem System, Debian 12/13. Die Paketquelle ist bookworm, das geht auch auf trixie:

```bash
curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey -o /usr/share/keyrings/crowdsec.asc
echo "deb [signed-by=/usr/share/keyrings/crowdsec.asc] https://packagecloud.io/crowdsec/crowdsec/debian/ bookworm main" \
  > /etc/apt/sources.list.d/crowdsec.list
apt-get update && apt-get install -y crowdsec
cscli collections install <passende Sammlung>
# Eigene Dateien dieses Systems nach /etc/crowdsec/... und die Ausnahme:
#   ../rosenweg-intern-whitelist.yaml -> /etc/crowdsec/parsers/s02-enrich/
# Eigene Zentrale aus, beim Edge anmelden:
sed -i '/^  server:/{n;s/enable: .*/enable: false/}' /etc/crowdsec/config.yaml
cscli lapi register --url http://100.64.2.40:8080 --machine <name>
```

Auf dem Edge:

1. Die Adresse des Systems in `../rw-crowdsec-lapi.nft` (Port 8080) eintragen, nach
   `/etc/rosenweg/` kopieren und `systemctl restart rw-crowdsec-lapi`.
2. `cscli machines validate <name>`.
3. Die neuen Szenarien in `../profil-rosenweg-anmeldung-24h.yaml` aufnehmen (Anfang von
   `/etc/crowdsec/profiles.yaml`), dann `systemctl reload crowdsec`.

Achtung bei den Dateien `acquis.d/setup.*.yaml`, die die Installation selbst anlegt: Eine
Log-Quelle nicht doppelt erfassen, sonst zählt jeder Versuch zweimal und es wird schon nach 4
gesperrt.

Prüfen: `cscli explain --log '<Zeile>' --type <typ>`. Für einen echten Test eine eigene
Testdatei als Quelle nehmen, mit 8 Zeilen von `203.0.113.9`. Auf dem Edge
`cscli decisions list -i 203.0.113.9` prüfen, danach `cscli decisions delete` und
`cscli alerts delete`, die Testquelle entfernen.

## Melder

| System | Name | Erfasst | Dateien |
|---|---|---|---|
| CT 220 Anlage | `ct220-anlage` | SIP-Anmeldungen (Asterisk PJSIP, `/var/log/asterisk/messages`), SSH | `ct220-anlage/` |

CT 220, getestet am 25.11.2026: 8 Fehlversuche von 203.0.113.9 führten am Edge zu
`rosenweg/sip-bf`, Sperre 24 h. Der mitgelieferte Parser `crowdsecurity/asterisk-logs` liest nur
SECURITY-Ereignisse aus dem Syslog. Darum gibt es den eigenen Parser
`rosenweg/asterisk-pjsip-logs`; er zählt nur „Failed to authenticate“, also einen Versuch pro
Ereignis. fail2ban (`asterisk-pjsip`, `sshd`) läuft dort weiter, als zweite Linie vor Ort.

Noch offen: CT 105 (MQTT), Nextcloud, CT 128 (Website-API), die Proxmox-Knoten.
