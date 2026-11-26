# Chromecasts als Anzeige (cast.rosenweg4303.ch)

Ein Chromecast (1., 2. Generation, nur Cast-Firmware) ist für Technik eine
**Anzeige-Station** wie eine Station mit der Rolle `display`
(os-stationen/roles/display):

| | Station `display` | Chromecast |
|---|---|---|
| Seite | `display.rosenweg4303.ch?haus=N` | dieselbe (aus `buildConfig`, Rolle `display`) |
| Ankündigungen / Notfall | display.html abonniert `display/#` (retained) | dasselbe — es läuft dieselbe Seite |
| Haus, Standort, Notiz, overrides | `/stationen` | `/stationen` (Art „Anzeige (Chromecast)") |
| Neuladen | `station-display-reload`, `reload_interval_minutes` | der Empfänger, mit demselben Wert |
| Hält die Seite offen | Kiosk-Sitzung (cage + Chromium) | **Cast-Wächter** der API |
| Sperren | keine Konfiguration mehr | Wächter lässt das Gerät in Ruhe |

Es gibt keine freie Adresse, keine Diashow und keine Lautstärke je Gerät —
wer die Adresse ändern muss, tut es wie bei einer Station in den overrides
(`roles.display.url`, nur Hosts aus `roles.display.allowed_domains`).

## Aufbau

```
/stationen ── PATCH/POST /api/stations/admin/... ──► stations (role='chromecast')
                                                            │
API (CT core) ── Cast-Wächter alle 45 s ── TLS :8009 ──► Chromecast (IP, anderes VLAN)
   │  GET_STATUS → Leerlauf/fremd/unser?                     │
   │  LAUNCH <App-ID> + {url}                                ▼
   │                                    Empfänger https://cast.rosenweg4303.ch/empfaenger/
   │                                    └ iframe /display.html?haus=N (gleiche Herkunft)
   └ display/emergency aktiv → sofort, ohne Pause                └ MQTT wss://mqtt… display/#
```

- `api/lib/castwaechter.js` — die Entscheidungen, ohne Netz und Datenbank
  (Tests: `api/test/castwaechter.test.js`).
- `api/lib/castverbindung.js` — das Cast-Protokoll über die Bibliothek
  `castv2` (TLS, Rahmen, Protobuf). Darauf nur CONNECT, PING/PONG,
  GET_STATUS, LAUNCH und die Ladenachricht. Die Verbindung bleibt offen
  (Herzschlag 5 s), wie bei einem Handy, das castet.
- `api/routes/stations.js` — Eintragen, Einstellen, „Jetzt auf die Anzeige
  holen", der periodische Lauf (mit Advisory-Lock: nur eine API-Instanz
  hält die Geräte), Status in `last_state.cast`, Ereignisse
  (`cast-wiederhergestellt`, `cast-fremd`, `cast-unerreichbar`, …).
- `cast-empfaenger.html` — der eigene Cast-Empfänger (ES5, für das alte
  Chrome auf Chromecast 1). Lädt das Web Receiver SDK v3 (CAF), fällt auf v2
  zurück.

**Warum in der API und kein eigener Dienst:** Die Geräte stehen in der
Stationsliste, ihre Anzeigeadresse kommt aus derselben `buildConfig` wie bei
einer Station, der Notfall-Stand (`displayCache`) liegt in der API, und
Anschluss- und AD-Wächter laufen dort schon nach demselben Muster. Ein
Python-Dienst mit pychromecast brächte eine zweite Laufzeit, eigenen
Datenbankzugang und eine Schnittstelle zurück zur API — für fünf Nachrichten.

**Warum castv2 und nicht castv2-client/pychromecast:** Die Bibliothek ist
klein und de-facto-Referenz des Protokolls (das sich seit 2014 nicht
geändert hat); Medien-Steuerung braucht eine Anzeige nicht. Sie wird nicht
mehr aktiv weiterentwickelt — deshalb sitzt alles Protokollspezifische in
`castverbindung.js` und liesse sich dort austauschen.

## Wächter-Regeln

| Gerät zeigt | Wächter |
|---|---|
| Leerlauf (Backdrop) — nach Neustart, App geschlossen | startet sofort die Anzeige |
| unseren Empfänger mit unserer Adresse | nichts |
| unseren Empfänger mit anderer/keiner Adresse | lädt die Adresse neu (kein Neustart) |
| eine fremde App (YouTube, …) | lässt sie, bis sie endet — höchstens `CAST_FREMD_MINUTEN` (20), dann übernimmt er |
| fremde App während eines Notfalls | übernimmt sofort |
| nicht erreichbar | merkt sich seit wann; „zuletzt gesehen" bleibt stehen |

