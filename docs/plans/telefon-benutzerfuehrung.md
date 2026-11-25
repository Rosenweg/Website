# Plan: Benutzerführung Telefon – „Mein Telefon“ und „Telefonanlage“

Stand 25.11.2026, Entwurf zur Durchsicht mit Stefan. **Noch nichts davon ist gebaut.**
Baut auf [telefon-nummernplan.md](telefon-nummernplan.md) auf (dort Schritt 6 „Mein Profil im Web“).

## Ziel

Heute ist das Telefon auf drei Orte verteilt, und die Aufteilung folgt der Technik:

| Ort | Für wen | Was dort ist |
|---|---|---|
| `pbx.rosenweg4303.ch` (PBX-Admin) | Technik | Amt, Geschäftszeiten, Ring-Group, SIP-Telefone, geteilte Telefone, Konferenz, Anrufliste |
| `rosenweg4303.ch/smartphones` | alle, Teile nur Technik | Anmelde-QR, eigene Sitzungen, geteilte Telefone, eigene Handys, App-Katalog, Verlauf |
| Rosenweg Telefon (App) | alle | Anmelden, Verlauf, Voicemail anhören |

Probleme:

- Eine Person findet nirgends ihre **Weiterleitung** und **Voicemail an/aus**. Beides steht nur in der
  Datenbank (`personen_nummern`); einstellen kann es heute nur, wer direkt auf CT 220 arbeitet.
- Wer ein **eigenes SIP-Telefon** hat, kann es nicht einrichten.
- Für die Technik ist dieselbe Sache an zwei Orten (geteilte Telefone in PBX-Admin **und** /smartphones).
- Gruppen und Dienste sind fest verdrahtet (eine Ring-Group, die Amtsnummer = Dienst Technik).

Neu: **zwei Seiten, nach Rolle getrennt**, beide auf der Website mit Rosenweg-Anmeldung.
Grundsatz: **Jede Nummer ist ein Ding, das man öffnet.** Wer etwas sucht, fängt bei der Nummer an.

## Begriffe

| Begriff | Nummern | Was es ist |
|---|---|---|
| **Person** | 3HHWWP | ein Mensch im Rosenweg; seine Nummer klingelt auf allen seinen Geräten |
| **Gerät** | 21XX bzw. Zugang `<nummer>-p<id>` | etwas, das klingelt: geteiltes Telefon, Rosenweg Telefon auf dem Handy, SIP-Telefon |
| **Gruppe** | 1XXX | mehrere Personen/Geräte, die zusammen klingeln (1000 = Technik) |
| **Dienst** | 2000–2099 | eine Aufgabe mit Regeln: Zeiten, welche Gruppe, was ausserhalb der Zeiten passiert (2000 = Technik) |
| **Verwaltung** | 4XXX | externe Festnetznummern (4000 = Immosense) |
| **Amt** | Amtsnummer | Anrufe von aussen; führt auf einen Dienst (heute 2000) |

## Seite 1: „Mein Telefon“ (`rosenweg4303.ch/mein-telefon`), für jede Person

Sichtbar für alle, die angemeldet sind **und** eine persönliche Nummer haben. Ohne Nummer: kurzer
Hinweis, wen man fragen kann.

```
┌ Mein Telefon ───────────────────────────────────────────────┐
│ Deine Nummer  309093   Stefan Müller · Haus 9, Wohnung 09   │
│ So erreicht man dich: intern 309093, von aussen über …       │
├ Meine Geräte ───────────────────────────────── [+ Gerät] ───┤
│ ● Rosenweg Telefon · Galaxy A37        seit 24.11.  [Entfernen]│
│ ● SIP-Telefon · Büro (Yealink)         angemeldet   [Entfernen]│
│ ○ Rosenweg Smartphone 2 (2102)         jetzt angemeldet [Abmelden]│
├ Erreichbarkeit ─────────────────────────────────────────────┤
│ Weiterleitung  ( ) aus  ( ) immer  (•) wenn nicht erreichbar │
│                nach [20] s an [+41 79 …]                     │
│ Voicemail      [x] an                                        │
├ Anrufe und Nachrichten ─────────────────────────────────────┤
│ 25.11. 14:02  ← 2000 Dienst Technik      0:45                │
│ 24.11. 18:11  ✉ Voicemail von +41 61 …   ▶ anhören  [Löschen]│
├ Meine Gruppen ──────────────────────────────────────────────┤
│ Ring-Group Technik (1000) – du klingelst für Dienst Technik  │
│ (2000) und die Amtsnummer. Ändern: Technik.                  │
└─────────────────────────────────────────────────────────────┘
```

