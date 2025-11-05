# 🧺 Smart Waschküchen-Management System

Ein intelligentes IoT-System zur Energiemessung und Abrechnung von Waschmaschinen und Trocknern für die STWEG 3 im Rosenweg 9, Kaiseraugst.

## 📋 Übersicht

Das Smart Waschküchen-Management System ermöglicht eine faire und transparente Abrechnung der Waschmaschinen- und Trocknernutzung basierend auf dem tatsächlichen Stromverbrauch. Das System verwendet:

- **Shelly Pro 1 PM** IoT-Geräte für präzise Energiemessung
- **USB-Stick/Yubikey** Authentifizierung für sichere Benutzererkennung
- **Automatische Abrechnung** pro kWh Verbrauch
- **Real-time Monitoring** des Gerätestatus
- **Benutzer-Dashboard** für Verbrauchsübersicht

## 🎯 Features

### Für Bewohner
- ✅ Einfache Authentifizierung via USB-Stick oder Yubikey
- ✅ Automatische Freischaltung und Abrechnung der Geräte
- ✅ Echtzeit-Anzeige des aktuellen Verbrauchs
- ✅ Persönliches Dashboard mit Verbrauchshistorie
- ✅ Guthaben-System mit transparenter Abrechnung
- ✅ Live-Status aller Geräte (verfügbar/in Benutzung)

### Für Administratoren
- ✅ Benutzerverwaltung (anlegen, bearbeiten, deaktivieren)
- ✅ Guthaben-Management
- ✅ Detaillierte Statistiken und Reports
- ✅ Export von Abrechnungsdaten (CSV)
- ✅ System-Logs und Monitoring
- ✅ Geräte-Management

## 🏗️ Architektur

```
┌─────────────────┐
│  Waschmaschine  │
│    /Trockner    │
└────────┬────────┘
         │
    ┌────▼─────┐
    │ Shelly   │  Energiemessung & Schaltung
    │ Pro 1 PM │
    └────┬─────┘
         │ WiFi
         │
    ┌────▼──────────┐
    │   Backend     │  Node.js + Express API
    │   SQLite DB   │  Datenbank
    └────┬──────────┘
         │ REST API
         │
    ┌────▼──────────┐
    │   Frontend    │  Web-Dashboard
    │   (Browser)   │
    └───────────────┘
         ▲
         │ USB/Yubikey
    ┌────┴──────────┐
    │   Terminal    │  Raspberry Pi in
    │   (Kiosk)     │  der Waschküche
    └───────────────┘
```

## 📦 Technologie-Stack

### Backend
- **Node.js 18+** - Runtime Environment
- **Express** - Web Framework
- **SQLite3** - Datenbank
- **Axios** - HTTP Client für Shelly API
- **JWT** - Authentifizierung
- **dotenv** - Konfiguration

### Frontend
- **HTML5** - Markup
- **Tailwind CSS** - Styling
- **Vanilla JavaScript** - Interaktivität
- **REST API** - Backend-Kommunikation

### Hardware
- **Shelly Pro 1 PM** - IoT-Schaltgerät mit Energiemessung
- **USB-Sticks/Yubikey** - Hardware-Tokens für Authentifizierung
- **Raspberry Pi** - Terminal in der Waschküche (optional)

## 🚀 Installation

### Voraussetzungen
- Node.js 18+ und npm
- SQLite3
- Shelly Pro 1 PM Geräte installiert und im Netzwerk erreichbar

### 1. Repository klonen
```bash
git clone https://github.com/Rosenweg/Website.git
cd Website/stweg3/waschkueche-smart
```

### 2. Backend einrichten
```bash
cd backend
npm install
cp .env.example .env
# .env Datei bearbeiten und Konfiguration anpassen
```

### 3. Datenbank initialisieren
```bash
# Datenbank-Schema laden
sqlite3 ../database/waschkueche.db < ../database/schema.sql

# Beispieldaten laden (optional, für Tests)
sqlite3 ../database/waschkueche.db < ../database/seed.sql
```

### 4. Shelly-Geräte konfigurieren

