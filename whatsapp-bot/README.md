# Rosenweg WhatsApp-Bot

Bridge zwischen WhatsApp und der Rosenweg-API. Bewohner können per WhatsApp:
- Befehle ausführen (`/hilfe`, `/meineauslagen`, `/notfall`, `/handwerker`)
- Reklamationen melden (`/reklamation <Text>`)
- Push-Benachrichtigungen empfangen (Auslage-Status, Outbox-Pending, …)

Personenzuordnung erfolgt automatisch über die in der Personen-DB hinterlegte Telefonnummer (telefon / mobile / telefone[]).

## Architektur

```
WhatsApp ←→ whatsapp-web.js ←→ rosenweg_whatsapp-bot ←→ rosenweg_api ←→ Postgres
                                       ↑ X-WA-Secret-Header
```

Bot polled die Outbox alle 15s und sendet eingehende Nachrichten an die API.

## Einrichtung (einmalig)

### 1. Shared Secret konfigurieren

In `.env` auf dem Swarm-Host:

```bash
WHATSAPP_SHARED_SECRET=ein-langes-zufaelliges-secret-hier
```

Identischer Wert in api-Service (via `docker-stack.yml` als Environment einbinden) und whatsapp-bot-Service.

### 2. Service starten / restarten

```bash
docker stack deploy -c docker-stack.yml rosenweg
# oder gezielt:
docker service update --force rosenweg_whatsapp-bot
```

### 3. QR-Code scannen

```bash
docker service logs -f rosenweg_whatsapp-bot
```

Im Log erscheint ein ASCII-QR-Code. Auf dem Smartphone mit der gewünschten WhatsApp-Nummer:
1. WhatsApp öffnen
2. Einstellungen → Verknüpfte Geräte → Gerät verknüpfen
3. Den QR-Code abscannen

Erfolg sichtbar im Log: `[WA] Bot ist bereit, Nummer: 4179…`

### 4. Test

In der Admin-UI ([whatsapp-bot-admin.html](../whatsapp-bot-admin.html)) eine Test-Nachricht an eine Nummer senden. Sollte binnen ~15s in WhatsApp ankommen.

## Wichtig zu wissen

- **Inoffizielle Library**: whatsapp-web.js basiert auf WhatsApp Web und ist gegen die offiziellen Terms of Service. Bei niedrigem Volumen (~ STWEG) in der Praxis problemlos, aber theoretisch kann die Nummer gesperrt werden.
- **Persistenz**: Die Login-Session wird im Docker-Volume `whatsapp-data` (gemounted auf `/data`) gespeichert. Bei Volume-Loss → neuer QR-Scan nötig.
- **Single-Device**: Pro WhatsApp-Nummer nur 1 Linked-Device-Slot wird verwendet — die Nummer kann gleichzeitig auf dem Smartphone normal benutzt werden.
- **Updates**: Bei whatsapp-web.js-Updates kann es Inkompatibilitäten mit der WhatsApp-Web-Version geben → Bot kann ausfallen. `docker service update --force rosenweg_whatsapp-bot` zum Neustart.

## Migration auf Cloud API

Die API-Schnittstelle ist agnostisch (`/api/whatsapp/inbound` + `/outbox-poll`), sodass später ein anderer Provider (z.B. Meta Cloud API) eingebunden werden kann ohne Änderungen am Backend.
