# STWEG 3 - Rosenweg 9

Dieser Ordner enthält alle Dateien für die STWEG 3 (Stockwerkeigentümergemeinschaft 3) am Rosenweg 9 in Kaiseraugst.

## 📁 Dateien

```
stweg3/
├── index.html                  # Hauptseite STWEG 3
├── stweg3-kontakte.html        # Geschützte Kontaktliste (OTP)
├── admin.html                  # Admin-Bereich (nur Ausschuss)
├── kontakte.json               # Kontaktdaten
├── n8n-otp-workflow.json       # n8n Workflow: OTP senden
├── n8n-save-workflow.json      # n8n Workflow: JSON speichern
└── README.md                   # Diese Datei
```

## 🚀 Quick Start

### Für Bewohner
- **Kontaktliste**: [stweg3-kontakte.html](stweg3-kontakte.html)
- **Anleitung**: Siehe [Wiki - STWEG3 Kontaktliste](../../../wiki/STWEG3-Kontaktliste)

### Für Ausschuss
- **Admin-Bereich**: [admin.html](admin.html)
- **Anleitung**: Siehe [Wiki - STWEG3 Admin](../../../wiki/STWEG3-Admin)

### Für Entwickler
- **n8n Setup**: Siehe [Wiki - n8n OTP-Setup](../../../wiki/n8n-OTP-Setup)
- **Architektur**: Siehe [Wiki - Architektur](../../../wiki/Architektur)

## 🔐 Berechtigungen

Zugriff auf die Kontaktliste haben:
- ✅ Alle Eigentümer (automatisch)
- ✅ Mieter mit `"berechtigt": true` in kontakte.json
- ✅ Ausschussvertreter (automatisch)
- ✅ Hausverwaltung: Alle E-Mails von @langpartners.ch (dynamisch)

## 🛠️ Technologie

- **Frontend**: HTML, Tailwind CSS, Vanilla JS
- **Backend**: n8n Workflows
- **Daten**: JSON (Git-versioniert)
- **Sicherheit**: OTP-Authentifizierung (6-stellig, 10 Min.)

## 📚 Dokumentation

Die vollständige Dokumentation findest du im **[GitHub Wiki](../../../wiki)**:

- [STWEG3 Kontaktliste](../../../wiki/STWEG3-Kontaktliste) - Für Bewohner
- [STWEG3 Admin](../../../wiki/STWEG3-Admin) - Für Ausschuss
- [n8n OTP-Setup](../../../wiki/n8n-OTP-Setup) - Für Entwickler
- [n8n Save-Setup](../../../wiki/n8n-Save-Setup) - Für Entwickler

## 📞 Support

Bei Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
