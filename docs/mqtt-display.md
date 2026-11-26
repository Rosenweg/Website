# MQTT-Display-Contract — Ankündigungen & Notfall

Beliebige Displays (Kiosk-Browser, ESP32, LED-Matrix, e-ink, Home-Assistant …)
können Ankündigungen und Notfall-Meldungen aus dem Rosenweg-MQTT-Broker anzeigen.
Web-Kiosk-Referenz: **display.rosenweg4303.ch** (`display.html`).
Chromecasts zeigen dieselbe Seite über einen eigenen Cast-Empfänger — siehe [cast.md](cast.md).

## Topics (retained)

| Topic | Zweck |
|-------|-------|
| `display/announcements` | **Liste** aller laufenden Ankündigungen (JSON-Array), je mit Häuser-Filter |
| `display/announcement` | die **erste** laufende Ankündigung als Einzelwert – für ältere Abnehmer (ESP32, LED-Tafeln), die keine Liste kennen |
| `display/emergency`    | Notfall — hat **Vorrang**, Vollbild rot, ohne Häuser-Filter |

Alle drei sind **retained**: ein Display, das sich (neu) verbindet, bekommt sofort den
aktuellen Stand. Die API veröffentlicht `display/announcements` und
`display/announcement` beim eigenen Verbindungsaufbau, bei jeder Änderung und alle
fünf Minuten neu (damit Ankündigungen mit Ablaufdatum verschwinden). Ist die Liste
leer, wird auch `display/announcement` mit `active:false` geleert.

### Payload Einzelkanal (`display/announcement`, `display/emergency`)

```json
{
  "text": "Text der angezeigt wird",
  "pdf": "/api/display/pdf/aushang.pdf",
  "active": true,
  "scroll": false,
  "ts": 1785269863000,
  "by": "Vorstand"
}
```

- **text** — anzuzeigender Text (max. 2000 Zeichen).
- **pdf** — optional: Aushang als PDF; nur Verweise auf den eigenen Ablageort
  `/api/display/pdf/<name>.pdf` werden angenommen. Ein PDF ohne Text genügt.
  Als Bild liefert die API die erste Seite unter `/api/display/pdfbild/<name>`.
- **active** — `false` ⇒ Kanal leeren / nichts anzeigen.
- **scroll** — `true` ⇒ als horizontale Laufschrift, sonst statisch.
- **ts** — ms-Epoch der Publikation (für „aktualisiert vor …").
- **by** — Absender (informativ).

### Payload Liste (`display/announcements`)

```json
[ { "id": 12, "text": "Treppenhausreinigung", "pdf": "", "scroll": true,
    "haeuser": [13, 14, 16], "by": "Technik", "ts": 1785269863000 } ]
```

`haeuser` leer heisst: alle Häuser. Die Kiosk-Seite filtert nach ihrem Haus aus der
Adresse, z. B. `display.rosenweg4303.ch?haus=14`; ohne `?haus` zeigt sie alles.
Mehrere Ankündigungen wechseln sich ab.

Anzeige-Logik: ist `display/emergency` aktiv, hat es Vorrang vor allen
Ankündigungen. Sonst die passenden Ankündigungen zeigen, sonst Ruhezustand.

## Zugriff (Auth)

- **Lesen:** `display/#` ist für **jeden authentifizierten** Broker-Client freigegeben
  (aclcheck-Sonderregel, wie `heartbeat`). Für unbeaufsichtigte Displays gibt es den
  read-only Service-User **`display-public`** (nur `display/#` lesen) — analog zu
  `wetter-public`. Sein Passwort steht im Kiosk-Code `display.html` und damit im
  öffentlichen Repository; das ist bewusst so, er kann nur lesen.
- **Schreiben:** nur über die API (`/api/display/*`, Recht: Gruppe **`technik`**
  oder `role=admin` – die Gruppe `Präsident` allein genügt hier nicht) bzw. über das
  Messenger-Backend (Notfall-Spiegelung). Die API schreibt mit dem Broker-User
  `collector` (`MQTT_URL`, `MQTT_USER`, `MQTT_PASS` in der API-Umgebung; fehlt
  `MQTT_URL`, antworten die Schreib-Routen mit 503 „MQTT nicht konfiguriert“).
  Normale Clients dürfen nicht schreiben.

## Verbinden

| | intern (GBT-Netz) | extern |
|-|-|-|
| MQTT | `mqtt://100.64.2.51:1883` | `mqtts://mqtt.rosenweg4303.ch:8883` (TLS) |
| WebSocket | `ws://100.64.2.51:9001` | `wss://mqtt.rosenweg4303.ch` (TLS) |

User `display-public`, Passwort siehe `mqtt_service_users` (bzw. `display.html`).
Nach Connect `display/#` abonnieren (optional `heartbeat` für einen Verbindungs-/
Frische-Indikator: `{source,ts,epoch}`, ~alle 10 s).

## Steuern

- **Web:** `stationen.html` → Karte **„Ankündigungen & Notfall“** (seit dem 6. August;
  `mqtt.html` verweist nur noch dorthin). Nur für die Gruppe `technik`.
  - **Neue Ankündigung:** Text (bis 2000 Zeichen) und/oder **Aushang (PDF)** bis 6 MB,
    unter **Betrifft** STWEGs und/oder einzelne Häuser (nichts angehakt = alle
    Anzeigen), Laufschrift ja/nein → **„Ankündigung senden“**.
  - **Laufende Ankündigungen:** Liste mit Entfernen („Ankündigung entfernen? Sie
    verschwindet sofort von allen Anzeigen; ein zugehöriger Aushang wird
    mitgelöscht.“).
  - **Notfall:** Text → **„Notfall auslösen“** (Rückfrage „Notfall auf ALLEN Anzeigen
    auslösen?“) bzw. **„Notfall aufheben“**. Ein Notfall schaltet zusätzlich die
    SlideShow-Tafeln auf die Wiedergabeliste „Alarm“ (siehe unten).
- **API** (Anmeldung, Gruppe `technik`):
  - `GET /api/display/ankuendigungen`, `POST /api/display/ankuendigungen`
    `{ text, pdf, scroll, stwegs, haeuser, bis }`, `DELETE /api/display/ankuendigungen/:id`
  - `POST /api/display/pdf` (Aushang hochladen), `GET /api/display/state` (aktueller
    Stand beider Einzelkanäle)
  - `POST /api/display/announce` `{ channel: "announcement"|"emergency", text, pdf,
    scroll, active }` – schreibt direkt einen Einzelkanal. Für Ankündigungen die
    Listen-Routen nehmen; `announce` auf `announcement` wird bei der nächsten
    Veröffentlichung der Liste (spätestens nach fünf Minuten) überschrieben.
- **Automatisch (Chat):** Nachrichten in der Messenger-Gruppe **„Notfall/Krise"**
  (`bcast/notfall`) werden vom message-store automatisch auf `display/emergency`
  gespiegelt → erscheinen sofort auf allen Displays. **Beenden direkt im Chat:**
  eine Nachricht **„Stop"** (oder „Entwarnung"/„Ende"/„Vorbei"/„Aufgehoben"/„Alles ok")
  hebt den Notfall auf (`active:false`). Alternativ „Notfall aufheben“ in
  `stationen.html`.
