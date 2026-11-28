# MQTT — nicht-interaktiver Login für Authentik-User

Stand: 17.11.2026. Ermöglicht MQTT-Clients (headless Geräte, Home Assistant,
Skripte), sich am Broker als Authentik-User anzumelden, **ohne** den interaktiven
Browser-Token-Flow (`/api/mqtt/token`), der für Maschinen keinen Sinn ergibt.
Bedienung für Technik: [anleitung-technik.md](anleitung-technik.md), Abschnitt 10.
Sicherheitsregeln: [sicherheit.md](sicherheit.md).

## Drei Arten, sich am Broker anzumelden

| Art | Benutzername | Passwort | Lebensdauer | wofür |
|---|---|---|---|---|
| Web-Token | `rwweb-<zufällig>` | `rwmqtt_<zufällig>` aus `POST /api/mqtt/token` | 12 Stunden (Karten-/Anlage-Anmeldung 30 min; `DELETE /api/mqtt/token` widerruft) | Weboberflächen (`mqtt.html`, Energie-Seiten) |
| Service-User | frei, z. B. `collector`, `display-public` | Hash in `mqtt_service_users` | dauerhaft | technische Dienste ohne Personenbezug (`topic_filter`, `can_write`) |
| Authentik-App-Passwort | Authentik-Benutzername (oder E-Mail) | App-Passwort-Token | bis zum Widerruf | Geräte und Programme einer Person |

Dieses Dokument beschreibt die dritte Art.

## Wichtig: Authentik kann kein echtes Login-Passwort-ROPC

Authentik unterstützt **kein** klassisches „Resource Owner Password Credentials" mit dem
normalen Login-Passwort (bewusst, aus Sicherheitsgründen). `grant_type=password` wird
intern **wie `client_credentials`** behandelt:

- **Username** = Authentik-User bzw. E-Mail
- **„Passwort"** = ein am Konto erzeugtes **App-Passwort-Token** (nicht das Login-Passwort)

Vorteile gegenüber dem echten Passwort: pro Gerät, **einzeln widerrufbar**,
Login-Passwort wird nie über MQTT übertragen, funktioniert auch bei Passkey- oder
MFA-Konten.

## Einrichtung in Authentik (dedizierter Provider)

Ein eigener Provider isoliert den Password-Grant vom Web-Login (der reiner Auth-Code-Flow
bleibt).

1. **Provider anlegen** → *Applications → Providers → Create → OAuth2/OpenID Provider*.
   - Name: z.B. `mqtt-ropc`.
   - **Grant Types**: `Password` (bzw. `Client credentials`) aktivieren (ab authentik
     2026.5 explizit wählbar).
   - **Client type**: `Public` (dann kein Secret) oder `Confidential` (Secret notieren).
   - **Scopes**: `openid`, `email`, `profile` (das `profile`-Mapping liefert die Gruppen
     im userinfo — nötig für die ACL).
2. **Application anlegen** und dem Provider zuordnen (nötig, damit der Token-Endpoint den
   Provider auflöst). Zugriff auf die Gruppen beschränken, die MQTT nutzen dürfen.
3. **Client-ID** (und ggf. Secret) in den Passwortmanager.

## Umgebung der API (CT 128, `/opt/rosenweg-core/.env`)

```bash
MQTT_PASSWORD_LOGIN=1                 # Feature einschalten (Standard: aus); auch "true"
MQTT_ROPC_CLIENT_ID=<client-id>       # Client-ID des dedizierten Providers
MQTT_ROPC_CLIENT_SECRET=              # leer bei Public Client, sonst <im Passwortmanager>
```

Ohne `MQTT_ROPC_CLIENT_ID` nimmt die API das Paar `AUTHENTIK_CLIENT_ID` /
`AUTHENTIK_CLIENT_SECRET` der Web-App. Für einen dedizierten Provider **immer**
`MQTT_ROPC_CLIENT_ID` setzen; ein Secret gilt dann nur, wenn
`MQTT_ROPC_CLIENT_SECRET` ausdrücklich gesetzt ist.

Ohne `MQTT_PASSWORD_LOGIN=1` lehnt der Broker App-Passwörter ab, und die Seiten zeigen
den Zugang als ausgeschaltet. Das Erzeugen von App-Passwörtern bleibt trotzdem möglich.

