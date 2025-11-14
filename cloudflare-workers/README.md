# Cloudflare Worker für IP-basierte Zugriffskontrolle

Dieser Cloudflare Worker stellt eine API bereit, die Ausschuss-Kontaktdaten mit IP-basierter Zugriffskontrolle ausliefert.

## Funktionsweise

Der Worker prüft die IP-Adresse der anfragenden Person:

- **IP stimmt mit `kooperation.rosenweg4303.ch` überein**: Vollständige Daten inkl. Telefonnummern werden zurückgegeben
- **Andere IPs**: Gefilterte Daten ohne Telefonnummern

## Deployment

### Voraussetzungen

1. **Cloudflare Account**: Kostenloses Konto bei [Cloudflare](https://dash.cloudflare.com/sign-up)
2. **Wrangler CLI**: Cloudflare's Command-Line Tool

```bash
npm install -g wrangler
```

### Schritt 1: Wrangler einrichten

```bash
# Login bei Cloudflare
wrangler login

# Worker deployen
cd cloudflare-workers
wrangler deploy
```

Nach dem Deployment erhalten Sie eine URL wie:
```
https://ausschuss-api.<your-subdomain>.workers.dev
```

### Schritt 2: Custom Domain/Route konfigurieren (optional)

#### Option A: Subdomain (empfohlen)

Erstellen Sie eine Subdomain für die API:

1. Gehen Sie zum [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Wählen Sie Ihre Domain `rosenweg4303.ch`
3. Navigieren Sie zu **Workers Routes**
4. Klicken Sie auf **Add route**
5. Konfiguration:
   - Route: `api.rosenweg4303.ch/*`
   - Worker: `ausschuss-api`
   - Zone: `rosenweg4303.ch`

Dann erstellen Sie noch einen DNS-Eintrag:
- Type: `AAAA`
- Name: `api`
- Content: `100::` (Cloudflare Placeholder für Worker)
- Proxy status: **Proxied** (orange cloud)

**API-Endpunkt**: `https://api.rosenweg4303.ch/`

#### Option B: Pfad unter Hauptdomain

Alternative: API unter der Hauptdomain verfügbar machen:

1. Route: `rosenweg4303.ch/api/*`
2. Worker: `ausschuss-api`

**API-Endpunkt**: `https://rosenweg4303.ch/api/`

### Schritt 3: Frontend aktualisieren

Aktualisieren Sie `ausschuss-loader.js` mit Ihrer Worker-URL:

```javascript
const CONFIG = {
    API_URL: 'https://api.rosenweg4303.ch',
    // oder
    API_URL: 'https://rosenweg4303.ch/api',
    ...
};
```

### Schritt 4: Testen

```bash
# Testen Sie den Worker
curl https://api.rosenweg4303.ch

# Prüfen Sie die Antwort
curl -v https://api.rosenweg4303.ch | jq '.meta.access_level'
```

## Konfiguration

### Hostname ändern

Um einen anderen Hostnamen für die IP-Prüfung zu verwenden, bearbeiten Sie `ausschuss-api-worker.js`:

```javascript
const CONFIG = {
  AUTHORIZED_HOSTNAME: 'ihr-hostname.beispiel.ch',
  ...
};
```

### GitHub Repository ändern

Falls das Repository umbenannt oder verschoben wird:

```javascript
const CONFIG = {
  GITHUB_RAW_JSON_URL: 'https://raw.githubusercontent.com/IhrUser/IhrRepo/main/ausschuss-kontakte.json',
  ...
};
```

## Entwicklung & Lokales Testen

```bash
# Worker lokal starten
wrangler dev

# Worker ist verfügbar unter http://localhost:8787
curl http://localhost:8787
```

## Monitoring & Logs

Logs können im Cloudflare Dashboard eingesehen werden:

1. Gehen Sie zu **Workers & Pages**
2. Wählen Sie `ausschuss-api`
3. Klicken Sie auf **Logs**

Oder über CLI:

```bash
wrangler tail
```

## Fehlerbehandlung

### Worker gibt immer "public" zurück

**Ursache**: DNS-Lookup für `kooperation.rosenweg4303.ch` schlägt fehl oder gibt keine IP zurück

**Lösung**:
1. Prüfen Sie, ob der Hostname existiert: `nslookup kooperation.rosenweg4303.ch`
2. Prüfen Sie die Worker-Logs: `wrangler tail`
3. Testen Sie den DNS-Lookup manuell: `curl "https://cloudflare-dns.com/dns-query?name=kooperation.rosenweg4303.ch&type=A" -H "Accept: application/dns-json"`

### CORS-Fehler im Browser

**Ursache**: Cross-Origin-Anfragen werden blockiert

**Lösung**: Der Worker hat bereits CORS-Header. Prüfen Sie:
1. Ob der Worker wirklich deployed ist
2. Browser-Console für detaillierte Fehlermeldungen

### GitHub-Datei nicht gefunden

**Ursache**: JSON-Datei ist nicht im `main` Branch oder Repository ist privat

**Lösung**:
1. Prüfen Sie den Branch-Namen in `GITHUB_RAW_JSON_URL`
2. Stellen Sie sicher, dass das Repository öffentlich ist

## Kosten

Der Cloudflare Workers Free Plan umfasst:
- ✅ 100.000 Anfragen/Tag
- ✅ Unbegrenzte Bandbreite
- ✅ Keine zusätzlichen Kosten

Für diese Anwendung sollte der Free Plan vollkommen ausreichend sein.

## Sicherheit

- ✅ Telefonnummern werden nur an autorisierte IPs ausgeliefert
- ✅ IP-Prüfung basiert auf DNS-Auflösung (schwer zu fälschen)
- ✅ HTTPS-only (sichere Übertragung)
- ✅ Keine Speicherung sensibler Daten im Worker
- ✅ Cache-TTL von 5 Minuten für DNS-Lookups

## Support

Bei Problemen:
1. Prüfen Sie die Worker-Logs: `wrangler tail`
2. Testen Sie den Worker lokal: `wrangler dev`
3. Prüfen Sie die Browser-Console auf Fehler
4. Öffnen Sie ein Issue im GitHub-Repository