**Vorschlag Pause: 20 Minuten.** Wer im Treppenhaus absichtlich etwas zeigt
(Video an der Versammlung), wird nicht nach einer Minute unterbrochen; ein
versehentlicher Cast vom Handy im Haus hält die Anzeige trotzdem nicht
stundenlang fern. Endet der fremde Cast früher, ist die Anzeige sofort
zurück. Ein Wechsel YouTube → Spotify setzt die Pause nicht neu. `0` = immer
sofort zurück. Gescheiterte Starts: 30 s, 1, 2, 4, 8, höchstens 10 min
Abstand.

Umgebung (backend-lxc/core/compose.yml):

| Variable | Vorgabe | |
|---|---|---|
| `CAST_APP_ID` | leer | App-ID des eigenen Empfängers; leer = DashCast |
| `CAST_WAECHTER_SEKUNDEN` | 45 | 0 = Wächter aus |
| `CAST_FREMD_MINUTEN` | 20 | Rücksichtspause bei fremdem Cast |

## Empfänger: drei Wege

1. **Eigener Empfänger (Ziel)** — `cast-empfaenger.html`, Receiver-URL
   `https://cast.rosenweg4303.ch/empfaenger/`. Zeigt die Anzeige in einem
   iframe auf **derselben Herkunft** (cast.rosenweg4303.ch liefert dasselbe
   Frontend aus wie display.rosenweg4303.ch — `X-Frame-Options: SAMEORIGIN`
   verbietet nur fremdes Einbetten). Er bleibt dadurch die oberste Seite,
   antwortet dem Wächter auf `STATUS` mit der gezeigten Adresse und lädt
   alle `reload_interval_minutes` neu. Nimmt nur Adressen aus den
   `allowed_domains` an. Braucht eine App-ID (Schritte unten).
2. **DashCast (sofort, Übergang)** — öffentlicher Empfänger `84912283`
   (Namensraum `urn:x-cast:com.madmod.dashcast`). Weil display das iframe
   verbietet, mit `force: true`: DashCast navigiert die ganze Seite auf
   `display.rosenweg4303.ch?haus=N`. Danach ist DashCast stumm — der Wächter
   sieht nur, *dass* die App läuft, nicht *was*. Schliesst das Gerät die
   App, startet er sie neu. Hängt an einem fremden Projekt auf GitHub Pages,
   deshalb nur Übergang.
3. **Default Media Receiver (`CC1AD845`)** — spielt nur Bilder/Videos, keine
   Webseiten. Für die Anzeige (Ankündigungen, Notfall aus MQTT) ungeeignet,
   deshalb nicht eingebaut.

An einem Chromecast 1 im Haus (Firmware 1.56) nur lesend geprüft: `GET_STATUS`
und `GET_APP_AVAILABILITY` über castv2 klappen direkt per IP über die
VLAN-Grenze; Leerlauf meldet sich als `Backdrop` mit `isIdleScreen: true`;
DashCast und Default Media Receiver sind `APP_AVAILABLE`. Gestartet wurde
dabei nichts.

## Was einzurichten ist (nicht im PR erledigt)

### 1. DNS
`cast.rosenweg4303.ch` wie `display.rosenweg4303.ch` (Cloudflare → Edge,
CT 245). Intern (Juro-DNS/Unbound) ebenfalls auf den Edge, falls display
dort einen internen Eintrag hat. Die Chromecasts holen den Empfänger per
**HTTPS** mit gültigem Zertifikat — Cast verlangt das.

### 2. Traefik (edge-traefik/extra-routes.yml) — Vorschlag
Gleiches Muster wie display, plus der Empfänger-Pfad:

