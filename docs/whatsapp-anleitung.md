# WhatsApp — Anleitung

Zwei Dinge laufen über dieselbe WhatsApp-Nummer und dieselbe Bridge:

- **Der Bot** — Bewohner schreiben der Nummer, der Bot antwortet mit Menü,
  Handwerker-Nummern, Auslagen-Status und nimmt Schadensmeldungen auf.
- **Das Gateway** — die Systeme schicken *raus*: Voicemail-Zusammenfassungen,
  Reklamations-Pushes, Broadcasts an Bewohner, weitergeleitete E-Mails.

Beides zusammen läuft in **CT 116** (`whatsapp-bridge`, `100.64.2.39`) als
Docker-Compose-Stack. Aufbau und Verkabelung: [whatsapp-bot/lxc/README.md](../whatsapp-bot/lxc/README.md).

---

## Teil 1 — Der Bot (für Bewohner)

### Loslegen

1. Die Nummer der Telefonzentrale als Kontakt speichern.
2. Irgendeine Begrüssung schicken: `hi`, `hallo`, `grüezi`, `moin` — oder `menu`.
3. Es kommt ein Menü mit den Ziffern 1–6. Antworten kann man mit der **Ziffer**
   oder direkt mit einem Befehl.

Der Bot erkennt Bewohner an der **Telefonnummer**, die in der Personen-Datenbank
hinterlegt ist. Fehlt sie oder ist der WhatsApp-Opt-In nicht gesetzt, antwortet er
nur allgemein und kann keine persönlichen Daten zeigen. Die Nummer pflegt man im
Profil auf der Website oder der Ausschuss trägt sie nach.

### Befehle

| Befehl | Was passiert |
|---|---|
| `/menu` | Hauptmenü mit Ziffernauswahl |
| `/notfall` | Notfall-Kontakte: Polizei, Feuerwehr, Sanität, Vergiftung |
| `/handwerker` | Handwerker nach Kategorien gruppiert |
| `/handwerker <kategorie>` | Gefiltert, z.B. `/handwerker sanitaer` — nach Bewertung sortiert |
| `/reklamation <text>` | Schaden melden, geht an den Ausschuss der eigenen STWEG |
| `/meineauslagen` | Status der eigenen Auslagen (eingereicht / genehmigt / ausbezahlt) |
| `/hilfe` | Diese Liste |

Statt eines Befehls kann man auch einfach in eigenen Worten beschreiben, was man
braucht, oder **ein Foto** vom Schaden mit Beschreibung als Bildunterschrift
schicken.

Eine Reklamation über den Bot löst dieselbe Kette aus wie das Formular auf der
Website: E-Mail und WhatsApp-Push an den Ausschuss der betroffenen STWEG, und der
Melder bekommt jeden Statuswechsel mit.

---

## Teil 2 — Das Gateway (für Technik und Präsident)

**<https://whatsapp.rosenweg4303.ch>** — Anmeldung mit Rosenweg-Login. Zugriff hat,
wer Admin ist oder in der Authentik-Gruppe `technik` bzw. `präsident` steht.

Die Oberfläche hat diese Reiter:

| Reiter | Wofür |
|---|---|
| **Verbindung / Pairing** | QR-Code, Verbindungsstatus. Erscheint nur, wenn die Session nicht gepairt ist |
| **Weiterleitungen** | Regeln, welche eingehenden Chats als E-Mail rausgehen |
| **Senden** | Einzelnachricht an Nummer, Gruppe oder Alias |
| **📢 Broadcast** | Massennachricht an Bewohner mit Opt-In |
| **Nachrichten** | Verlauf der über das Gateway gelaufenen Nachrichten, einzeln löschbar |
| **Gruppen** | Alle WhatsApp-Gruppen, in denen die Nummer Mitglied ist |
| **E-Mail→WA** | Absender- und IP-Allowlist für den Mail-Eingang |
| **Aliase** | Kurznamen wie `technik` → Gruppe oder Nummer |
| **API-Keys** | Schlüssel für andere Systeme |

### Broadcast an Bewohner

Zielgruppe wählen (alle Opt-In-Personen, eine einzelne STWEG, MEG, Technik,
Ausschuss, Eigentümer, Bewohner oder Verwaltung), Text schreiben, dann **erst
„Empfänger zählen"** — die Zahl steht danach da und man weiss, was man gleich
auslöst. Erst dann **Senden**.

Es gehen ausschliesslich Personen mit gesetztem WhatsApp-Opt-In raus. Wer keinen
Opt-In hat, wird stillschweigend übersprungen und taucht auch in der Zählung
nicht auf.

### Aliase

Ein Alias bildet einen Kurznamen auf ein Ziel ab, damit andere Systeme keine
Gruppen-IDs kennen müssen. Ziel-Typen: **Nummer**, **Gruppe** (über den
Gruppennamen aufgelöst) oder **JID** (die interne WhatsApp-Adresse).

