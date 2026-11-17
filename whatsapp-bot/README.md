# Rosenweg WhatsApp-Bot und -Gateway

Stand: 17.11.2026. Betrieb, Deploy und Rückbau des Containers:
[`lxc/README.md`](lxc/README.md). Erlaubte Absender, Aliase und Weiterleitungen
(Daten): [`lxc/gateway-data.md`](lxc/gateway-data.md). Sicherheitsregeln im
Überblick: [`../docs/sicherheit.md`](../docs/sicherheit.md) Abschnitt 4.8.

Brücke zwischen WhatsApp und der Rosenweg-API, dazu ein Mail↔WhatsApp-Gateway.
Läuft als Docker-Container `whatsapp-bot` in **CT 116 `whatsapp-bridge`
(100.64.2.39, pve3, HA-schwebend)** – nicht mehr im Swarm.

Bewohner können per WhatsApp:
- Befehle ausführen (`/hilfe`, `/meineauslagen`, `/notfall`, `/handwerker`)
- Reklamationen melden (`/reklamation <Text>`)
- Benachrichtigungen empfangen (Auslage-Status, Freigaben in der Outbox, …)

Die Personenzuordnung läuft über die Telefonnummern in der Personen-DB
(`telefon`, `mobile`, `telefone[]`).

## Bestandteile und Ports

| Teil | Datei | Port | Zweck |
|---|---|---|---|
| Bot | `index.js` | 8080 | whatsapp-web.js; Health `/health`; `/groups`, `/delete-recent`, `/media-check` nur mit Header `X-WA-Secret` |
| Gateway | `gateway.js` | 8090 | Web-Oberfläche `whatsapp.rosenweg4303.ch`, Maschinen-API `/gateway/send`, Proxy für die Anmeldung |
| SMTP-Eingang | `gateway.js` | 2525 | Mail → WhatsApp, nur von PMG (Firewall `lxc/wa-2525-fw.nft`) |

```
WhatsApp ⇄ whatsapp-web.js (index.js) ⇄ Haupt-API 100.64.2.52:3000 (X-WA-Secret)
Mail ─▶ PMG (CT 230, .31) ─▶ :2525 Gateway ─▶ WhatsApp
Browser ─▶ edge-traefik ─▶ :8090 Gateway-UI ─▶ (Anmeldung über Haupt-API)
PBX (CT 220) ─▶ https://whatsapp.rosenweg4303.ch/gateway/send (Schlüssel mg_…)
```

Der Bot fragt die Outbox der API alle 15 s ab (`WA_POLL_MS`) und meldet
eingehende Nachrichten an die API.

## Zugänge und Rollen

| Weg | Wer | Prüfung |
|---|---|---|
| Web-Oberfläche (`/gateway/ui/*`, `/gateway/qr`) | nur Technik, Präsident oder `is_admin` | Bearer-Token einer **Browser-Anmeldung**, geprüft über `GET /api/me` der Haupt-API. Persönliche Zugangstoken (`rw_pat_…`) werden mit **403** `Zugangstoken hier nicht erlaubt — bitte im Browser anmelden` abgelehnt. |
| Maschinen-API `POST /gateway/send`, `/gateway/profile-picture` | Dienste (z. B. PBX-Voicemail) | benannter Schlüssel `mg_…` im Header `X-Messaging-Key` oder `Authorization: Bearer mg_…`, Scope `whatsapp` oder `*`. Schlüssel werden in der Web-Oberfläche angelegt und widerrufen; gespeichert wird nur ein Hash. |
| Bot-Endpunkte auf 8080 | Haupt-API | `X-WA-Secret` = `WHATSAPP_SHARED_SECRET` (zeitkonstanter Vergleich) |
| SMTP 2525 | PMG | Firewall + Absender-/Empfängerregeln, siehe unten |

### Anmelde-Proxy (Positivliste)

Die Web-Oberfläche meldet sich über die Haupt-API an. Der Gateway reicht dafür
nur genau diese Pfade an `MAIN_API_BASE` weiter:

| Pfad | Methode |
|---|---|
| `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`, `/api/auth/me` | GET |
| `/api/whatsapp/admin/recipients` | GET |
| `/api/whatsapp/admin/broadcast` | POST |