> **Nur mit TLS-Broker nutzen** — das App-Passwort wird im MQTT-CONNECT übertragen.
> Intern ist `mqtt://100.64.2.51:1883` ohne TLS; extern ist
> `mqtts://mqtt.rosenweg4303.ch:8883` vorgesehen (in der Oberfläche als „geplant“
> markiert).

## App-Passwort erzeugen

App-Passwörter werden über die Website angelegt, nicht von Hand in Authentik. Die API
legt in Authentik ein Token mit `intent=app_password`, ohne Ablaufdatum, und dem
Kennzeichen `mqtt-<pk>-<zufällig>` an (`<pk>` = Authentik-Benutzernummer) und zeigt den
Schlüssel **einmal** an. Die API verwaltet ausschliesslich Tokens mit diesem
Kennzeichen; andere App-Passwörter des Kontos fasst sie nie an.

| Wer | Wo | Grenzen |
|---|---|---|
| jede angemeldete Person für sich selbst | PWA **„Meine Daten“** (`pwa.rosenweg4303.ch/daten/`), Abschnitt MQTT → App-Passwörter (`/api/mqtt/my-access`, `/api/mqtt/my-app-passwords`) | höchstens 10 je Konto („Maximal 10 App-Passwörter — bitte alte löschen“) |
| Gruppe `technik` für andere | `mqtt.html` → Zugriffsverwaltung → „Bewohner-MQTT-Zugang (App-Passwörter)“ (`/api/mqtt/user-app-passwords`) | nur aus einer Browsersitzung |

Beide Wege verlangen eine echte Browser-Anmeldung: Mit einem persönlichen
Zugangstoken (PAT) sind diese Routen gesperrt, damit ein abgeflossenes Token keine
dauerhaften MQTT-Zugänge erzeugen kann. Widerrufen geht an denselben Stellen; eine
Person kann nur eigene App-Passwörter löschen („Nicht dein App-Passwort“).

## Verbinden (Beispiel)

```bash
mosquitto_sub -h mqtt.rosenweg4303.ch -p 8883 --cafile ca.crt \
  -u '<authentik-benutzername>' -P '<app-passwort>' \
  -t 'energy/#' -v
```

Welche Topics eine Person lesen darf, zeigt die Seite beim App-Passwort an
(„Erlaubte Topics“).

## Wie die Autorisierung greift

1. `getuser` prüft der Reihe nach: Web-Token → Service-User → **App-Passwort gegen
   Authentik** (`authentikPasswordLogin`, `grant_type=password` am Token-Endpoint,
   danach `userinfo`). Benutzernamen von Service-Usern und alle Namen, die mit
   `rwweb-` beginnen, werden nie per Authentik-Login belegt – sonst bekäme ein
   gleichnamiges Authentik-Konto deren Rechte.
2. Bei Erfolg werden Identität und Gruppen als kurzlebige `mqtt_tokens`-Zeile
   (Benutzername als Schlüssel, 1 Stunde) zwischengespeichert.
3. Bei jeder ACL-Prüfung gelten die **aktuellen** Gruppen aus der lokalen
   Benutzertabelle (Authentik-Sync), nicht die beim Login gespeicherten. Ist das
   lokale Konto deaktiviert, wird der Zugriff verweigert.
4. `aclcheck` nutzt dieselbe Logik wie beim Browser-Token:
   - `technik`/`Präsident` → Superuser (alles lesen und schreiben).
   - `heartbeat` und `display/#` darf jeder angemeldete Client lesen.
   - sonst nur lesen, ausser eine `mqtt_topic_rules`-Regel gewährt der Gruppe
     Schreibrecht;
   - `energy/<haus>/<bereich>` → nur Zähler, die der Person oder ihrer Gruppe in der
     Energie-Konfiguration zugeordnet sind.

## Sicherheit

- Login-Passwörter werden **nie** gespeichert; nur Identität und Gruppen kurz gecacht
  (Erfolg 60 s, Fehlschlag 15 s, höchstens 10 000 Einträge).
- App-Passwörter sind pro Gerät einzeln widerrufbar. Wird das Konto gelöscht,
  verschwinden auch seine App-Passwörter in Authentik.
- Für reine Maschinen ohne Personenbezug bleibt der **Service-User** die erste Wahl.