```yaml
    # cast.rosenweg4303.ch -> www-Frontend. /empfaenger/ ist der Cast-Empfänger
    # (cast-empfaenger.html); /display.html usw. kommen vom selben Frontend,
    # damit der Empfänger die Anzeige auf gleicher Herkunft einbetten darf.
    cast-api-rw4303:
      entryPoints: [websecure]
      rule: Host(`cast.rosenweg4303.ch`) && PathPrefix(`/api/display/`)
      priority: 100
      service: core-api-svc
      tls: { certResolver: cf, domains: [{ main: cast.rosenweg4303.ch }] }
    cast-empfaenger-rw4303:
      entryPoints: [websecure]
      rule: Host(`cast.rosenweg4303.ch`) && PathPrefix(`/empfaenger`)
      priority: 60
      service: www-lxc-svc
      middlewares: [cast-empfaenger-rewrite]
      tls: { certResolver: cf, domains: [{ main: cast.rosenweg4303.ch }] }
    cast-page-rw4303:
      entryPoints: [websecure]
      rule: Host(`cast.rosenweg4303.ch`)
      priority: 10
      service: www-lxc-svc
      tls: { certResolver: cf, domains: [{ main: cast.rosenweg4303.ch }] }
  middlewares:
    cast-empfaenger-rewrite:
      replacePath:
        path: /cast-empfaenger.html
```

Prüfen danach: `https://cast.rosenweg4303.ch/empfaenger/?zeige=https://display.rosenweg4303.ch?haus=9`
im Browser zeigt die Anzeige für Haus 9.

### 3. Google Cast Developer Console (für den eigenen Empfänger)
1. <https://cast.google.com/publish> mit einem Google-Konto (einmalig 5 USD).
2. *Add new application* → **Custom Receiver**, Name „Rosenweg Anzeige",
   Receiver-URL `https://cast.rosenweg4303.ch/empfaenger/`.
3. Solange die App **unveröffentlicht** ist, läuft sie nur auf registrierten
   Geräten: *Add new device* mit der **Seriennummer** jedes Chromecast
   (Rückseite/Verpackung bzw. Google-Home-App → Gerät → Einstellungen). Danach
   den Chromecast einmal vom Strom nehmen; die Freischaltung dauert bis zu
   15 Minuten.
   Alternativ veröffentlichen — dann läuft sie auf jedem Gerät, ohne
   Seriennummern; der Empfänger zeigt ohnehin nur display.rosenweg4303.ch.
4. Die App-ID (8 Zeichen) als `CAST_APP_ID` in die Umgebung der API.
   Kein Geheimnis. Der Wächter stellt beim nächsten Lauf um: er sieht
   DashCast als fremde App und übernimmt nach der Pause (oder sofort mit
   „Jetzt auf die Anzeige holen").

### 4. Netz
- Die API (backend-lxc core, 100.64.2.52) muss jeden Chromecast auf
  **TCP 8009** erreichen (TLS, Cast-Protokoll). Nur diese Richtung; der
  Chromecast baut keine Verbindung zur API auf. Kein mDNS/SSDP nötig.
  Prüfen vom Host: `nc -vz <ip> 8009`.
- Die Chromecasts brauchen ausgehend HTTPS zu `cast.rosenweg4303.ch`,
  `display.rosenweg4303.ch`, `www.gstatic.com` (Cast-SDK),
  `fonts.googleapis.com`, WSS zu `mqtt.rosenweg4303.ch` — und zu Google für
  die Cast-Dienste (Geräte- und App-Prüfung).
- Feste IP je Gerät (DHCP-Reservierung in UniFi), damit die eingetragene
  Adresse stimmt.

### 5. Geräte eintragen
`/stationen` → „Chromecast eintragen": Name, IP, optional MAC, Haus,
Standort. Danach erscheint er in der Stationsliste wie eine Station;
„Aktionen" bietet „Jetzt auf die Anzeige holen", „Einstellen …",
„Sperren (Wächter anhalten)" und „Entfernen".

## Offen / zu prüfen am Gerät

- **Chromecast 1 und display.html**: Das Chrome auf Chromecast 1 ist alt.
  display.html nutzt moderne Syntax (optional catch binding, async/await) und
  mqtt.min.js v5. Ob sie dort läuft, zeigt erst der erste echte Start — falls
  nicht, braucht es eine schlanke Fassung der Anzeige (ohne neue Syntax).
- **CAF auf Chromecast 1**: Der Empfänger lädt SDK v3 und fällt bei Fehler
  auf v2 zurück; ob v3 auf Firmware 1.56 startet, am Gerät prüfen.
- **DashCast nach Navigation**: ob die Firmware die App nach `force`
  irgendwann schliesst; der Wächter startet sie dann neu (Ereignis
  `cast-wiederhergestellt` zeigt, wie oft).
