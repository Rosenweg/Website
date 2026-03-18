# Rosenweg Kiosk Config (Private Repository)

Dieses Repository enthält sensible Konfiguration und Logs für das Kiosk-System.

## Struktur

```
├── config.json          # Kiosk-Konfiguration (Passwörter, WLAN, etc.)
└── logs/                # Kiosk-Logs (automatisch gepusht)
    └── rosenweg-kiosk/
```

## Setup

1. Dieses Repo als **privates** GitHub Repository erstellen: `Rosenweg/kiosk-config`
2. `config.json` anpassen (Passwörter etc.)
3. Deploy Key generieren:
   ```bash
   ssh-keygen -t ed25519 -f deploy-key -N "" -C "rosenweg-kiosk"
   ```
4. Public Key als Deploy Key in GitHub hinzufügen (Settings > Deploy Keys, "Allow write access" aktivieren)
