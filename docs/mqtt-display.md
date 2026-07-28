# MQTT-Display-Contract — Ankündigungen & Notfall

Beliebige Displays (Kiosk-Browser, ESP32, LED-Matrix, e-ink, Home-Assistant …)
können Ankündigungen und Notfall-Meldungen aus dem Rosenweg-MQTT-Broker anzeigen.
Web-Kiosk-Referenz: **display.rosenweg4303.ch** (`display.html`).

## Topics (retained)

| Topic | Zweck |
|-------|-------|
| `display/announcement` | Normale Ankündigung (Banner / Laufschrift) |
| `display/emergency`    | Notfall — hat **Vorrang**, Vollbild rot |

Beide sind **retained**: ein Display, das sich (neu) verbindet, bekommt sofort den
aktuellen Stand. `active:false` löscht den jeweiligen Kanal.

### Payload (JSON, UTF-8)

```json
{
  "text": "Text der angezeigt wird",
  "active": true,
  "scroll": false,
  "ts": 1785269863000,
  "by": "Vorstand"
}
```

- **text** — anzuzeigender Text (max. 2000 Zeichen).
- **active** — `false` ⇒ Kanal leeren / nichts anzeigen.
- **scroll** — `true` ⇒ als horizontale Laufschrift, sonst statisch.
- **ts** — ms-Epoch der Publikation (für „aktualisiert vor …").
- **by** — Absender (informativ).

Anzeige-Logik: ist `display/emergency` aktiv, hat es Vorrang vor
`display/announcement`. Sonst Announcement zeigen, sonst Ruhezustand.

## Zugriff (Auth)

- **Lesen:** `display/#` ist für **jeden authentifizierten** Broker-Client freigegeben
  (aclcheck-Sonderregel, wie `heartbeat`). Für unbeaufsichtigte Displays gibt es den
  read-only Service-User **`display-public`** (nur `display/#` lesen) — analog zu
  `wetter-public`. Passwort im Kiosk-Code eingebettet.
- **Schreiben:** nur Technik/Präsident über `POST /api/display/announce` bzw. der
  Messenger-Backend (Notfall-Spiegelung). Normale Clients dürfen nicht schreiben.

## Verbinden

| | intern (GBT-Netz) | extern |
|-|-|-|
| MQTT | `mqtt://100.64.2.51:1883` | `mqtts://mqtt.rosenweg4303.ch:8883` (TLS) |
| WebSocket | `ws://100.64.2.51:9001` | `wss://mqtt.rosenweg4303.ch` (TLS) |

User `display-public`, Passwort siehe `mqtt_service_users` (bzw. `display.html`).
Nach Connect `display/#` abonnieren (optional `heartbeat` für einen Verbindungs-/
Frische-Indikator: `{source,ts,epoch}`, ~alle 10 s).

## Steuern

- **Web/Admin:** mqtt.rosenweg4303.ch → Tab *Zugriffsverwaltung* → Karte
  „Display / Ankündigungen & Notfall" (Text, Kanal, Laufschrift, senden/löschen).
- **API:** `POST /api/display/announce` `{ channel: "announcement"|"emergency",
  text, scroll, active }` (Bearer-Token, Technik).
- **Automatisch (Chat):** Nachrichten in der Messenger-Gruppe **„Notfall/Krise"**
  (`bcast/notfall`) werden vom message-store automatisch auf `display/emergency`
  gespiegelt → erscheinen sofort auf allen Displays. **Beenden direkt im Chat:**
  eine Nachricht **„Stop"** (oder „Entwarnung"/„Ende"/„Vorbei"/„Aufgehoben"/„Alles ok")
  hebt den Notfall auf (`active:false`). Alternativ „Anzeige löschen" in der Admin-Karte.

## Minimalbeispiel (mosquitto / Shell)

```bash
# Ankündigung setzen
mosquitto_pub -h 100.64.2.51 -p 1883 -u display-public -P '<pw>' -r \
  -t display/announcement \
  -m '{"text":"Treppenhausreinigung morgen 9 Uhr","active":true,"scroll":true}'

# Anzeige löschen
mosquitto_pub -h 100.64.2.51 -p 1883 -u display-public -P '<pw>' -r \
  -t display/announcement -m '{"active":false}'
```
(Schreiben erfordert einen Client mit Schreibrecht auf `display/#`; `display-public`
ist read-only — für Tests einen Technik-Account/Service-User nehmen.)
