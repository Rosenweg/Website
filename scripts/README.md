# Scripts

Dieses Verzeichnis enthält Automatisierungsskripte für das Website-Repository.

## sync-cloudflare-email.py

Synchronisiert die E-Mail-Routing-Regeln aus `ausschuss-kontakte.json` mit Cloudflare Email Routing.

### Verwendung

```bash
# Umgebungsvariablen setzen
export CLOUDFLARE_API_TOKEN="Ihr_API_Token"
export CLOUDFLARE_ZONE_ID="Ihre_Zone_ID"

# Skript ausführen
python3 sync-cloudflare-email.py
```

### Funktionen

- **Automatisches Erstellen**: Erstellt neue E-Mail-Routing-Regeln für alle @rosenweg4303.ch Adressen
- **Intelligentes Updaten**: Aktualisiert nur Regeln, die sich geändert haben
- **Überspringen**: Überspringt bereits aktuelle Regeln
- **Detailliertes Logging**: Zeigt genau an, was passiert ist

### Ausgabe-Beispiel

```
🔄 Starte Synchronisation der E-Mail-Routing-Regeln mit Cloudflare...

📖 Lade ausschuss-kontakte.json...
  ℹ️  9 Regeln in JSON gefunden

☁️  Hole existierende Regeln von Cloudflare...
  ℹ️  5 existierende Regeln in Cloudflare

🔄 Synchronisiere Regeln...

  ✅ Regel erstellt: praesident@rosenweg4303.ch → jherrmann@gmx.ch
  ✅ Regel erstellt: stweg1@rosenweg4303.ch → silvia.muenzer@teleport.ch, urs.speiser@gmail.com
  ⏭️  Regel bereits aktuell: stweg2@rosenweg4303.ch
  ...

============================================================
📊 Zusammenfassung:
  ✅ Erstellt:      4
  🔄 Aktualisiert:  1
  ⏭️  Übersprungen:  4
  📧 Gesamt:        9
============================================================

✅ Synchronisation erfolgreich abgeschlossen!
```

### Fehlerbehandlung

Das Skript prüft:
- ✅ Vorhandensein der Umgebungsvariablen
- ✅ Existenz der ausschuss-kontakte.json
- ✅ Gültigkeit der JSON-Struktur
- ✅ Cloudflare API-Verfügbarkeit
- ✅ Erfolg aller API-Aufrufe

Bei Fehlern werden aussagekräftige Fehlermeldungen ausgegeben.

## Verwendung in GitHub Actions

Das Skript wird automatisch von `.github/workflows/cloudflare-email-sync.yml` ausgeführt, wenn:
- `ausschuss-kontakte.json` in den `main` Branch gepusht wird
- Der Workflow manuell über GitHub Actions gestartet wird

Siehe [CLOUDFLARE-EMAIL-ROUTING.md](../CLOUDFLARE-EMAIL-ROUTING.md) für weitere Details.