- **Automatisch (Sensoren):** `POST /api/alarm` mit Kopfzeile `X-Alarm-Secret`
  (`ALARM_SECRET`) postet in die Gruppe „Notfall/Krise“; `active:false` ist die
  Entwarnung. Aufrufer ist ioBroker (Gas-/Rauchmelder).

## Digital-Signage-Ticker (SlideShow-App)

Für Laufschriften in der Android-TV-App **SlideShow** (`sk.mimac.slideshow`) gibt es
einen RSS-Feed mit den aktiven Meldungen (Notfall zuerst, dann Ankündigung):

```
https://display.rosenweg4303.ch/api/display/rss      (extern/TLS, via Edge)
http://100.64.2.52:3000/api/display/rss              (intern direkt, ohne Edge)
```

In der App eine **Ticker-Zone** (RSS) auf diese URL richten → scrollt die aktuelle
Ankündigung. Der Feed kennt nur die Einzelkanäle, also nur die **erste** laufende
Ankündigung (ohne Häuser-Filter, ohne PDF). Ist nichts aktiv, ist der Feed leer
(Ticker zeigt nichts). Feed ist public (kein Login). `ttl=1` → App fragt häufig neu.

### SlideShow-Geräte über MQTT steuern

Am 5. August am Tablet im Eingang durchgemessen. Vier Themen je Gerät;
`<name>` ist das Feld „Name des MQTT-Themas", ohne Eintrag die MAC ohne
Doppelpunkte in Grossbuchstaben:

```text
SLIDESHOW/REQ/<name>/API      Befehle hinein
SLIDESHOW/RESP/<name>/API     Antworten heraus
SLIDESHOW/REQ/<name>/SHELL    Shell-Befehle, RESP entsprechend
```

**Die Parameter gehören in ein `parameters`-Objekt.** Beim Hersteller stehen
sie flach aufgeführt — flach geschickt antwortet die App mit „Missing one
of …" oder einer `NumberFormatException: s == null`, und man sucht den Fehler
bei den Feldnamen statt bei der Verschachtelung:

```json
{ "operation": "playlist/set",
  "parameters": { "playlistName": "Alarm" } }
```

`zoneName` darf fehlen — dann nimmt die App die Hauptzone des Layouts. Das
erspart ein weiteres Feld je Gerät, das ohnehin fast immer gleich hiesse.