**Meine Geräte:** alles, was auf die Nummer klingelt, in einer Liste: Rosenweg Telefon auf eigenen
Handys (`telefon_sip_privat`), eigene SIP-Telefone (neu, siehe unten), geteilte Telefone mit aktiver
Sitzung (`telefon_sitzungen`). Pro Gerät: Status (angemeldet/erreichbar), seit wann, Entfernen bzw.
Abmelden. Ersetzt „Hier bist du angemeldet“ und „Rosenweg Telefon auf dem eigenen Handy“ von
/smartphones.

**„+ Gerät“ – Assistent mit einer Frage zuerst: „Was willst du verbinden?“**

1. **Mein Handy (Android)** → Link auf die Apps-Seite (Rosenweg Telefon), dann in der App „Mit
   Rosenweg-Konto anmelden“. Nichts weiter; das Gerät erscheint danach von selbst in der Liste.
2. **Ein SIP-Telefon** (Tischtelefon, Softphone) → Name eingeben („Büro“), Anlage legt einen
   Zugang an. Angezeigt **einmal**: Server `sip.rosenweg4303.ch`, Benutzer `<nummer>-p<id>`,
   Passwort, Transport TLS 5061 (von aussen) bzw. TCP 5060 (im Rosenweg-Netz). Optional QR für
   Linphone (`/prov/<token>`, wie heute). Danach nur noch „Passwort neu setzen“.
3. **An einem geteilten Telefon** → Anmelde-QR (heute „Dein Anmelde-QR“) mit Ablaufzeit, Hinweis
   auf die Rosenweg-Karte (NFC).

**Erreichbarkeit:** Weiterleitung aus / immer / wenn nicht erreichbar (5–60 s), Zielnummer
(Schweizer oder internationale Nummer, intern auch 3HHWWP); persönliche Voicemail an/aus.
Später: Ansage, Nicht stören, Zeiten (steht schon im Nummernplan als „später“).
Hinweis direkt dabei: In Gruppen greift die Weiterleitung, die Voicemail nicht.

**Anrufe und Nachrichten:** Anrufliste der Person über alle Geräte (`/api/telefon/anrufliste`),
persönliche Voicemails anhören und löschen. Löschfrist 90 Tage steht dabei.

**Meine Gruppen:** nur Anzeige, in welchen Gruppen/Diensten die Person klingelt.

## Seite 2: „Telefonanlage“ (`rosenweg4303.ch/telefonanlage`), für Technik und Präsident

Reiter: **Nummern · Geräte · Amt · Apps · Protokoll**.

```
┌ Telefonanlage ─ [Nummern] Geräte  Amt  Apps  Protokoll ─────┐
│ Suchen: [         ]   Filter: alle ▾                         │
│ 1000  Gruppe   Ring-Group Technik      2 Mitglieder          │
│ 2000  Dienst   Technik                 Mo–Fr 07–18, sonst VM │
│ 2102  Gerät    Rosenweg Smartphone 2   ● erreichbar          │
│ 309093 Person  Stefan Müller           2 Geräte, WL nach 20s │
│ 4000  Verwaltung Immosense AG          +41 61 …              │
└─────────────────────────────────────────────────────────────┘
```

Ein Klick öffnet die Nummer:

- **Gruppe (1XXX):** Name, Mitglieder (Personen bevorzugt, sonst Gerät oder Handynummer), Reihenfolge
  (gleiche Stufe = gleichzeitig), „klingelt immer“ je Mitglied, befristet bis. Heute: „Ring-Group
  Mitglieder“ in PBX-Admin.
- **Dienst (20XX):** Name, Geschäftszeiten, welche Gruppe klingelt, **ausserhalb der Zeiten**:
  gemeinsame Voicemail (Abschrift, WhatsApp an welche Gruppe, Auto-Reklamation ja/nein) oder
  Ansage oder Weiterleiten; welche Amtsnummer hierher führt. Heute: „Geschäftszeiten“ + fest
  verdrahtet.
