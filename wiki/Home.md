# STWEG-Kooperation Rosenweg - Dokumentation

Willkommen zur technischen Dokumentation der STWEG-Kooperation Rosenweg Website!

## 🏠 Über die STWEG-Kooperation Rosenweg

Die STWEG-Kooperation Rosenweg besteht aus 8 Stockwerkeigentümergemeinschaften (STWEGs) am Rosenweg in Kaiseraugst, Aargau.

- **STWEG 1-7**: Wohngebäude
- **STWEG 8**: Tiefgarage (Einstellhalle)
- **Gesamt**: 15 Ausschussmitglieder

**Website**: https://rosenweg4303.ch

## 📚 Dokumentation nach Zielgruppe

### 👥 Für Bewohner & Eigentümer

Dokumentation für alle Bewohner der STWEG-Kooperation:

- **[STWEG 3 - Kontaktliste nutzen](STWEG3-Kontaktliste)** - Zugriff auf geschützte Kontaktdaten
- **[Organisationsstruktur](Organisationsstruktur)** - Aufbau der Kooperation, Ausschuss, Verwaltung
- **[FAQ](FAQ)** - Häufig gestellte Fragen

### 👨‍💼 Für Ausschussvertreter

Anleitungen für die Verwaltung und Administration:

- **[STWEG 3 - Admin-Bereich](STWEG3-Admin)** - Kontaktdaten bearbeiten
- **[Kontakte verwalten](Kontakte-Verwalten)** - Berechtigungen für Mieter erteilen
- **[n8n Save-Setup](n8n-Save-Setup)** - Backend für Datenspeicherung

### 💻 Für Entwickler & Technischer Dienst

Technische Dokumentation für Wartung und Weiterentwicklung:

**Setup & Deployment:**
- **[Wiki einrichten](WIKI-SETUP)** - GitHub Wiki aufsetzen
- **[n8n OTP-Setup](n8n-OTP-Setup)** - OTP E-Mail-Versand konfigurieren
- **[n8n Save-Setup](n8n-Save-Setup)** - JSON-Speicherung via GitHub
- **[Deployment](Deployment)** - Website deployen

**Dokumentation:**
- **[Architektur](Architektur)** - Technischer Überblick
- **[API-Referenz](API-Referenz)** - API-Dokumentation

## 🚀 Schnellstart

### Als Eigentümer/Mieter (STWEG 3)

