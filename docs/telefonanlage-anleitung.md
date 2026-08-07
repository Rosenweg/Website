# Telefonanlage — Anleitung

Bedienung der Rosenweg-PBX (Asterisk in CT 220) über das Admin-UI. Für den
Erstaufbau und Deployment siehe stattdessen [pbx/README.md](../pbx/README.md) und
[pbx/DEPLOY-PBX-API.md](../pbx/DEPLOY-PBX-API.md).

## Zugriff

**<https://pbx.rosenweg4303.ch>** — Anmeldung mit dem normalen Rosenweg-Login
(Authentik SSO). Freigeschaltet sind nur **Technik** und **Präsident**; alle
anderen sehen die Anmelde-Kachel und danach nichts.

Die Seite lädt Trunk-Status und Anruf-Log alle 15 Sekunden neu, solange der Tab
im Vordergrund ist.

---

## Was bei einem Anruf passiert

1. Der Anruf kommt über den peoplefone-Trunk herein und wird sofort im Anruf-Log
   vermerkt.
2. Die Anlage nimmt ab und wartet eine Sekunde (damit die Ansage nicht abgeschnitten
   wird).
3. **Namensauflösung:** Die Nummer wird gegen Telefonbuch, Handwerker und
   Verwaltung geprüft. Ein Treffer erscheint als Name auf dem Display der
   Technik-Handys, sonst steht dort „Rosenweg".
4. **Zeitprüfung:** Liegt der Anruf innerhalb der Geschäftszeiten?
5. **Ring-Group:** Innerhalb der Zeit klingeln alle aktiven Mitglieder, ausserhalb
   nur die mit „klingelt immer". Mitglieder mit gleicher Priorität klingeln
   gleichzeitig, niedrigere Prioritätszahlen zuerst.
6. **Niemand nimmt ab** (oder es ist kein Mitglied aktiv) → Voicemail. Ausserhalb
   der Geschäftszeit läuft davor die Ansage „ausserhalb der Zeiten".
7. **Jemand nimmt ab** → das Gespräch läuft, kann aber mit `*100` zur Konferenz
   erweitert werden (siehe unten).

---

## Trunk-Status

Die oberste Karte zeigt, ob die Anlage bei peoplefone registriert ist.