- **Gerät (21XX):** Typ (geteiltes Telefon / SIP-Telefon / Linphone), Status, angemeldete Person,
  Wartung (adb, Port 5555), Klingeln, Abmelden, Einrichtungs-QR. Heute: PBX-Admin „SIP-Telefone“ und
  „Geteilte Telefone“ sowie /smartphones „Geteilte Telefone“.
- **Person (3HHWWP):** ihre Geräte, Weiterleitung, Gruppen – **nur lesend**. Aktionen: „SIP-Telefon
  für diese Person einrichten“ (Hilfe für Leute, die es nicht selbst können), Gerät entfernen
  (z.B. verlorenes Handy). **Nicht** sichtbar: ihre Anrufe und Voicemails.
- **Verwaltung (4XXX):** Name, Zielnummer.

Weitere Reiter:

- **Geräte:** dieselben Geräte wie unter Nummern, als Betriebsansicht (alle geteilten Telefone mit
  Status, Wartung, App-Stand) – heute /smartphones „Geteilte Telefone“ + „Eigene Handys“.
- **Amt:** Trunk-Status, Amtsnummer → Ziel (heute Dienst 2000), Testanruf, Technik-Konferenz (100/*100).
- **Apps:** App-Katalog (heute /smartphones).
- **Protokoll:** Anrufliste aller Anrufe (heute PBX-Admin), Verlauf der geteilten Telefone.

## Was wohin umzieht

| Heute | Neu |
|---|---|
| /smartphones „Dein Anmelde-QR“ | Mein Telefon → + Gerät → „An einem geteilten Telefon“ |
| /smartphones „Hier bist du angemeldet“, „Rosenweg Telefon auf dem eigenen Handy“ | Mein Telefon → Meine Geräte |
| /smartphones „Geteilte Telefone“, „Eigene Handys“ | Telefonanlage → Geräte |
| /smartphones „App-Katalog“ | Telefonanlage → Apps |
| /smartphones „Verlauf“ | Telefonanlage → Protokoll |
| PBX-Admin „Trunk-Status“, „Technik-Konferenz“ | Telefonanlage → Amt |
| PBX-Admin „Geschäftszeiten“ | Telefonanlage → Nummern → 2000 Dienst Technik |
| PBX-Admin „Ring-Group Mitglieder“ | Telefonanlage → Nummern → 1000 Gruppe Technik |
| PBX-Admin „SIP-Telefone“, „Geteilte Telefone“ | Telefonanlage → Nummern/Geräte → 21XX |
| PBX-Admin „Anruf-Log“ | Telefonanlage → Protokoll |
| nur Datenbank: Weiterleitung, Voicemail an/aus | Mein Telefon → Erreichbarkeit |

`pbx.rosenweg4303.ch` behält nur die API (und `/telefon` als Anmeldefenster für Rosenweg Gerät).
`/smartphones` und `/pbx-admin` leiten auf die neuen Seiten um. `/telefon` bleibt Umleitung.

## Rechte und Datenschutz

| | Person | Technik / Präsident |
|---|---|---|
| eigene Nummer, Geräte, Weiterleitung, Voicemail an/aus | ändern | sehen (lesend), Gerät entfernen |
| eigene Anrufe und Voicemails | sehen, anhören, löschen | **nein** |
| Gruppen, Dienste, Geräte, Amt, Apps | sehen, wo sie selbst drin ist | ändern |
| Anrufliste aller Anrufe, gemeinsame Voicemails der Dienste | nein | ja (Dienst-Voicemails gehen ohnehin an die Gruppe) |

Grundlage: Rosenweg-Anmeldung (Authentik), Gruppen „Technik“/„Präsident“ wie heute
(`require_admin`). Die Person wird über ihre E-Mail aus dem Token bestimmt (`personen_nummern`).

## Anlage: was sich ändert

**Daten (pbx-api, SQLite):**

1. `telefon_sip_privat` bekommt `art` (`app` | `sip`) und `bezeichnung` („Büro“). SIP-Telefone der
   Person sind damit dasselbe wie Rosenweg-Telefon-Zugänge: gleicher Kontext `[person]`, klingeln über
   `pbx_person.py`, Abmelden/Entfernen gleich. Kein neuer Wählplan nötig.
2. Neue Tabelle `gruppen` (nummer 1XXX, name) und `ring_members.gruppe` (heute alle → 1000).
3. Neue Tabelle `dienste` (nummer 20XX, name, gruppe, zeiten, ausserhalb = voicemail|ansage|weiterleiten,
   voicemail_whatsapp_ziel, auto_reklamation). Die heutigen Geschäftszeiten (`config`) werden Dienst 2000.
4. Amtsnummer → Dienst: Eintrag in `config` (heute fest `[inbound]` → techring).

**Wählplan:** `1XXX` → `techring` mit Gruppe als Argument (statt fest 1000); `20XX` → Dienst-Ablauf mit
Regeln aus `dienste`; `[inbound]` → Dienst aus der Konfiguration. Personen, Geräte, Verwaltung
bleiben, wie sie sind.

**Schnittstellen (neu):**

| Methode und Pfad | Wer | Zweck |
|---|---|---|
| `GET /api/telefon/ich` | Person (Token) | Nummer, Geräte, Erreichbarkeit, Gruppen in einem |
| `PUT /api/telefon/ich/erreichbarkeit` | Person | Weiterleitung, Sekunden, Ziel, Voicemail an/aus |
| `POST /api/telefon/ich/geraete` | Person | SIP-Telefon anlegen (`{bezeichnung}`) → Zugangsdaten einmal |
| `POST /api/telefon/ich/geraete/<id>/passwort` | Person | neues Passwort |
| `DELETE /api/telefon/ich/geraete/<id>` | Person | Gerät entfernen (heute `DELETE /api/telefon/privat/<id>`) |
| `DELETE /api/telefon/ich/voicemail/<id>` | Person | eigene Voicemail löschen |
| `GET /api/pbx/nummern` | Technik | alle Nummern mit Typ und Kurzstatus (ersetzt `/api/pbx/nummernplan` für die Ansicht) |
| `GET/PUT /api/pbx/gruppen/<nr>`, `/api/pbx/dienste/<nr>` | Technik | Gruppen und Dienste pflegen |
| `POST /api/pbx/personen/<nr>/geraete` | Technik | SIP-Telefon für eine Person einrichten |

Bestehende Endpunkte bleiben, solange Apps sie nutzen (Rosenweg Gerät, Rosenweg Telefon).

## Reihenfolge

Jeder Schritt ist für sich nutzbar und wird einzeln ausgerollt.

1. **Mein Telefon, Teil 1:** `GET /api/telefon/ich`, Erreichbarkeit einstellen, Meine Geräte (lesen,
   entfernen). Schliesst die grösste Lücke (Weiterleitung nur in der DB). Seite `/mein-telefon`.
2. **SIP-Telefon als Gerät:** `art`/`bezeichnung`, Assistent „+ Gerät“ mit den drei Wegen,
   Zugangsdaten einmal anzeigen. Danach kann jede Person ihr SIP-Telefon selbst einrichten.
3. **Telefonanlage, Grundgerüst:** Reiter Nummern (lesend) und Geräte, Apps, Protokoll aus /smartphones
   und PBX-Admin übernehmen. /smartphones leitet um.
4. **Gruppen und Dienste als Daten:** Tabellen, Wählplan liest sie, Pflege in Telefonanlage → Nummern.
   PBX-Admin leitet um, die Oberfläche auf `pbx.rosenweg4303.ch` fällt weg.
5. **Anrufe und Nachrichten im Web:** eigene Anrufliste und Voicemail auf „Mein Telefon“.
6. Später: Ansage, Nicht stören, Zeiten; Transkript für persönliche Voicemail (offen im Nummernplan).

## Offene Fragen an Stefan

1. Adressen: `/mein-telefon` und `/telefonanlage` – passt das, oder lieber unter `/smartphones`
   bleiben (z.B. `/smartphones` = Telefonanlage, `/mein-telefon` neu)?
2. Darf eine Person ihre **Weiterleitung auf jede Nummer** setzen (auch Ausland), oder nur Schweiz?
   Kosten laufen über peoplefone.
3. **SIP-Telefone selbst einrichten:** jede Person, oder nur mit Freigabe durch Technik?
4. Soll Technik die **Weiterleitung einer Person ändern** können (z.B. für jemanden, der es nicht
   kann), oder nur sehen?
5. Gruppen-Mitglieder: nur noch **Personen** (empfohlen) oder weiterhin auch reine Handynummern
   (z.B. externe Helfer ohne Rosenweg-Nummer)?
6. Mehrere **Dienste** absehbar (Hauswart, Verwaltung)? Davon hängt ab, wie früh Schritt 4 kommt.
