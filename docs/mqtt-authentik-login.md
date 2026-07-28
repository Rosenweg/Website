# MQTT — nicht-interaktiver Login für Authentik-User

Ermöglicht MQTT-Clients (headless Geräte, Skripte, Integrationen), sich am Broker als
Authentik-User anzumelden, **ohne** den interaktiven Browser-Token-Flow
(`/api/mqtt/token`), der für Maschinen keinen Sinn ergibt.

## Wichtig: Authentik kann kein echtes Login-Passwort-ROPC

Authentik unterstützt **kein** klassisches „Resource Owner Password Credentials" mit dem
normalen Login-Passwort (bewusst, aus Sicherheitsgründen). `grant_type=password` wird
intern **wie `client_credentials`** behandelt:

- **Username** = Authentik-User bzw. E-Mail
- **„Passwort"** = ein am Konto erzeugtes **App-Passwort-Token** (nicht das Login-Passwort)

Das gilt für alle Kontotypen (interne User, externe User, Service-Accounts). Vorteile
gegenüber dem echten Passwort: pro Nutzer, **einzeln widerrufbar**, Login-Passwort wird nie
über MQTT übertragen, funktioniert auch bei MFA am interaktiven Login.

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
3. **Client-ID** (und ggf. Secret) notieren.

## Env-Konfiguration (API)

```bash
MQTT_PASSWORD_LOGIN=1                 # Feature einschalten (Default 0)
MQTT_ROPC_CLIENT_ID=<client-id>       # Client-ID des dedizierten Providers
MQTT_ROPC_CLIENT_SECRET=              # leer bei Public Client, sonst das Secret
```

Ohne `MQTT_ROPC_CLIENT_ID` fällt die API auf `AUTHENTIK_CLIENT_ID`/`AUTHENTIK_CLIENT_SECRET`
(Web-App) zurück — für einen dedizierten Provider **immer** `MQTT_ROPC_CLIENT_ID` setzen.

> **Nur mit TLS-Broker aktivieren** — das App-Passwort wird im MQTT-CONNECT übertragen.

## App-Passwort je Nutzer erzeugen

Jeder Mensch, der einen MQTT-Client betreibt, erstellt sich in Authentik ein App-Passwort
(*User Settings → Tokens and App passwords → Create → App password*) und nutzt dieses als
MQTT-Passwort.

## Verbinden (Beispiel)

```bash
mosquitto_sub -h broker.example -p 8883 --cafile ca.crt \
  -u 'stefan.mueller.1694@gmail.com' -P '<app-passwort-token>' \
  -t 'energy/#' -v
```

## Wie die Autorisierung greift

1. `getuser` prüft Token → Service-User → **App-Passwort gegen Authentik**
   (`authentikPasswordLogin`, `grant_type=password` am token-Endpoint).
2. Bei Erfolg werden Identität + Gruppen aus **userinfo** gelesen und als kurzlebige
   `mqtt_tokens`-Zeile (Username als Schlüssel, 1 h) zwischengespeichert.
3. `aclcheck` nutzt dann **dieselbe Logik wie beim Browser-Token**:
   - `technik`/`präsident` → Superuser (alles).
   - sonst read-only, außer eine `mqtt_topic_rules`-Regel gewährt der Gruppe Schreibrecht;
   - `energy/<haus>/<bereich>` → nur eigene Zähler (über `meter_groups`/`meter_users`).

## Sicherheit

- Login-Passwörter werden **nie** gespeichert; nur Identität + Gruppen kurz gecacht
  (Erfolg 60 s, Fehlschlag 15 s, mit Größenlimit).
- App-Passwörter sind pro Nutzer einzeln in Authentik widerrufbar.
- Für reine Maschinen ohne Personenbezug bleibt der **Service-User** (`mqtt_service_users`,
  persistentes Secret, `topic_filter` + `can_write`) die erste Wahl.