| Anzeige | Bedeutung |
|---|---|
| 🟢 **Registriert** + „läuft ab in … s" | Alles gut. Die Registrierung erneuert sich automatisch. |
| 🔴 **NICHT registriert** | Es gehen keine Anrufe rein oder raus. Siehe [Störungen](#störungen). |
| 🔴 **NICHT registriert (AMI-Auth fehlgeschlagen)** | Nicht der Trunk ist das Problem, sondern die Anlage kann ihren eigenen Status nicht abfragen. |
| 🔴 **AMI nicht erreichbar** | Der Dienst `pbx-api` oder Asterisk selbst läuft nicht. |

### Test-Anruf

Nummer im internationalen Format (`+41…`) eintragen und **Test-Anruf** klicken.
Die Anlage ruft die Nummer über peoplefone an und legt sie auf die Echo-Ansage.
Andere Formate (`079…`, `0041…`) werden abgewiesen.

> Test-Anrufe gehen über den Trunk raus und werden von peoplefone **verrechnet**.

---

## Geschäftszeiten

| Feld | Bedeutung | Erlaubt |
|---|---|---|
| **Von** / **Bis** | Fenster, in dem die ganze Ring-Group klingelt | `HH:MM`, Zeitzone Europe/Zurich |
| **Ring-Timeout** | Wie lange insgesamt geklingelt wird, bevor die Voicemail übernimmt | 5–120 Sekunden |

**Speichern** genügt — die Änderung greift beim nächsten Anruf, kein Neustart nötig.

Das Ring-Timeout ist die **Gesamt**dauer und wird auf die Prioritäts-Stufen
verteilt: Bei 30 Sekunden und zwei Stufen klingelt Stufe 1 fünfzehn Sekunden, dann
Stufe 2 fünfzehn Sekunden. Wer eine Kaskade baut, sollte das Timeout entsprechend
hochsetzen — sonst klingelt jede Stufe zu kurz zum Abnehmen.

---

## Ring-Group verwalten

Die Ring-Group ist die Liste der Ziele, die bei einem Anruf klingeln.

### Mitglied hinzufügen

| Feld | Erklärung |
|---|---|
| **Name** | Klartext, erscheint im Anruf-Log und in der Konferenz |
| **Typ** | *Mobil (Trunk)* = eine echte Rufnummer, geht über peoplefone raus · *SIP-Telefon* = ein internes Telefon |
| **Nummer / Extension** | Bei Mobil `+41…` (international, Pflicht). Bei SIP die Extension, z.B. `2000` |
| **Prio** | Klingel-Reihenfolge. Gleiche Zahl = gleichzeitig, kleinere Zahl = früher. Standard `10` |
| **Klingelt immer** | *nein* = nur in der Geschäftszeit · *ja* = auch nachts und am Wochenende |

Jedes Mitglied bekommt automatisch eine **interne Durchwahl ab 1000**. Die steht
in der Spalte „Intern" und kann von jedem internen SIP-Telefon direkt gewählt
werden, um genau diese Person zu erreichen.

### Bestehende Mitglieder ändern

- **Zeitsperre** (Häkchen): angehakt = klingelt nur in der Geschäftszeit,
  abgehakt = klingelt immer. Wirkt sofort.
- **Aktiv** (Häkchen): abgehakt nimmt das Mitglied aus der Rotation, ohne es zu
  löschen — der richtige Weg für Ferien.
- **Löschen**: entfernt das Mitglied endgültig.

> Sind **alle** Mitglieder inaktiv oder ist die Liste leer, geht jeder Anruf direkt
> auf die Voicemail. Das ist gewollt (Betriebsferien), aber leicht übersehen.

---

## Technik-Konferenz

Zwei Wege in denselben Konferenzraum:

**Von aussen dazuholen — `100`**
An einem internen SIP-Telefon die `100` wählen. Die Konferenz wird eröffnet und
**alle aktiven Ring-Mitglieder werden automatisch angerufen** und hineingeholt.
Beim Betreten und Verlassen gibt es eine Ansage und die Teilnehmerzahl. Maximal
20 Teilnehmer.

**Mitten im Gespräch — `*100`**
Wer einen eingehenden Anruf angenommen hat und Verstärkung braucht, wählt während
des Gesprächs `*100`. Die restliche Ring-Group wird dazugerufen, der Anrufer bleibt
die ganze Zeit in der Leitung und hört keine Ansagen oder Wähltöne. Das eigene
Gespräch wird dabei nicht unterbrochen.

Technisch läuft dafür **jeder** angenommene Anruf von Anfang an als stille
Zweier-Konferenz — deshalb funktioniert `*100` ohne Vorbereitung.

---

## Voicemail und KI-Auswertung

Nimmt niemand ab, läuft die Ansage und die Aufnahme startet.

- Maximal **180 Sekunden**; drei Sekunden Stille beenden die Aufnahme vorzeitig.
- Danach transkribiert Whisper die Aufnahme (Groq `whisper-large-v3`, ersatzweise
  OpenRouter).
- Claude Haiku fasst zusammen und klassifiziert: **Kernanliegen**, **Dringlichkeit**
  (niedrig/mittel/hoch), **nächste Handlung**, und ob es sich um einen **Defekt**
  handelt (inkl. STWEG-Nummer, falls genannt).
- Das Ergebnis geht per **WhatsApp** an die Gruppe „Rosenweg Technik".
- Erkennt die KI einen Defekt, kann daraus automatisch eine **Reklamation** in der
  Haupt-API angelegt werden.

Transkript und Zusammenfassung stehen anschliessend auch am Anruf im Anruf-Log.

**Wenn keine WhatsApp-Nachricht kommt**, ist meist einer dieser drei Punkte in
`/etc/default/pbx-api` das Problem: `GROQ_API_KEY` (bzw. `OPENROUTER_API_KEY`)
fehlt, `GATEWAY_API_KEY` ist abgelaufen, oder der Alias `Rosenweg Technik` ist im
WhatsApp-Gateway nicht auflösbar. Siehe [WhatsApp-Anleitung](whatsapp-anleitung.md).

---

## Anruf-Log

Die letzten 50 Anrufe mit Zeit, Richtung (⬇ eingehend / ⬆ ausgehend / ↔ intern),
Von, An, Status und Dauer. Ausgehende und interne Gespräche der SIP-Telefone werden
beim Auflegen aus den Verbindungsdaten nachgetragen, erscheinen also erst nach
Gesprächsende.

---

## Störungen

| Symptom | Wahrscheinliche Ursache | Was tun |
|---|---|---|
| Trunk „NICHT registriert" | peoplefone nicht erreichbar oder Zugangsdaten falsch | Im peoplefone-Portal prüfen, ob das Konto aktiv ist. Dann in CT 220: `asterisk -rx "pjsip show registrations"` |
| „AMI nicht erreichbar" | `pbx-api` oder Asterisk läuft nicht | `systemctl status pbx-api asterisk`, notfalls `systemctl restart pbx-api` |
| Anruf kommt an, aber nichts klingelt | Kein Mitglied aktiv, oder ausserhalb der Zeit ohne „klingelt immer" | Ring-Group-Karte prüfen: Häkchen „Aktiv" und Spalte „Zeitsperre" |
| Es klingelt nur ganz kurz | Ring-Timeout auf viele Prioritätsstufen verteilt | Ring-Timeout hochsetzen oder Stufen zusammenlegen (gleiche Prio) |
| Anrufer hört nichts / Einwegton | RTP-Problem am NAT | `EXTERNAL_IP` in der Asterisk-Konfiguration prüfen |
| Keine Voicemail-Auswertung | API-Key oder Gateway-Alias | Siehe Abschnitt Voicemail oben; Log: `journalctl -u pbx-api -f` |
| Änderung im UI wirkt nicht | Browser zeigt alte Daten | „Neu laden" in der jeweiligen Karte klicken |

**Live mitschauen** (in CT 220):

```bash
asterisk -rvvv                       # Konsole mit Live-Log
asterisk -rx "pjsip show registrations"
asterisk -rx "pjsip show endpoints"
journalctl -u pbx-api -f             # PBX-API inkl. Voicemail-Pipeline
```

---

## Interne Kurzwahlen

| Wahl | Ziel |
|---|---|
| `100` | Technik-Konferenz (holt die Ring-Group dazu) |
| `*100` | Während eines Gesprächs: Gruppe live dazuholen |
| `*43` | Echo-Test (hört man sich selbst, ist die Leitung gut) |
| `1000`–`1999` | Ring-Mitglied direkt anrufen (Spalte „Intern") |
| `2000`–`2999` | Internes SIP-Telefon direkt anrufen |
| `0…` / `+…` / `00…` | Ausgehend über peoplefone |

---

## Verwandt

- [SIP-Telefone einrichten](sip-telefone-anleitung.md)
- [WhatsApp-Bot und Gateway](whatsapp-anleitung.md)
- [Telefonie-Übersicht](telefonie.md)
