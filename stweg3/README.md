# STWEG 3 - Rosenweg 9

Webseite und Verwaltungstools für STWEG 3 (Rosenweg 9, 4303 Kaiseraugst)

## Ordnerstruktur

```
stweg3/
├── index.html              # Hauptseite (Einstiegspunkt)
├── pages/                  # Alle Webseiten
│   ├── admin.html          # Admin-Panel
│   ├── stweg3-kontakte.html # Kontaktliste
│   ├── waschkueche-*.html  # Waschküchen-Seiten
│   ├── solaranlage-live.html # Solar-Dashboard
│   └── zaehler.html        # Zählerstand-Erfassung
├── data/                   # JSON-Daten
│   ├── kontakte.json       # Kontaktdaten
│   ├── verteiler.json      # E-Mail-Verteilerlisten
│   └── reservations.json   # Waschküchen-Reservierungen
└── kontakte.json           # Legacy Kontaktdaten
```

## URLs

- **Hauptseite**: `https://rosenweg4303.ch/stweg3/`
- **Kontaktliste**: `https://rosenweg4303.ch/stweg3/pages/stweg3-kontakte.html`
- **Admin**: `https://rosenweg4303.ch/stweg3/pages/admin.html`
- **Waschküche**: `https://rosenweg4303.ch/stweg3/pages/waschkueche-user.html`

## Authentifizierung

Alle geschützten Seiten nutzen **Authentik SSO** (siehe `js/authentik-auth.js`).
Admin-Funktionen erfordern Mitgliedschaft in der Authentik-Gruppe **Technik**.

## Backend

Alle Datenoperationen laufen über die API (`api/server.js`):
- Kontaktverwaltung
- Waschküchen-Reservierungen & Türschloss-Steuerung
- E-Mail-Verteilerlisten
- Zählerstand-Erfassung

## Kontakt

Bei Fragen: stweg3@rosenweg4303.ch