1. Öffne [STWEG 3 Kontaktliste](https://rosenweg4303.ch/stweg3/stweg3-kontakte.html)
2. Gib deine E-Mail-Adresse ein
3. Gib den OTP-Code aus deiner E-Mail ein
4. ✅ Zugriff auf alle Kontakte!

**Detaillierte Anleitung**: [STWEG3 Kontaktliste](STWEG3-Kontaktliste)

### Als Ausschussvertreter (STWEG 3)

1. Öffne [STWEG 3 Admin](https://rosenweg4303.ch/stweg3/admin.html)
2. Authentifiziere dich mit deiner Ausschuss-E-Mail
3. Bearbeite Kontaktdaten über Formular oder JSON-Editor
4. ✅ Speichere die Änderungen

**Detaillierte Anleitung**: [STWEG3 Admin](STWEG3-Admin)

### Als Entwickler

1. Clone das Repository
   ```bash
   git clone https://github.com/USERNAME/Rosenweg.git
   ```
2. Lies die [Architektur](Architektur)-Dokumentation
3. Richte [n8n Workflows](n8n-OTP-Setup) ein
4. Deploye nach [Deployment-Anleitung](Deployment)

## 🔐 Sicherheit

Alle sensiblen Bereiche sind durch **OTP-Authentifizierung** geschützt:

- 🔢 **6-stelliger Code** per E-Mail
- ⏱️ **10 Minuten** Gültigkeit
- ✅ **Nur berechtigte** E-Mail-Adressen
- 🔒 **Keine Passwörter** zu merken

**Technische Details**: [n8n OTP-Setup](n8n-OTP-Setup)

## 🛠️ Technologie-Stack

| Komponente | Technologie |
|------------|-------------|
| **Frontend** | HTML, Tailwind CSS, Vanilla JavaScript |
| **Backend** | n8n Workflows (Serverless Automation) |
| **Hosting** | GitHub Pages |
| **Datenbank** | JSON-Dateien (Git-versioniert) |
| **E-Mail** | SMTP via n8n |
| **Authentifizierung** | OTP (One-Time Password) |

## 🏗️ Projektstruktur

```
Website/Website/
├── index.html                  # Hauptseite (alle STWEGs)
├── ausschuss.html              # Ausschuss-Kontakte
├── ausschuss-kontakte.json     # Ausschuss-Daten
├── stweg1/                     # STWEG 1 (Platzhalter)
├── stweg2/                     # STWEG 2 (Platzhalter)
├── stweg3/                     # STWEG 3 (vollständig)
│   ├── index.html              # STWEG 3 Infoseite
│   ├── stweg3-kontakte.html    # Geschützte Kontaktliste
│   ├── admin.html              # Admin-Bereich
│   ├── kontakte.json           # Kontaktdaten
│   ├── n8n-otp-workflow.json   # n8n OTP Workflow
│   └── n8n-save-workflow.json  # n8n Save Workflow
└── stweg4-8/                   # STWEGs 4-8 (Platzhalter)
```

## 📊 Features

### STWEG 3 - Vollständige Integration

- ✅ **Geschützte Kontaktliste** mit OTP-Authentifizierung
- ✅ **Admin-Bereich** für Ausschussvertreter
- ✅ **Automatische Berechtigungen** für Eigentümer
- ✅ **Manuelle Berechtigungen** für Mieter
- ✅ **Hausverwaltungs-Zugang** (dynamisch via Domain)
- ✅ **Audit-Trail** (alle Änderungen in Git)

### Alle STWEGs

- ✅ **Ausschuss-Kontakte** auf zentraler Seite
- ✅ **Einzelseiten** für jede STWEG
- ✅ **Responsive Design** (Mobile & Desktop)
- ✅ **Barrierefreie** Navigation

## 📞 Support

Bei technischen Problemen:

### Technischer Dienst Rosenweg

**E-Mail**: technik@rosenweg9.ch

Für vollständige Kontaktdaten und Berechtigungen siehe: [technischer-dienst.json](../technischer-dienst.json)

**Mitglieder**:
- Stefan Müller (STWEG 3)
- Andreas Debona (STWEG 3)
- Rolf Müller (extern)

### Hausverwaltung

**LangPartners Immobilien AG**
- Adresse: Kirchplatz 18, 4132 Muttenz
- Telefon: +41 61 228 18 18
- E-Mail: hello@langpartners.ch
- Website: https://langpartners.ch
- Öffnungszeiten: Mo-Fr, 09:00-12:00 Uhr

### Ausschuss-Präsident

**Jörg Herrmann** (STWEG 2)
- E-Mail: jherrmann@gmx.ch
- Telefon: +41 79 727 13 78

## 🔄 Wiki beitragen

Dieses Wiki ist ein GitHub Wiki und kann von berechtigten Personen bearbeitet werden.

### Wiki bearbeiten

**Direkt auf GitHub:**
1. Klicke auf eine Wiki-Seite
2. Klicke auf "Edit" (Stift-Icon)
3. Mache deine Änderungen
4. Klicke auf "Save Page"

**Lokal bearbeiten:**
```bash
# Wiki klonen
git clone https://github.com/USERNAME/Rosenweg.wiki.git
cd Rosenweg.wiki

# Datei bearbeiten
nano Home.md

# Push
git add .
git commit -m "Update documentation"
git push
```

**Mehr Details**: [WIKI-SETUP](WIKI-SETUP)

## 📝 Changelog

### November 2025
- ✨ Initiale Wiki-Dokumentation
- ✨ STWEG 3 Admin-Bereich implementiert
- ✨ OTP-Authentifizierung für Kontaktliste
- ✨ Dynamische Hausverwaltungs-Berechtigung
- ✨ n8n Workflows für OTP & Speicherung

---

**Hinweis**: Dieses Wiki wird kontinuierlich erweitert. Weitere Seiten für andere STWEGs folgen bei Bedarf.
