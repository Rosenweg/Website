# SIP-Telefone — Anleitung

Interne Telefone an der Rosenweg-PBX: Tisch-Telefone im Technikraum, Softphones
auf Handy oder Laptop. Sie hängen direkt an Asterisk (CT 220), nicht an
peoplefone, und sind **nur aus dem LAN oder über VPN** erreichbar — es gibt
bewusst keine Freigabe ins Internet.

Wer die Anlage insgesamt bedienen will: [Telefonanlage](telefonanlage-anleitung.md).

---

## Neues Telefon anlegen

Im PBX-Admin (**<https://pbx.rosenweg4303.ch>**), Karte **☎️ SIP-Telefone (LAN/VPN)**:

| Feld | Was eintragen |
|---|---|
| **Extension** | Leer lassen — dann wird fortlaufend ab `2000` vergeben. Nur Ziffern erlaubt |
| **Name** | Pflicht. Erscheint als Anzeigename beim Angerufenen, z.B. `Technikraum` |
| **Passwort** | Leer lassen — dann wird ein sicheres Passwort erzeugt |

**+ Telefon** klicken. Der Eintrag erscheint sofort in der Tabelle, die
Asterisk-Konfiguration wird automatisch neu geschrieben und geladen. Kein Neustart,
kein manuelles Editieren von `pjsip_phones.conf` — die Datei wird bei jeder
Änderung überschrieben.

Das Passwort steht im Klartext in der Tabelle und wird zum Einrichten des Geräts
gebraucht.

---

## Gerät konfigurieren

Diese fünf Angaben braucht jedes SIP-Gerät:

| Einstellung | Wert |
|---|---|
| Server / Domain / Registrar | `100.64.2.29` |
| Port | `5060`, Transport **UDP** |
| Benutzername / Authentifizierungs-ID | die **Extension**, z.B. `2000` |
| Passwort | wie in der Tabelle |
| Anzeigename | frei wählbar |

> Die Server-Adresse steht auch direkt in der Karte im PBX-Admin. Falls der
> Container einmal umzieht, gilt der dort angezeigte Wert — nicht dieser Text.

**Codecs** sind serverseitig auf Opus, G.722, A-law und µ-law gesetzt. Wer im LAN
sitzt, lässt am besten G.722 oben stehen (HD-Sprache); über VPN mit wenig Bandbreite
ist A-law robuster.

### Softphone auf dem Handy oder Laptop

Getestet mit Linphone und Zoiper, funktioniert aber mit jedem SIP-Client:

1. Konto vom Typ **SIP** anlegen (nicht „nach Anbieter suchen" — manuell
   konfigurieren).
2. Benutzername `2000`, Passwort, Domain `100.64.2.29`, Transport UDP.
3. Nur wenn der Client Server und Domain getrennt abfragt: beides gleich setzen.
4. Speichern. Der Client meldet nach wenigen Sekunden „registriert".

Unterwegs muss vorher das **VPN** stehen. Ohne VPN registriert sich das Softphone
nicht — das ist so gewollt.

### Kontrolle

In der Tabelle im PBX-Admin springt die Spalte **Registriert** auf 🟢 *registriert*,
sobald sich das Gerät gemeldet hat. Dann am Gerät `*43` wählen: Man hört eine Ansage
und danach sich selbst. Kommt das eigene Echo sauber zurück, stimmen Registrierung,
Codec und Sprachweg.

Pro Extension sind **zwei gleichzeitige Registrierungen** erlaubt — z.B.
Tisch-Telefon und Softphone auf demselben Konto. Ein drittes Gerät verdrängt das
älteste.

---

## Wählen

| Wahl | Was passiert |
|---|---|
| `100` | Technik-Konferenz — alle aktiven Ring-Mitglieder werden dazugerufen |
| `*43` | Echo-Test |
| `1000`–`1999` | Ein Ring-Mitglied direkt anrufen (Durchwahl aus der Spalte „Intern") |
| `2000`–`2999` | Ein anderes internes Telefon anrufen |
| `0…` z.B. `0791234567` | Schweizer Nummer nach aussen, über peoplefone |
| `+…` / `00…` | International, über peoplefone |

Ausgehende Gespräche laufen über den peoplefone-Trunk und werden **verrechnet**.
Sie erscheinen nach dem Auflegen im Anruf-Log.

---

## Telefon in die Ring-Group aufnehmen

Damit ein internes Telefon bei eingehenden Anrufen mitklingelt, muss es zusätzlich
Ring-Mitglied sein. In der SIP-Tabelle gibt es dafür den Knopf **+ Ring-Group** —
er legt das Mitglied mit Typ *SIP* und Standard-Priorität `10` an. Feinheiten
(Priorität, „klingelt immer") danach in der Ring-Group-Karte einstellen.

Ist das Telefon schon drin, zeigt die Zeile stattdessen 🟢 *in Ring-Group*.

---

## Telefon löschen

**Löschen** in der Zeile, Rückfrage bestätigen. Die Asterisk-Konfiguration wird
sofort neu geschrieben, das Gerät kann sich nicht mehr registrieren.

> Ein eventueller Ring-Group-Eintrag zu dieser Extension bleibt bestehen und muss
> **separat** in der Ring-Group-Karte entfernt werden. Sonst klingelt die Anlage
> weiter ins Leere und verbraucht Klingelzeit, die den anderen Mitgliedern fehlt.

---

## Störungen

| Symptom | Ursache | Was tun |
|---|---|---|
| Bleibt „nicht angemeldet" | Kein LAN/VPN, oder falscher Server/Port | VPN prüfen; `ping 100.64.2.29`; Transport muss UDP sein |
| Registrierung schlägt fehl trotz richtiger Daten | Passwort mit Sonderzeichen falsch übernommen | Passwort im UI markieren und kopieren statt abtippen |
| Registriert, aber kein Ton in eine Richtung | RTP kommt nicht durch (NAT/Firewall) | Am Client STUN/ICE deaktivieren — im LAN nicht nötig und oft die Ursache |
| Aussetzer, abgehackte Sprache | Bandbreite oder WLAN | Codec auf A-law fixieren, per Kabel testen |
| Gerät klingelt bei Anrufen von aussen nicht | Nicht in der Ring-Group, oder Zeitsperre greift | Ring-Group-Karte prüfen |
| Nach dem Anlegen kein Effekt | Neuladen der Asterisk-Konfiguration hat nicht gegriffen | In CT 220: `asterisk -rx "pjsip reload"` |

**Nachschauen** (in CT 220):

```bash
asterisk -rx "pjsip show endpoints"           # alle Telefone + Status
asterisk -rx "pjsip show aors"                # wer ist gerade registriert
asterisk -rx "pjsip show contacts"
asterisk -rvvv                                # Live-Log während eines Testanrufs
```

Die generierte Datei liegt unter `/etc/asterisk/pjsip_phones.conf`. Sie ist
**auto-generiert** — Änderungen daran gehen beim nächsten Anlegen oder Löschen
eines Telefons verloren. Quelle der Wahrheit ist die SQLite-Datenbank der PBX-API.

---

## Verwandt

- [Telefonanlage bedienen](telefonanlage-anleitung.md)
- [Telefonie-Übersicht](telefonie.md)