Der Alias `Rosenweg Technik` ist der, auf den die Voicemail-Auswertung der
Telefonanlage sendet. Wird die Gruppe umbenannt oder der Alias gelöscht, kommen
die Voicemail-Zusammenfassungen ohne Fehlermeldung nicht mehr an.

### API-Keys

Andere Systeme senden über `POST /gateway/send` mit einem Key (`mg_…`). Bestehende
Keys sind unter **API-Keys** gelistet und einzeln löschbar.

Aktuell im Einsatz: der Key `pbx-voicemail` für die Telefonanlage. Er steht dort
als `GATEWAY_API_KEY` in `/etc/default/pbx-api`. Wer den Key im Gateway löscht,
muss ihn dort auch ersetzen — sonst bricht die Voicemail-Zustellung.

### E-Mail → WhatsApp

Der Gateway nimmt auf Port 2525 Mails an und schickt sie als WhatsApp-Nachricht
weiter. Der Weg ist doppelt abgesichert: Der Port ist per Firewall nur für den
Mail-Gateway freigegeben, und im Reiter **E-Mail→WA** stehen zusätzlich eine
Absender- und eine IP-Allowlist. Beide lassen sich einzeln scharf schalten.

Umgekehrt können eingehende WhatsApp-Chats über **Weiterleitungen** als E-Mail
zugestellt werden — Antworten auf diese Mail gehen zurück in den Chat.

---

## Pairing (wenn die Verbindung weg ist)

Die WhatsApp-Session lebt im Docker-Volume `whatsapp-bot_whatsapp-data`. Solange
das Volume da ist, übersteht die Verbindung Neustarts und sogar den
HA-Failover des Containers (getestet, rund 48 Sekunden, ohne neues Pairing).

Ist die Session verloren, zeigt der Reiter **Verbindung / Pairing** einen QR-Code:

1. Auf dem Smartphone mit der Rosenweg-Nummer WhatsApp öffnen.
2. Einstellungen → **Verknüpfte Geräte** → **Gerät verknüpfen**.
3. Den QR-Code abscannen.

Alternativ steht der QR-Code als ASCII-Code im Container-Log:

```bash
ssh root@100.64.2.39
docker compose -f /opt/whatsapp-bot/compose.yml logs -f
```

Erfolg sieht im Log so aus: `[WA] Bot ist bereit, Nummer: 41…`

---

## Betrieb

**Neue Version einspielen** (CI baut das Image automatisch):

```bash
ssh root@100.64.2.39
cd /opt/whatsapp-bot && docker compose pull && docker compose up -d
```

**Gesundheitscheck:** `GET https://whatsapp.rosenweg4303.ch/gateway/health` —
braucht keinen Login und sagt, ob die WhatsApp-Verbindung steht.

---

## Störungen

| Symptom | Ursache | Was tun |
|---|---|---|
| Nichts geht raus oder rein | Session ausgeloggt | Reiter **Verbindung / Pairing** — steht dort ein QR-Code, neu pairen |
| Voicemail-Zusammenfassungen kommen nicht an | Alias `Rosenweg Technik` fehlt oder der API-Key wurde gelöscht | Reiter **Aliase** und **API-Keys** prüfen, dann `journalctl -u pbx-api -f` in CT 220 |
| Bot antwortet nur allgemein | Nummer nicht in der Personen-DB oder kein Opt-In | Nummer im Profil ergänzen, Opt-In setzen |
| Broadcast erreicht weniger Leute als erwartet | Nur Opt-In-Personen bekommen ihn | Vorher „Empfänger zählen" — die Zahl ist die Wahrheit |
| Mails kommen nicht als WhatsApp an | Absender oder IP nicht auf der Allowlist | Reiter **E-Mail→WA** |
| Container läuft, aber nichts reagiert | Chromium-Prozess hängt | `docker compose restart` in `/opt/whatsapp-bot` |

---

## Gut zu wissen

- **Die Library ist inoffiziell.** `whatsapp-web.js` steuert WhatsApp Web fern und
  verstösst formal gegen die Nutzungsbedingungen. Beim Volumen einer STWEG ist das
  in der Praxis unproblematisch, aber die Nummer kann theoretisch gesperrt werden.
  Deshalb: keine unnötigen Massen-Broadcasts.
- **Ein Geräte-Slot.** Die Nummer belegt einen der „Verknüpfte Geräte"-Plätze und
  kann auf dem Handy parallel ganz normal weiterbenutzt werden.
- **Rollback.** Der alte Swarm-Service `rosenweg_whatsapp-bot` steht noch mit
  `scale=0` bereit, falls CT 116 ausfällt — Details im LXC-README.

---

## Verwandt

- [Telefonanlage](telefonanlage-anleitung.md) — schickt die Voicemail-Auswertung hierher
- [Telefonie-Übersicht](telefonie.md)
- Bewohner-Kurzfassung: [hilfe.html → WhatsApp-Bot](../hilfe.html#whatsapp)