Jedes Shelly Pro 1 PM Gerät muss:
1. Im lokalen Netzwerk eingebunden sein
2. Eine statische IP-Adresse oder DHCP-Reservation haben
3. In der `.env` Datei konfiguriert sein

### 5. Backend starten
```bash
npm start

# Oder für Entwicklung mit Auto-Reload:
npm run dev
```

Das Backend läuft auf `http://localhost:3000`

### 6. Frontend bereitstellen

Die Frontend-Dateien sind statische HTML/CSS/JS-Dateien und können direkt über einen Webserver (nginx, Apache) oder einfach über den Dateisystem-Browser geöffnet werden.

Für Produktion mit nginx:
```nginx
server {
    listen 80;
    server_name waschkueche.rosenweg4303.ch;

    root /var/www/waschkueche/frontend;
    index waschkueche-management.html;

    location /api {
        proxy_pass http://localhost:3000;
    }
}
```

## ⚙️ Konfiguration

### Backend (.env)
```env
# Server
PORT=3000
NODE_ENV=production

# Database
DB_PATH=../database/waschkueche.db

# JWT Secret (ändern!)
JWT_SECRET=your-super-secret-key

# Shelly Devices (IP-Adressen)
SHELLY_WASHER_1=192.168.1.101
SHELLY_DRYER_1=192.168.1.102
SHELLY_WASHER_2=192.168.1.103
SHELLY_DRYER_2=192.168.1.104

# Pricing
DEFAULT_KWH_PRICE=0.30
```

### Geräte registrieren

Nach dem ersten Start müssen die Shelly-Geräte registriert werden:

```bash
curl -X POST http://localhost:3000/api/shelly/register
```

Oder manuell in der Datenbank:
```sql
INSERT INTO devices (device_id, device_name, device_type, location, shelly_ip, cost_per_kwh)
VALUES ('shelly-pm-001', 'Waschmaschine 1', 'washer', 'Waschküche 1', '192.168.1.101', 0.30);
```

## 👤 Benutzerverwaltung

### Neuen Benutzer anlegen

Via API (empfohlen):
```bash
curl -X POST http://localhost:3000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{
    "user_token": "USB-001-EG1",
    "wohnung": "EG.1",
    "name": "Max Mustermann",
    "email": "max@example.com",
    "initial_balance": 50.00
  }'
```

Via SQL:
```sql
INSERT INTO users (user_token, wohnung, name, email, balance)
VALUES ('USB-001-EG1', 'EG.1', 'Max Mustermann', 'max@example.com', 50.00);

INSERT INTO auth_tokens (user_id, token_identifier, token_type)
VALUES (1, 'USB-001-EG1', 'usb');
```

### Guthaben aufladen

```bash
curl -X POST http://localhost:3000/api/admin/users/1/adjust-balance \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50.00,
    "reason": "Guthabenaufladung per Überweisung"
  }'
```

## 📊 API-Endpunkte

### Authentifizierung
- `POST /api/auth/login` - Login mit USB-Token
- `POST /api/auth/logout` - Logout
- `GET /api/auth/verify` - Token verifizieren

### Geräte
- `GET /api/devices` - Alle Geräte mit Live-Status
- `GET /api/devices/:id` - Einzelnes Gerät
- `GET /api/devices/:id/status` - Echtzeit-Status
- `GET /api/devices/:id/history` - Nutzungshistorie

### Sessions
- `POST /api/sessions/start` - Session starten
- `POST /api/sessions/:id/stop` - Session beenden
- `GET /api/sessions/active` - Aktive Sessions
- `GET /api/sessions/user/:userId` - Benutzer-Sessions

### Benutzer
- `GET /api/users/:id` - Benutzer-Profil
- `GET /api/users/:id/balance` - Guthaben
- `POST /api/users/:id/topup` - Guthaben aufladen
- `GET /api/users/:id/transactions` - Transaktionen
- `GET /api/users/:id/stats` - Statistiken

