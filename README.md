# STWEG-Kooperation Rosenweg - Website

Willkommen zum Repository der STWEG-Kooperation Rosenweg Website!

## 🏠 Über das Projekt

Diese Website dient der STWEG-Kooperation Rosenweg in Kaiseraugst, Aargau. Sie bietet:

- **Informationen** über alle 8 STWEGs (7 Wohngebäude + 1 Tiefgarage)
- **Geschützte Kontaktliste** für STWEG 3 Bewohner (OTP-gesichert)
- **Admin-Bereich** für Ausschussvertreter zur Datenpflege
- **Ausschuss-Kontakte** für die gesamte Kooperation

## 📚 Dokumentation

Die vollständige Dokumentation findest du im **[GitHub Wiki](../../wiki)**:

### Für Bewohner & Eigentümer
- [STWEG 3 - Kontaktliste nutzen](../../wiki/STWEG3-Kontaktliste)
- [FAQ](../../wiki/FAQ)

### Für Ausschussvertreter
- [STWEG 3 - Admin-Bereich](../../wiki/STWEG3-Admin)
- [Kontakte verwalten](../../wiki/Kontakte-Verwalten)

### Für Entwickler
- [Architektur](../../wiki/Architektur)
- [n8n OTP-Setup](../../wiki/n8n-OTP-Setup)
- [n8n Save-Setup](../../wiki/n8n-Save-Setup)
- [Deployment](../../wiki/Deployment)

## 🚀 Quick Start

### Entwicklung lokal

```bash
# Repository klonen
git clone https://github.com/IHR_USERNAME/Rosenweg.git
cd Rosenweg/Website/Website

# Mit lokalem Server öffnen (z.B. Python)
python3 -m http.server 8000

# Browser öffnen
open http://localhost:8000
```

### n8n Workflows einrichten

Siehe [n8n OTP-Setup](../../wiki/n8n-OTP-Setup) im Wiki.

### Deployen

Siehe [Deployment](../../wiki/Deployment) im Wiki.

## 📁 Struktur

```
Website/Website/
├── index.html              # Hauptseite (alle STWEGs)
├── ausschuss.html          # Ausschuss-Kontakte
├── ausschuss-kontakte.json # Ausschuss-Daten
├── stweg1/                 # STWEG 1 (Platzhalter)
├── stweg2/                 # STWEG 2 (Platzhalter)
├── stweg3/                 # STWEG 3 (vollständig)
│   ├── index.html          # STWEG 3 Infoseite
│   ├── stweg3-kontakte.html # Geschützte Kontaktliste
│   ├── admin.html          # Admin-Bereich
│   ├── kontakte.json       # Kontaktdaten
│   ├── n8n-otp-workflow.json   # n8n OTP Workflow
│   └── n8n-save-workflow.json  # n8n Save Workflow
├── stweg4-8/               # STWEGs 4-8 (Platzhalter)
└── wiki/                   # Wiki-Dokumentation
```

## 🔐 Sicherheit

- **OTP-Authentifizierung** für sensible Bereiche
- **Frontend-Validierung** von E-Mail-Adressen
- **Backend-Filter** für `.invalid` Platzhalter
- **Git-Versionierung** aller Änderungen
- **Audit-Trail** durch Commit-Messages

## 🛠️ Technologie-Stack

- **Frontend**: HTML, Tailwind CSS, Vanilla JavaScript
- **Backend**: n8n Workflows (Serverless Automation)
- **Hosting**: GitHub Pages
- **Datenbank**: JSON-Dateien (Git-versioniert)
- **E-Mail**: SMTP via n8n

## 📞 Support

Bei technischen Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70

## 📜 Lizenz

Dieses Projekt ist für die STWEG-Kooperation Rosenweg bestimmt.

---

**Hinweis**: Die detaillierte Dokumentation befindet sich im [GitHub Wiki](../../wiki). Dort findest du Setup-Anleitungen, Best Practices und Troubleshooting-Guides.