**Die Wiedergabeliste heisst `playlistName`, nicht `playlist`.** Die Hersteller-
doku kennt nur `{"playlist": 1}` — eine Zahl. Beide Formen gibt es, und mit
einem Namen im falschen Feld antwortet die App:

```json
{"command":"playlist/set","errorCode":"INTERNAL_SERVER_ERROR",
 "errorMessage":"java.lang.NumberFormatException: For input string: \"Alarm\"",
 "success":false}
```

Wir nehmen den Namen: die Liste heisst auf **jedem** Gerät `Alarm`, so steht es
auf dem Einrichtungszettel. Damit braucht die API kein Feld je Gerät, und
niemand muss am Gerät eine Nummer vergeben — die Spalte „Nummer" der
Wiedergabelisten ist auf allen Geräten leer.

Erprobt und bestätigt: `zones` (liefert die Zonennamen), `deviceInfo` (Modell,
Android-Version, laufendes Layout, Temperatur, Lautstärke), `playlist/set`,
`playlist/clear`, `showSentHtml`, `synchronize`.

### `synchronize` — die Adresse aufs Gerät bringen

Damit legt die API die Anzeigeadresse selbst auf die Tafel, statt sie jemanden
abtippen zu lassen. Sie steckt in einem ZIP, das das Gerät sich holt:

```json
{ "operation": "synchronize",
  "parameters": { "url": "http://100.64.2.52:3000/api/display/geraetedatei/<id>.zip",
                  "method": "GET", "target": "file.zip", "clearFolder": false } }
```

Drei Dinge, die einen Vormittag gekostet haben:

* **`method` und `target` sind nicht optional.** Ohne sie meldet das Gerät 404,
  auch wenn die Adresse stimmt und ein `curl` vom selben Netz 200 liefert. Der
  Fehler sieht nach einem Serverproblem aus und ist keines.
* **`target` ist der Name der geladenen ZIP, nicht ihr Ziel.** Wohin entpackt
  wird, entscheidet allein die Struktur *im* Archiv. `"target": "rosenweg/file.zip"`
  quittiert die App mit `success`, die Datei landet trotzdem nicht dort.
* **Eine ersetzte Datei, keine zusätzliche.** Der Normaldurchlauf spielt jede
  Datei des Ordners einmal. Eine zweite Datei mit derselben Adresse heisst: die
  Anzeigeseite läuft zweimal pro Runde.

Alles von uns liegt im Ordner `rosenweg` — auf den Tafeln läuft auch Fremdes,
und dessen Dateien fasst niemand an. Das Archiv enthält genau
`rosenweg/alarm.url`; die Alarm-Wiedergabeliste spielt diesen Ordner.

**`playlist/clear` bringt das Gerät zu seinem eigenen Zeitplan zurück.** Die
API muss den Namen der normalen Wiedergabeliste also nicht kennen — ein
`playlist/set` auf „Alarm" hin, ein `playlist/clear` zurück. Auf beiden
Geräten gemessen:

```text
Fernseher   set    currentPlaylist = Alarm               alarm.url
            clear  currentPlaylist = All files in cycle  (nach 15 s: energiefluss r9.url)
Tablet      set    currentPlaylist = R9EG Eingang        …stream.m3u8?src=r9eg
            clear  currentPlaylist = All files in cycle  R92OGPanel.url
```

**Gemessen wird das an `deviceInfo`, nicht an einem Bildschirmfoto.** Ein
erster Versuch stützte sich auf ein Bild, sah dort die Anzeigeseite und schloss
daraus, `clear` habe nicht gewirkt — die Anzeigeseite gehört auf dem Fernseher
aber ohnehin für zehn Sekunden zur Rotation. Beide Zustände sehen zeitweise
gleich aus; nur `currentPlaylist` und `lastDisplayedFile` sind eindeutig.

`showSentHtml` zeigt eine beliebige Seite auf Zeit und braucht dafür **keine**
Datei auf dem Gerät — für einen Notfall-Vollbild-Override das einfachste
Mittel, und es stellt sich nach Ablauf von selbst zurück:

```json
{ "operation": "showSentHtml",
  "parameters": { "zoneName": "Hauptpanel", "length": "5",
                  "html": "<iframe src=\"https://display.rosenweg4303.ch\"></iframe>" } }
```

Achtung: das trifft **eine** Zone. Das Tablet im Eingang hat drei
(`Hauptpanel`, `R92OG Kamera`, `R9EG Kamera`) — die Kameras liefen während
des Tests unbeirrt weiter. Wer den ganzen Schirm will, spricht alle Zonen an
oder wechselt gleich das Layout.

Zwei Eigenheiten, die beim Messen Verwirrung stiften:

* Die App veröffentlicht ihre Antworten **retained**. Ein neuer Zuhörer
  bekommt sofort die letzte alte Antwort — wer mit `-C 1` mitliest, liest
  leicht die falsche. Über mehrere Sekunden sammeln.
* Der MQTT-Block in den Geräteeinstellungen greift erst nach einem Neuladen
  der App. Sie sagt das bei jedem Feld, aber nur im Hilfetext.

Kontrollieren lässt sich das Ergebnis ohne Gang zum Gerät: die Weboberfläche
liefert unter `/screenshot.jpg?displayId=0` ein Bild des laufenden Schirms.

Zugänge legt die Technik an: **Stationen → Anzeigegeräte → „Anzeigegerät
hinzufügen“** (Technik/Präsident). Der Knopf erzeugt den MQTT-Benutzer
(`SLIDESHOW/#`, schreibend) und zeigt alle Werte zum Abschreiben. „Entfernen“ löscht
den MQTT-Zugang des Geräts mit. Damit die API selbst Befehle schicken darf, hat `collector`
seit dem 5. August zusätzlich `SLIDESHOW/REQ/#`.

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

## Andere Anzeigetechnik: Samsung Tizen (E-Paper und Signage)

5./6. August recherchiert, nichts davon gebaut — der Stand für den Tag, an dem
so ein Gerät angeschafft wird.

Anlass war der **Samsung EM32DX**: 32" Farb-E-Paper, QHD, Tizen 8.0, bis zu 200
Tage Akku, 0 W bei stehendem Bild. Kein Android — die App SlideShow und damit
alles unter „SlideShow-Geräte über MQTT steuern" fällt dort weg.

**Was gegen E-Paper spricht und was nicht.** Der langsame Bildaufbau ist für
uns kein Hindernis: alarmiert wird ohnehin akustisch (Gas- und Rauchmelder),
der Bildschirm erklärt nur. Es bleibt, dass E-Paper **kein Hintergrundlicht**
hat — in einem dunklen Technikraum ist nichts zu sehen. Der Aufstellort
entscheidet, nicht die Technik.

**Wie Inhalte darauf kommen, ohne fremde Cloud.** Drei Wege:

* Samsung-E-Paper-App auf dem Telefon — von Hand, kein Alarm möglich.
* Samsung VXT — Cloud, keine Installation im Haus vorgesehen. MagicINFO
  On-Premise läuft aus (Lizenzverkauf bis 31.12.2026, Support bis 2029).
* **Custom App über TEP** (Tizen Enterprise Platform) — der einzige Weg, der
  zu unserer Bauweise passt.

**TEP im Einzelnen.** Eine App ist eine Tizen-**Webanwendung** (HTML, CSS, JS)
— unsere `display.html` mit ihrer eigenen MQTT-Verbindung wäre bereits der
Kern. Gebaut und signiert mit Tizen Studio:

```bash
tizen package -t wgt -s "CERT-PROFIL" -- /pfad/zur/app
```

Verteilt wird im Betrieb über **unseren eigenen Webserver**: `.wgt` plus
`sssp_config.xml` ablegen, am Gerät die Basisadresse eintragen. Alternativ per
USB (`SSSP/`-Ordner). Einmalig am Gerät „Permit to install apps". Für mehrere
Geräte gibt es den Tizen Business Manager (`tbm.tizenenterprise.com`):
Organisationskonto, Geräte per Seriennummer, Profil zuweisen — die Geräte
holen sich die App dann selbst. Nur für Tizen 6.5 und neuer.

**Das Zertifikat war der befürchtete Engpass — ist aber keiner.** Die
Partner-Ebene lässt sich mit einem kostenlosen Samsung-Konto selbst erzeugen;
Samsungs eigene Doku sagt „no limitation to request and get the distributor
certificate with this level". Die Partnerregistrierung braucht es erst für die
Verteilung **über den Store**, und daran gehen wir vorbei. Ein *öffentliches*
Zertifikat wird dagegen abgelehnt („invalid certificate chain").

**Was offen bleibt**, bevor jemand kauft:

* Ob das E-Paper-Modell Custom Apps genauso annimmt wie normale Signage — alle
  gefundenen Anleitungen beziehen sich auf LCD-Geräte (OH46DX).
* Wie eine Webseite auf E-Paper ihre Neuzeichnung auslöst. „Die Seite
  aktualisiert sich selbst" ist dort nicht selbstverständlich.
* `sdb`-Shell ist auf Signage gesperrt — Fehlersuche wird mühsam.

**Einordnung:** für ein einzelnes Gerät steht der Aufwand kaum dafür. Sollen
mittelfristig mehrere Anzeigen ins Haus, sieht die Rechnung anders aus — dann
liegt am Ende eine Webanwendung auf unserem Server, die wir selbst ausliefern,
und kein fremder Dienst dazwischen.