Alles andere unter `/api/` – auch kodierte Pfade (`%`, `\`) oder Punkt-Segmente
(`.`, `..`) – bekommt **404** `Nicht gefunden`. Grund: Vorher war der Proxy für
alle `/api/*` offen; weil alle Anfragen von dort mit der Gateway-IP bei der API
ankommen, liessen sich so die nginx-Drosseln der Haupt-API umgehen.

### Mail → WhatsApp (SMTP 2525)

1. **Firewall:** Port 2525 nimmt neue Verbindungen nur von PMG `100.64.2.31` an,
   für IPv4 **und** IPv6 (nftables-Tabelle `inet rw_wa_2525`). Alle anderen
   bekommen einen TCP-Reset.
2. **Absender:** Eine Quelle in `smtp_ips` genügt nur, wenn sie **keine strenge
   Quelle** ist. Strenge Quellen (`GW_SMTP_STRENG_IPS`, Standard PMG
   `100.64.2.31`) liefern auch Mail aus dem Internet; von dort muss der
   Absender (Envelope) in `smtp_senders` stehen. Sonst: `554 Quell-IP oder
   Absender nicht erlaubt`.
3. **Empfänger:** Von strengen Quellen nur **konfigurierte Aliase**
   (`<alias>@whatsapp.rosenweg4303.ch`) – keine freien Nummern, Gruppennamen
   oder JIDs. Sonst: `550 Empfaenger nicht erlaubt`. Ausnahme: eine Antwort an
   `<nummer>@…` auf eine WhatsApp→Mail-Weiterleitung, wenn genau dieser Absender
   zuletzt per Mail an diese Nummer geschrieben hat oder als Empfänger einer
   Weiterleitungsregel für diese Nummer eingetragen ist, und in `smtp_senders`
   steht.
4. Mit SMTP-AUTH (`GW_SMTP_USER`/`GW_SMTP_PASS`) entfallen 2. und 3.
5. Sind `smtp_ips` und `smtp_senders` beide leer, ist der Eingang offen (nur
   beim Neuaufbau; danach sofort befüllen, siehe `lxc/gateway-data.md`).

Im Log (`docker logs whatsapp-bot`) erscheinen Ablehnungen als
`[Gateway-SMTP] abgewiesen (IP+Absender): …` bzw.
`[Gateway-SMTP] Empfaenger abgewiesen (kein Alias): …`.

## Umgebungsvariablen

In `lxc/compose.yml` (ohne Geheimnisse) bzw. `/opt/whatsapp-bot/.env` (Geheimnisse):

| Variable | Wert / Bedeutung |
|---|---|
| `WHATSAPP_SHARED_SECRET` | **Geheimnis**, nur in `.env`; gleicher Wert wie in der Haupt-API |
| `API_BASE`, `MAIN_API_BASE` | `http://100.64.2.52:3000` (Haupt-API, CT 128) |
| `WA_POLL_MS`, `WA_HEARTBEAT_MS`, `WA_RECONNECT_MS` | 15000 / 30000 / 30000 |
| `WA_HEALTH_PORT`, `WA_GATEWAY_PORT`, `GW_SMTP_PORT` | 8080 / 8090 / 2525 |
| `GW_SMTP_STRENG_IPS` | strenge Quellen, Standard `100.64.2.31` (kommagetrennt) |
| `GW_SMTP_USER`, `GW_SMTP_PASS` | optional, SMTP-AUTH (Geheimnis, nur `.env`) |
| `GW_PUBLIC_HOST` | `whatsapp.rosenweg4303.ch` |
| `GW_NOTIFY_RELAY_HOST`, `GW_NOTIFY_RELAY_PORT` | `100.64.2.31`, `25` (Benachrichtigungsmails über PMG) |
| `GW_NOTIFY_RELAY_USER`, `GW_NOTIFY_RELAY_PASS` | optional (Geheimnis, nur `.env`) |
| `GW_NOTIFY_TLS_VERIFY` | `1` = Zertifikat des Relays prüfen. Standard aus, weil PMG per IP angesprochen wird und das Zertifikat nicht dazu passt |
| `GW_NOTIFY_FROM`, `GW_NOTIFY_DOMAINS`, `GW_REPLY_DOMAIN`, `GW_WA_TO_MAIL` | Absender und Antwortdomänen der WhatsApp→Mail-Weiterleitung |
| `WA_ARCHIVE_ALL_GROUPS` | `archiv@rosenweg4303.ch` |
| `GW_MAX_BODY`, `WA_DATA_DIR`, `WA_MARK_SEEN`, `FORWARD_INBOUND_URL`, `WA_SECRET_FORWARD_OFF` | selten gebraucht, Standardwerte im Code |

## Erstes Koppeln (QR-Code)

```bash
ssh root@100.64.2.22 'pct exec 116 -- docker logs -f whatsapp-bot'
```

Im Log erscheint ein QR-Code (alternativ in der Web-Oberfläche unter
`/gateway/qr`). Auf dem Telefon mit der Rosenweg-Nummer: WhatsApp →
Einstellungen → Verknüpfte Geräte → Gerät verknüpfen → scannen. Erfolg im Log:
`[WA] Bot ist bereit, Nummer: …`.

Test: in der Web-Oberfläche eine Testnachricht an eine eigene Nummer senden
(sollte in ~15 s ankommen) – nie an eine Bewohnergruppe.

## Wichtig zu wissen

- **Inoffizielle Bibliothek:** whatsapp-web.js nutzt WhatsApp Web und widerspricht
  den Nutzungsbedingungen. Bei geringem Volumen in der Praxis unproblematisch,
  die Nummer kann aber theoretisch gesperrt werden.
- **Sitzung:** liegt im Docker-Volume `whatsapp-bot_whatsapp-data` (`/data`), mit
  `gateway.sqlite`. Geht das Volume verloren, ist ein neuer QR-Scan nötig.
- **Updates:** Bei neuen WhatsApp-Web-Versionen kann der Bot ausfallen; dann neues
  Image ziehen und neu starten (`lxc/README.md`).
- **`public/authentik-auth.js`** ist eine byte-gleiche Kopie von
  `/js/authentik-auth.js` der Website (Einbindung `?v=5`); bei Änderungen dort
  mitkopieren.
