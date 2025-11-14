# Cloudflare E-Mail-Routing Konfiguration

Diese Datei enthält die Konfiguration für Cloudflare E-Mail-Routing für die Ausschussmitglieder der STWEG-Kooperation Rosenweg.

## Übersicht

Die E-Mail-Adressen der Ausschussmitglieder wurden durch Cloudflare-E-Mail-Routing-Adressen ersetzt, um die Privatsphäre zu schützen und die Telefonnummern aus dem HTML zu entfernen.

## Cloudflare E-Mail-Routing Konfiguration

### Präsident

| Cloudflare-Adresse | Weiterleitung an |
|-------------------|------------------|
| `praesident@rosenweg4303.ch` | `jherrmann@gmx.ch` |

### STWEG-Vertreter

| Cloudflare-Adresse | Weiterleitung an |
|-------------------|------------------|
| `stweg1@rosenweg4303.ch` | `silvia.muenzer@teleport.ch`, `urs.speiser@gmail.com` |
| `stweg2@rosenweg4303.ch` | `dariogamboni@hotmail.ch`, `jherrmann@gmx.ch` |
| `stweg3@rosenweg4303.ch` | `stefan+rosenweg@juroct.ch`, `fersztand.basil@teleport.ch` |
| `stweg4@rosenweg4303.ch` | `francoisgoy@teleport.ch`, `thymi@gmx.ch` |
| `stweg5@rosenweg4303.ch` | `m.probst@maneca.ch`, `christian.christopher.bucher@gmail.com` |
| `stweg6@rosenweg4303.ch` | `mehmet.peker@pekerholding.ag`, `wirzj@me.com` |
| `stweg7@rosenweg4303.ch` | `gisela.studer@hotmail.com`, `redbon@bluewin.ch` |
| `stweg8@rosenweg4303.ch` | `redbon@bluewin.ch` |

## Anleitung zur Einrichtung in Cloudflare

1. **Cloudflare Dashboard öffnen**: Gehen Sie zu [https://dash.cloudflare.com](https://dash.cloudflare.com) und wählen Sie Ihre Domain `rosenweg4303.ch`

2. **E-Mail-Routing aktivieren**:
   - Navigieren Sie zu **E-Mail** → **E-Mail-Routing**
   - Falls noch nicht aktiviert, klicken Sie auf **E-Mail-Routing aktivieren**

3. **Weiterleitungsregeln erstellen**:
   - Klicken Sie auf **Weiterleitungsregel erstellen**
   - Geben Sie die Cloudflare-Adresse ein (z.B. `praesident@rosenweg4303.ch`)
   - Geben Sie die Ziel-E-Mail-Adresse(n) ein
   - Bei mehreren Zielen: Fügen Sie jede E-Mail-Adresse einzeln hinzu
   - Klicken Sie auf **Speichern**

4. **Wiederholen Sie Schritt 3** für alle E-Mail-Adressen in der Tabelle oben

5. **Verifizierung**:
   - Stellen Sie sicher, dass alle Ziel-E-Mail-Adressen verifiziert sind
   - Cloudflare sendet Verifizierungs-E-Mails an alle Ziel-Adressen

## Automatische Erstellung (optional)

Falls Sie die Cloudflare API verwenden möchten, können Sie die E-Mail-Routing-Regeln auch automatisch erstellen. Hier ist ein Beispiel-Skript:

```bash
# Cloudflare API Token und Zone ID erforderlich
CLOUDFLARE_API_TOKEN="Ihr_API_Token"
ZONE_ID="Ihre_Zone_ID"

# Präsident
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "praesident@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["jherrmann@gmx.ch"]}]
  }'

# STWEG 1
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg1@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["silvia.muenzer@teleport.ch", "urs.speiser@gmail.com"]}]
  }'

# STWEG 2
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg2@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["dariogamboni@hotmail.ch", "jherrmann@gmx.ch"]}]
  }'

# STWEG 3
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg3@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["stefan+rosenweg@juroct.ch", "fersztand.basil@teleport.ch"]}]
  }'

# STWEG 4
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg4@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["francoisgoy@teleport.ch", "thymi@gmx.ch"]}]
  }'

# STWEG 5
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg5@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["m.probst@maneca.ch", "christian.christopher.bucher@gmail.com"]}]
  }'

# STWEG 6
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg6@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["mehmet.peker@pekerholding.ag", "wirzj@me.com"]}]
  }'

# STWEG 7
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg7@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["gisela.studer@hotmail.com", "redbon@bluewin.ch"]}]
  }'

# STWEG 8
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "matchers": [{"type": "literal", "field": "to", "value": "stweg8@rosenweg4303.ch"}],
    "actions": [{"type": "forward", "value": ["redbon@bluewin.ch"]}]
  }'
```

## Hinweise

- **Telefonnummern**: Wurden in `ausschuss-kontakte.json` beibehalten, werden aber nicht mehr im HTML angezeigt
- **E-Mail-Adressen**: Werden als Cloudflare-Routing-Adressen angezeigt (z.B. `stweg1@rosenweg4303.ch`)
- **Weiterleitung**: Die Cloudflare-Adressen leiten E-Mails automatisch an die echten Adressen weiter
- **Privatsphäre**: Die echten E-Mail-Adressen und Telefonnummern sind nicht mehr öffentlich sichtbar

## Änderungen

### 2025-11-14
- Telefonnummern aus HTML entfernt (aber in JSON beibehalten)
- E-Mail-Adressen durch Cloudflare-Routing-Adressen ersetzt
- Pro STWEG eine E-Mail-Adresse, die an beide Vertreter weitergeleitet wird
