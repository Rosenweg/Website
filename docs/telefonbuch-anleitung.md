# Telefonbuch & Kontakte-Sync — Anleitung

Das interne Verzeichnis der Rosenweg-Kooperation gibt es an zwei Orten: als Seite
auf der Website und — automatisch gespiegelt — im Adressbuch von Handy und
Mail-Programm.

---

## Teil 1 — Telefonbuch auf der Website

**<https://www.rosenweg4303.ch/telefonbuch.html>** — sichtbar für **jeden
eingeloggten Benutzer**, keine besondere Gruppe nötig.

### Bedienung

- **Suchen:** Das Feld oben filtert live über Name, STWEG und Wohnung.
- **Anrufen:** Klick auf die Nummer startet den Anruf (auf dem Handy) bzw. öffnet
  die Telefon-App.
- **Mailen:** Klick auf die Adresse öffnet das Mail-Programm.
- **⬇ Excel:** exportiert die aktuelle Liste als Tabelle.

### Was in der Liste steht

Die Einträge kommen aus den Wohnungs-Kontakten der Objektverwaltung und werden
**pro Person zusammengefasst**: Wem mehrere Wohnungen gehören, der steht trotzdem
nur einmal drin, mit allen Wohnungen und Rollen (Eigentümer, Mieter, Verwalter)
darunter. Sortiert wird nach Nachname.

**Verstorbene** bleiben mit durchgestrichenem Namen sichtbar — bewusst, damit
Recherchen in alten Vorgängen noch aufgehen.

### Als App aufs Handy

Die Seite ist eine PWA. Im Browser das Menü öffnen und **„Zum Startbildschirm
hinzufügen"** wählen — danach startet das Telefonbuch als eigenständige App.

### Wenn ein Eintrag falsch ist

Das Telefonbuch selbst hat kein Bearbeiten. Korrekturen laufen über die
**Objektverwaltung** (Wohnung → Kontakte) und schlagen dort sofort durch. Der
Ausschuss der jeweiligen STWEG darf das für die eigene STWEG, die Technik für
alle.

---

## Teil 2 — Kontakte-Sync

Einmal täglich wird das Verzeichnis aus der Datenbank in drei Ziele geschrieben,
damit die Nummern im Handy-Adressbuch und in den Mail-Programmen stehen:

| Ziel | Was landet dort |
|---|---|
| **Nextcloud** — Adressbuch `rosenweg` | Vollständiges Verzeichnis |
| **SOGo** — persönliche Bücher von `inbox@` und `präsident@` | Vollständiges Verzeichnis, zusätzlich zu den privaten Kontakten |
| **Z-Push** (CT 115) | Quelle für die Handy-Synchronisation per Exchange/ActiveSync |

Synchronisiert werden alle Personen aus der Datenbank, die aktive Verwaltung mit
ihren Mitarbeitern sowie der Sammelkontakt **„Rosenweg"** mit der Nummer der
Telefonzentrale.

### Handy einrichten

Die Schritt-für-Schritt-Anleitung für Bewohner steht auf der Website unter
[hilfe.html → Rosenweg-Verzeichnis aufs Handy](../hilfe.html#kontakte-sync). Kurz:
Konto vom Typ **Exchange** (iPhone: „Microsoft Exchange", manuell konfigurieren)
mit dem normalen Rosenweg-Login anlegen. Es ist ein reines Kontakte-Konto, kein
Postfach.

### Wann er läuft

Täglich um **04:30 UTC**, mit bis zu 10 Minuten zufälliger Verzögerung. Verpasste
Läufe (Container war aus) werden nachgeholt.

Der Sync läuft in **CT 201** (`100.64.2.24`) als systemd-Timer.

### Von Hand anstossen

```bash
ssh root@100.64.2.24
python3 /usr/local/bin/contacts-sync.py

systemctl status contacts-sync.timer     # wann lief er zuletzt, wann wieder
journalctl -u contacts-sync -n 100       # Log des letzten Laufs
```

### Warum es keine Dubletten gibt

Jeder Kontakt bekommt eine aus dem Namen abgeleitete, immer gleiche Kennung.
Läuft der Sync zweimal, wird derselbe Eintrag aktualisiert statt ein zweiter
angelegt — auch wenn der Kontakt ursprünglich von Hand importiert wurde.

### Was gelöscht wird — und was nicht

- **Nextcloud und Z-Push:** Wer aus der Datenbank verschwindet, verschwindet auch
  dort. Das sind eigene, ausschliesslich vom Sync verwaltete Sammlungen.
- **SOGo:** wird **nur ergänzt und aktualisiert, nie gelöscht**. Sonst würde der
  Sync die *privaten* Kontakte von `inbox@` und `präsident@` mit abräumen. Wer
  dort einen alten Rosenweg-Kontakt loswerden will, muss ihn von Hand löschen.

---

## Störungen

| Symptom | Ursache | Was tun |
|---|---|---|
| Telefonbuch-Seite bleibt leer | Nicht angemeldet oder API nicht erreichbar | Neu anmelden; die Seite zeigt sonst „Fehler: HTTP …" |
| Eine Person fehlt | Kein Name oder keine Wohnungs-Zuordnung in der Objektverwaltung | Kontakt bei der Wohnung nachtragen |
| Neue Nummer nicht im Handy | Sync läuft nur einmal täglich | Von Hand anstossen (siehe oben), dann am Handy synchronisieren |
| Alte Kontakte bleiben im Mail-Programm | SOGo löscht nicht | Von Hand löschen |
| Sync läuft, aber ein Ziel bleibt leer | Zugangsdaten in `/root/.contacts-sync.env` abgelaufen | `journalctl -u contacts-sync` zeigt, welches Ziel fehlschlägt |

Die Zugangsdaten für die drei Ziele liegen in `/root/.contacts-sync.env` (Rechte
`0600`) und sind bewusst **nicht** im Repository.

---

## Verwandt

- [Telefonie-Übersicht](telefonie.md)
- [Telefonanlage](telefonanlage-anleitung.md) — nutzt dieselben Daten für die
  Anrufer-Namensanzeige