### Admin
- `GET /api/admin/users` - Alle Benutzer
- `POST /api/admin/users` - Benutzer erstellen
- `PUT /api/admin/users/:id` - Benutzer aktualisieren
- `POST /api/admin/users/:id/adjust-balance` - Guthaben anpassen
- `GET /api/admin/sessions` - Alle Sessions
- `GET /api/admin/stats` - Gesamt-Statistiken
- `GET /api/admin/export/sessions` - CSV-Export

### Shelly
- `POST /api/shelly/register` - Geräte registrieren
- `GET /api/shelly/status` - Alle Gerätestatus
- `GET /api/shelly/:deviceId/info` - Geräteinformationen

## 🔐 Sicherheit

- Alle API-Endpunkte (außer Login) erfordern JWT-Authentifizierung
- USB-Token/Yubikey als Hardware-basierte Authentifizierung
- Keine Speicherung von Passwörtern
- Lokale Datenhaltung (keine Cloud)
- SQLite-Datenbank mit regelmäßigen Backups
- HTTPS in Produktion empfohlen

## 📈 Monitoring & Wartung

### Logs
```bash
# Backend-Logs
tail -f backend/logs/app.log

# Admin-Logs
sqlite3 database/waschkueche.db "SELECT * FROM admin_logs ORDER BY timestamp DESC LIMIT 50;"
```

### Backups
```bash
# Datenbank-Backup
cp database/waschkueche.db "database/backups/waschkueche-$(date +%Y%m%d).db"

# Automatisches Backup (Cron)
0 2 * * * cp /path/to/waschkueche.db /path/to/backup/waschkueche-$(date +\%Y\%m\%d).db
```

### Health Check
```bash
curl http://localhost:3000/api/health
```

## 🛠️ Troubleshooting

### Backend startet nicht
- Prüfen Sie die `.env` Datei
- Stellen Sie sicher, dass Port 3000 nicht belegt ist
- Überprüfen Sie die Datenbank-Verbindung

### Shelly-Geräte nicht erreichbar
- Überprüfen Sie die IP-Adressen in der `.env`
- Testen Sie die Erreichbarkeit: `ping 192.168.1.101`
- Prüfen Sie die Shelly-Weboberfläche: `http://192.168.1.101`

### Benutzer kann sich nicht anmelden
- Prüfen Sie, ob der Token in der Datenbank existiert
- Prüfen Sie, ob der Benutzer aktiv ist (`is_active = 1`)
- Überprüfen Sie die `auth_tokens` Tabelle

### Gerät schaltet nicht
- Prüfen Sie den Shelly-Status über die API
- Testen Sie manuell über die Shelly-Weboberfläche
- Überprüfen Sie die Verkabelung

## 📱 Terminal-Setup (Kiosk-Modus)

Für ein Terminal in der Waschküche (z.B. Raspberry Pi):

### 1. Chromium im Kiosk-Modus
```bash
# /home/pi/.config/autostart/kiosk.desktop
[Desktop Entry]
Type=Application
Name=Kiosk
Exec=chromium-browser --kiosk --incognito http://localhost/waschkueche-management.html
X-GNOME-Autostart-enabled=true
```

### 2. USB-Reader-Integration
```bash
# USB-Events überwachen
sudo apt-get install udev

# USB-Rule erstellen
sudo nano /etc/udev/rules.d/99-usb-reader.rules
```

## 📄 Lizenz

Dieses Projekt wurde für die STWEG 3 im Rosenweg 9, Kaiseraugst entwickelt.

## 🤝 Support

Bei Fragen oder Problemen:

**Technischer Support:**
- E-Mail: technik@rosenweg4303.ch
- Stefan Müller: +41 76 519 99 70

**Hausverwaltung:**
- LangPartners Immobilien AG
- Tel: +41 61 228 18 18
- E-Mail: hello@langpartners.ch

## 📝 Changelog

### Version 1.0.0 (Januar 2025)
- ✨ Initiales Release
- 🚀 Shelly Pro 1 PM Integration
- 🔐 USB/Yubikey Authentifizierung
- 📊 Benutzer- und Admin-Dashboard
- 💰 Automatische Abrechnung pro kWh
- 📱 Responsive Web-Interface

---

Entwickelt mit ❤️ für die STWEG 3 Gemeinschaft
