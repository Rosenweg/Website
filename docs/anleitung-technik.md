# Bedienanleitung für Technik und Präsident

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Diese Anleitung beschreibt
die Vorgänge, die nur die Gruppen `technik` und `Präsident` ausführen dürfen, Schritt
für Schritt. Was Ausschuss und Verwaltung selbst erledigen, steht in
[anleitung-ausschuss.md](anleitung-ausschuss.md); die zugrunde liegenden Regeln,
Grenzwerte und Umgebungsvariablen in [sicherheit.md](sicherheit.md).

Wer zählt als Technik? In der API prüfen die meisten Routen „Gruppe `technik` oder
`Präsident`“ (auch `praesident`). Ausnahmen, in denen **nur `technik`** (oder ein Konto
mit `role=admin`) zugelassen ist: MQTT-Verwaltung inklusive App-Passwörter für andere
Konten und die Anzeigen-Bedienung (Ankündigungen, Notfall) – Abschnitt 10 und
[mqtt-display.md](mqtt-display.md). Die Seite `energie-config.html` lässt im Browser
nur Konten mit einer Gruppe, deren Name „technik“ enthält, hinein.

---

## 1. Gruppen ausserhalb Bewohner/Eigentümer vergeben

Ausschuss und Verwaltung können nur Bewohner- und Eigentümer-Gruppen ihrer eigenen
STWEG vergeben, und auch das nur beim Anlegen eines Kontos. Alles andere
(Ausschuss-Gruppen, `verwaltung`, `technik`, Zutritt, Dienstleister, Gruppen anderer
STWEGs, nachträgliche Änderungen) macht die Technik.

### 1.1 Über die Objektverwaltung

1. `objektverwaltung.html` → Reiter **Gruppen** (Titel „Alle Gruppen“).
2. Gruppe anklicken. Das Fenster zeigt die Mitglieder und darunter **„Benutzer
   hinzufügen“**.
3. Benutzer wählen → **„Hinzufügen“**; zum Entfernen beim Mitglied **„Entfernen“**.

Alternativ im Reiter **Bewohner** beim Konto den Stift → Häkchen unter **Gruppen** →
**„Speichern“**. Dort stehen nur Gruppen, deren Name „ausschuss“, „bewohner“ oder
„eigentuemer“ enthält, sowie `technik`; andere Gruppen über den Reiter Gruppen.

Übergeordnete Gruppen (Authentik-Feld „Elterngruppe“) werden automatisch mit
vergeben und wieder entzogen, wenn keine ihrer Untergruppen mehr gesetzt ist.

### 1.2 Neue Gruppe

Der Knopf **„Neue Gruppe“** im Reiter Gruppen ruft `POST /api/admin/groups` auf; diese
Route gibt es in der API nicht (Ergebnis: Fehlermeldung ohne Text). Neue Gruppen
deshalb direkt in der Authentik-Oberfläche anlegen (*Directory → Groups → Create*) und
danach die Seitenrechte in `rechteverwaltung.html` setzen.

### 1.3 Seitenrechte

`rechteverwaltung.html` (Recht „Rechteverwaltung“): je Gruppe und Seite `none`, `read`
oder `write`. Beispiel: Damit ein Ausschuss Konten anlegen kann, braucht seine Gruppe
„Bewohner-Verwaltung“ = `write` (siehe [anleitung-ausschuss.md](anleitung-ausschuss.md),
Abschnitt 3).

### 1.4 Konto mit Passwort anlegen

Nur Technik/Präsident dürfen beim Anlegen ein Passwort mitgeben; dann wird es auch ins
Active Directory geschrieben (nur für das eben neu angelegte Konto). Die Oberfläche
hat dafür kein Feld – der Weg ist ein direkter API-Aufruf
`POST /api/admin/users {username, name, email, password, groups}` aus einer
Browsersitzung. Auch für die Technik gilt: Ein Benutzername, der sich von einem
bestehenden nur in Gross-/Kleinschreibung unterscheidet, ergibt 409 „Benutzername
existiert bereits“.

---

## 2. Konten löschen

### 2.1 Sofort löschen

1. `objektverwaltung.html` → Reiter **Bewohner**.
2. Beim Konto den **Papierkorb** → Bestätigen.

Der Bestätigungstext sagt „Der Benutzer wird deaktiviert“; tatsächlich wird das Konto
in Authentik **gelöscht**. Danach räumt die API lokal auf: Bindung an das
Authentik-Konto (`authentik_sub`) gelöst, lokale Zeile deaktiviert (ausser es gibt
noch ein anderes Authentik-Konto mit dieser E-Mail), alle Sitzungen gelöscht, alle
persönlichen Zugangstoken (PAT) widerrufen.

Kontaktkarten in Wohnungen bleiben bestehen. Steht die Adresse dort noch mit
„Authentik-Zugang“, legt das nächste Speichern der Wohnung wieder ein Konto an – also
vorher die Kontaktkarte entfernen oder den Haken entfernen.

### 2.2 Geplante Löschungen (`loeschungen.html`)

Zeigt alle Vormerkungen (Entstehung siehe
[anleitung-ausschuss.md](anleitung-ausschuss.md), Abschnitt 4) mit Name, E-Mail,
STWEG, Termin („in N Tagen“), Status (geplant / Reminder raus / cancelled) und ob die
Adresse wieder in einer Wohnung steht („✓ neu eingetragen“).

Aktionen im Auswahlfeld **„⋯ Aktion“**:

| Aktion | Wirkung |
|---|---|
| 📨 Mail-Chain anzeigen | alle Mails zu dieser Vormerkung (Erinnerung und Folge-Mails) |
| ✕ Loeschung cancellen | stoppt die Löschung; Eintrag bleibt als „cancelled“ sichtbar |
| ⏱ Timer +30 Tage | bei gestoppten Einträgen: neu planen, Termin in 30 Tagen, Erinnerung wird erneut verschickt |
| 🗑 Eintrag entfernen | Eintrag weg; das Konto bleibt, aber kein Lauf überwacht es mehr |

Konten, die beim Auszug **nicht** vorgemerkt wurden (weitere Gruppen, Mieterwechsel
per Datum, Adresse noch an einer anderen Wohnung), muss die Technik bei Bedarf nach
2.1 löschen.

---

## 3. Geschützte Personen ändern

Eine Person ist geschützt, wenn sie ein eigenes aktives Konto hat oder Wohnungen in
mehreren STWEGs. Ausschuss und Verwaltung bekommen dann 409; die Technik nicht.

### 3.1 Stammdaten (`personen.html`)

1. Person suchen → **„bearbeiten →“**.
2. Felder ändern → **„Speichern (propagiert auf alle Wohnungen)“**.

Die Änderung geht in **alle** Kontaktkarten der Person, über alle STWEGs. Der Name
ist zugleich der Name, unter dem die Person Vollmachten digital unterschreibt. Bei
Personen mit Konto deshalb vorher klären, ob die Person das nicht selbst im Profil
ändern sollte.

### 3.2 Zusammenführen

`personen.html` → **„🔍 Duplikate prüfen“** → bei der wegfallenden Person **„in
andere mergen…“** → bleibende Person wählen → **„Mergen“**. Für die Technik ohne
Schutzprüfung. Vorher prüfen, welche der beiden Personen das Konto hat (deren
E-Mail soll bleiben).

### 3.3 Kontaktkarten in der Objektverwaltung

Für Technik und Präsident gilt beim Speichern einer Wohnung das alte Verhalten: Eine
mitgeschickte `person_id` wird übernommen, und Name/E-Mail/Telefon/Adresse einer
Karte werden in den Personen-Stammsatz übertragen – auch bei geschützten Personen.
Einen Mieterwechsel deshalb auch als Technik mit einer neuen Karte machen, nicht durch
Überschreiben.

---

## 4. Stationen freigeben (`stationen.html`)

Stationen sind fest installierte Geräte (Arbeitsplätze, Kioske …), die sich mit
`stationctl` selbst registrieren.

### 4.1 Warum Stationen gesperrt ankommen

Richtet jemand **ohne** Gruppe `technik`/`Präsident` eine Station ein, entsteht sie mit
Status **gesperrt**, Grund „Wartet auf Freigabe durch Technik“, Ereignis
„freigabe-noetig“. Die Station bekommt nur ein Gerüst ohne Geheimnisse: kein
AD-Join-Passwort, kein root-Hash, kein MQTT-Passwort, keine Admin-SSH-Schlüssel, kein
WLAN-Schlüssel. Richtet die Technik ein, ist die Station sofort aktiv.

### 4.2 Freigeben

1. `stationen.html` öffnen. Oben zählt **gesperrt** die wartenden Stationen.
2. In der Zeile prüfen: **Eingerichtet von** (Spalte mit dem Benutzernamen), Standort,
   Gerät/Hardware, Zeitpunkt. Bei Zweifel **„Logs“** ansehen oder vor Ort nachfragen.
3. **„Entsperren“** → im Dialog **„Entsperren“** bestätigen.
4. Die Station holt sich beim nächsten Lauf (alle fünf Minuten) die volle
   Konfiguration und richtet sich ein.

Nicht freigeben, wenn die Station unbekannt ist: dann **„Entfernen“** (das Token der
Station wird wertlos). Ein Gerät, dessen Hardware zu einer von der Technik gesperrten
Station gehört, kann sich nicht unter neuem Namen neu registrieren („Dieses Gerät ist
gesperrt (als '…')“).

### 4.3 Weitere Aktionen

| Knopf | Wirkung |
|---|---|
| Sperren | mit optionalem Grund; die Station bekommt keine Konfiguration mehr, nur ihr Lebenszeichen geht noch durch |
| Aktualisieren | Station holt beim nächsten Lebenszeichen die neueste Version |
| Einstellen | Überschreibungen der Konfiguration: Haus, Standort, Kanal, WLAN, Programme, **Standarddrucker** |
| Zurücksetzen | Station löscht ihre Identität und startet im Einrichtungszustand; zum Bestätigen den Namen eintippen. Neu-Zuordnung nur vor Ort. „Zurücksetzen abbrechen“ solange die Station es noch nicht abgeholt hat. |
| Entfernen | Eintrag entwertet; das Gerät läuft weiter, bis es beim nächsten Lauf abgewiesen wird |

### 4.4 Standarddrucker und Windows-Rechner

Der Standarddrucker je Rechner wird hier gepflegt: **Aktionen ▾ → Einstellen … →
Drucken → Standarddrucker**. Zur Wahl stehen die Drucker aus
`api/lib/stationconfig.js` (`DRUCKER`, heute DruckerR9 und DruckerR13) und
„Keiner — der Rechner wählt selbst“. Gespeichert wird unter
`overrides.roles.<Art>.printing.default` — genau das Feld, das os-stationen
schon liest. Linux-Stationen nehmen nur einen Drucker mit A4-Vorgabe als
Standard; DruckerR13 (A3) wird dort übergangen.

Windows-Rechner richten sich nicht selbst ein. Die Verwaltung liest sie deshalb
aus dem AD (seit 26.11.2026, `api/lib/adrechner.js`): alle 15 Minuten
(`AD_ABGLEICH_MINUTEN`, 0 = nur von Hand) und mit **„Windows aus AD
abgleichen“** über der Liste. Gelesen werden Computerkonten mit „Windows“ im
Betriebssystem, ohne Domain Controller, mit dem Konto `STATION_AD_JOIN_USER`
(oder `AD_LESE_USER`/`AD_LESE_PASSWORD`, falls gesetzt).

- **Neu im AD** → als Windows-Rechner aufgenommen, „aus dem AD“. Haus und
  Drucker werden dabei **einmal** zugeteilt: das Haus aus der OU
  (`OU=Rosenweg 13`, `OU=Haus 13`, `OU=R13`, `OU=RW13`) oder, wenn die nichts
  sagt, aus dem Namensanfang (`R9-…`, `RW9-…`, `ROSENWEG9-…`); der Drucker ist
  der des Hauses (`DRUCKER[].haus`: 9 → DruckerR9, 13 → DruckerR13, andere
  Häuser keiner). Danach schreibt der Abgleich Haus und Drucker nie wieder —
  was hier eingestellt wird, gilt.
- **Kein Haus erkennbar** (z. B. `WIN11-1`) → „Standort fehlt“, Drucker leer.
  drucker.ps1 lässt dann den bisherigen Standard stehen und nimmt DruckerR9 nur,
  wenn es den nicht gibt. Haus und Drucker unter **Einstellen …** wählen.
- **Im AD deaktiviert / gelöscht** → markiert („im AD deaktiviert“, „im AD
  nicht mehr vorhanden“), nie automatisch entfernt.
- **Hier entfernt** → kommt nicht wieder, solange das AD-Konto (objectGUID)
  dasselbe ist; ein neu beigetretener Rechner gleichen Namens dagegen schon.
- **Umbenannt im AD** → Name folgt, Einstellungen bleiben.
- Steht unter dem Namen schon eine Linux-Station, wird nichts angelegt
  (Namenskonflikt in der Zeile unter den Knöpfen).

**„Windows-Rechner eintragen“** bleibt für Rechner, die nicht im AD stehen;
ein vorher so eingetragener wird beim Abgleich mit seinem AD-Konto verknüpft,
ohne dass sich an Haus oder Drucker etwas ändert. Windows-Rechner haben keinen
Agenten und kein Token: sie zählen nie als „neu“ oder „länger still“, und im
Menü gibt es nur **Einstellen …** und **Entfernen …**.

Abgefragt wird der Wert ohne Anmeldung, nur aus dem internen Netz, über
`GET /api/stations/drucker/<rechner>` (siehe [api.md](api.md), 4.1).

Nach der Sicherheitsprüfung gelten Geheimnisse, die früher über die alte
Registrierung an Nicht-Technik gingen, als offengelegt (Rotation:
[sicherheit.md](sicherheit.md), Abschnitt 7.1, Punkt 11).

---

## 5. Vollmachten: Admin-Upload und Papier-Aktivierung

Seite `vollmachten.html`, Reiter **„Alle (Admin)“**.

### 5.1 PDF aller Geber hochladen

Für den Fall, dass ein auf Papier von **allen** Vollmachtgebern unterschriebenes
Dokument vorliegt (z. B. bei der Verwaltung abgegeben):

1. Vollmacht im Status **Entwurf** suchen.
2. **„📤 PDF aller Geber hochladen (Admin)“** → PDF wählen (nur PDF, höchstens
   20 MB).
3. Ergebnis: Alle noch offenen Geber-Zeilen gelten als auf Papier unterschrieben, die
   Datei liegt als `Vollmachten/<doc_hash>-signed.pdf`, Status **aktiv**.
4. Die Seite fragt danach „Jetzt automatisch von der KI prüfen lassen?“ – Ja, und das
   Ergebnis ansehen.

Technisch ruft dieser Knopf `upload-signed?als=admin` auf. Nur mit diesem Parameter
zeichnet ein Upload für alle Geber. Ist das Technik-Konto selbst Vollmachtgeber dieser
Vollmacht, erscheint der Admin-Knopf nicht; ein Upload über „📤 Signierte PDF
hochladen“ zählt dann nur für die eigene Zeile (sonst stünde z. B. der Ehepartner als
unterschrieben da). Soll trotzdem für alle hochgeladen werden, muss das eine andere
Person aus Technik/Präsident machen.

Die Oberfläche zeigt den Admin-Knopf nur bei Entwürfen. Die API nimmt einen
Admin-Upload auch bei aktiven Vollmachten an (ersetzt dann die PDF); ein normaler
Geber kann nur zu Entwürfen hochladen.

### 5.2 Papier aktivieren

**„📄 Papier aktivieren“** (Technik, Präsident, Verwaltung): Entwurf ohne Upload
aktivieren, wenn das Original aller Geber vorliegt. Bestätigungstext: „Vollmacht als
papier-signiert AKTIVIEREN (ohne Upload)? Nur wenn das unterschriebene Original aller
Vollmachtgeber vorliegt.“

### 5.3 Widerrufen, Löschen

- **Widerrufen**: Vollmachtgeber oder Technik/Präsident, mit optionalem Grund.
- **Löschen**: Vollmachtgeber/Ersteller nur Entwürfe; Technik/Präsident jeden Status.

---

## 6. ISP: Mail-Relays, Weiterleitungen und Reverse-Proxy freigeben

Seite `isp-admin.html` (nur Technik/Präsident; andere sehen „Nur für
Technik/Präsident.“).

### 6.1 Wann ein Eintrag auf die Technik wartet

Einträge von Bewohnern (über `isp-mein-zugang.html`) werden **nie automatisch**
freigeschaltet, wenn

- der Name „rosenweg“ enthält, mit `r<Zahl>.` beginnt oder auf `.rosenweg4303.ch` bzw.
  `.rosenweg9.ch` endet,
- der Name in einer **unserer Cloudflare-Zonen** liegt („Name liegt in unserer Zone …
  — ein Admin muss freigeben“),
- es ein Wildcard-Name ist (`*.…`),
- er sich mit einem fremden Eintrag überschneidet (gleicher Name, Ober- oder
  Unterdomain, gleiche registrierbare Domain; Grund „Name überschneidet sich mit einem
  bestehenden Eintrag (…)“), oder diese Prüfung wegen eines Datenbankfehlers nicht
  möglich war,
- es eine **Reverse-Proxy-Route** oder ein **Mail-Relay** ist – deren Ziel (Backend
  bzw. Ziel-Host, IMAPS/SMTPS) sieht immer ein Admin an, auch wenn DNS stimmt („DNS ok
  — Backend wartet auf Admin-Freigabe“ bzw. „… Ziel wartet …“).

Ändert ein Bewohner später Ziel, Protokoll, Entry-Point oder TLS-Durchleitung einer
Route oder schaltet er die Anmeldepflicht ab, fällt sie zurück auf „wartet auf Admin“
und wird inaktiv.

### 6.2 Freigeben

**Reverse-Proxy-Routen und Weiterleitungen:** Reiter **„🔁 Routing“**. Wartende
Einträge tragen das Abzeichen **„Admin-Prüfung“** (oder „DNS prüft“), darunter den
Grund.

1. Grund lesen, Hostname und Backend-URL bzw. Ziel prüfen (zeigt das Backend auf ein
   internes System wie Proxmox, Datenbank, AD-Passwort-API? Dann nicht freigeben).
2. **„Genehmigen“** → „Route genehmigen und aktiv schalten?“ bzw. „Umleitung
   genehmigen und aktiv schalten?“ bestätigen.
3. Meldet die Seite „Hinweis: Server hat die Freigabe nicht übernommen (Status: …)“,
   ist die Freigabe nicht gespeichert – erneut versuchen oder in den Logs der API
   nachsehen.

**Mail-Relays:** Reiter **„✉ Mailserver/PMG“**, Abschnitt **Mail-Relays**.

1. **„Genehmigen“** – der Bestätigungstext nennt das Ziel (`host:port`, IMAPS, SMTPS),
   wohin PMG und Traefik danach verbinden.
2. Bestätigen.

Beide Traefik-Generatoren übernehmen nur Einträge mit Status `approved` und prüfen
Hostnamen, SNI und Ports beim Erzeugen erneut.

### 6.3 Namen in unseren Zonen (DNS einrichten)

Nach der Freigabe kann der Besitzer in `isp-mein-zugang.html` den DNS-Eintrag
(CNAME auf `ROSENWEG_DNS_CNAME_TARGET`, Standard `public.rosenweg4303.ch`) in unserer
Cloudflare-Zone selbst setzen lassen. Abgelehnt werden dabei Wildcards („Für
Wildcard-Namen setzen wir keinen DNS-Eintrag“), noch nicht freigegebene Einträge („Der
Eintrag wartet auf die Freigabe durch einen Admin“) und echte Überschneidungen mit
fremden Einträgen. An der Zonenwurzel ist kein CNAME möglich. Admins dürfen den
Eintrag immer setzen.

---

## 7. Freigabe-Outbox (`verwaltung-mail-outbox.html`)

Hier warten alle Mails an die externe Verwaltung (Auszahlungsaufträge) und alle Mails
aus dem Mail-Composer.

1. Filter **Status** (Voreinstellung „Pending“). Der Menüpunkt zeigt die Zahl
   wartender Mails.
2. Mail anklicken. Angezeigt werden An, CC, Reply-To, Betreff, Text, Anhänge,
   Freigaben und – nach einer Bearbeitung – „Original (vor Edit) anzeigen“.
3. Optional Felder korrigieren → **„Änderungen speichern“**. Jede inhaltliche Änderung
   setzt bisherige Freigaben zurück („N bisherige Freigabe(n) wurden zurückgesetzt …“).
4. **„Freigeben & Senden“**. Je nach Regel genügt eine Freigabe, oder es braucht
   mehrere verschiedene Personen („Freigabe verbucht (1/2). Es werden noch 1 weitere
   Freigaben … benötigt.“). Zweimal dieselbe Person: „Du hast bereits freigegeben …“.
5. Oder **„Ablehnen“** mit Pflicht-Grund. Bei Auszahlungs-Mails bekommen Prüfer und
   Einreichende eine E-Mail und WhatsApp mit dem Grund.

Die Regeln (welche Gruppen, wie viele Freigaben, ab welchem Betrag) stehen in
`mail-approval-config.html`. Standard: eine Freigabe durch `technik` oder
`praesident`.

---

## 8. NOC-Wandbild mit Token

Das Wandbild `noc-fullscreen.html` (auf `www.…` und `noc.rosenweg4303.ch`) zeigt Mail-
und Netzwerkzustand. Darunter steht der Abschnitt **Stationen**: je Gerät eine Karte,
rot und gelb zuerst. Rot = Anschluss-Abweichung, doppelt, Anzeige aus, Arbeitsplatz über drei
Tage still; gelb = gesperrt, Arbeitsplatz aus, Wartung steht still; blau = Update/SSH-Wartung
läuft; grau = darf aus sein (Laptop, Kiosk-TV, Chromecast) oder Windows ohne Agent. Online heisst:
Lebenszeichen jünger als 15 min (Kiosk, Chromecast: 5 min). Wer angemeldet ist, zeigt das NOC nicht.

Ganz unten der Abschnitt **Server**: Proxmox-Knoten, Quorum, HA, Ceph (mit Gründen, z. B. slow
ops), SSD-Abnutzung der OSDs (SMART „Percentage Used“: ab 80 % gelb, ab 90 % rot; verstellbar mit
`NOC_SSD_GELB`/`NOC_SSD_ROT`), Gäste mit Autostart, die nicht laufen, und der PBS (Belegung, Jobs,
fehlgeschlagene Aufgaben der letzten 24 h, Gäste mit Sicherung älter als 36 h). Gezeigt werden nur
Gäste aus `PBS_NOC_NAMESPACES` (Standard `Rosenweg9`); private Namespaces erscheinen nicht.
Ceph-Meldungen, deren Code mit einem Präfix aus `NOC_CEPH_STUMM` beginnt (Standard `AUTH_INSECURE_`,
die bekannte Altlast), stehen gedämpft da und färben die Ampel nicht. Die Bewertung steht als reine
Funktion in `api/lib/nocserver.js`; `alsErgebnisse()` liefert sie in der Form der geplanten
Prüfmodule (`infra.*`, `backup.*`, Status ok/warn/crit/unbekannt).
Einrichten (nur lesende Tokens, in `/opt/rosenweg-core/.env` auf CT 128):

- PVE: `pveum user add noc@pve --comment "NOC, nur lesen"`,
  `pveum user token add noc@pve audit --privsep 1`,
  `pveum acl modify / --users noc@pve --roles PVEAuditor`,
  `pveum acl modify / --tokens 'noc@pve!audit' --roles PVEAuditor` →
  `PVE_AUDIT_TOKEN=noc@pve!audit=<geheimnis>`
- PBS: `proxmox-backup-manager user create audit@pbs --comment "NOC/Sicherungen, nur lesen"`,
  `proxmox-backup-manager user generate-token audit@pbs api`,
  `proxmox-backup-manager acl update / Audit --auth-id 'audit@pbs!api'` →
  `PBS_AUDIT_TOKEN=audit@pbs!api:<geheimnis>` und `PBS_FINGERPRINT=<sha256 aus proxmox-backup-manager cert info>`
  (schaltet zugleich `/sicherungen` frei). Es hat drei Betriebsarten:

| Aufruf | Sicht |
|---|---|
| angemeldet als Technik/Präsident, ohne Token | volle Sicht über die geschützten Admin-Routen |
| mit Token `#token=<NOC_PUBLIC_TOKEN>` | volle Sicht über `/api/isp/noc/public/*`, ohne Anmeldung |
| ohne Token, nicht angemeldet, `NOC_PUBLIC_OPEN=1` | gekürzt: keine MAC/Hostnamen, keine IPs, keine WAN-IP, keine LXC-Liste, keine Top-Absender |
| ohne Token, nicht angemeldet, ohne `NOC_PUBLIC_OPEN` | 403 „Token ungueltig“ (oder 503, wenn `NOC_PUBLIC_TOKEN` gar nicht gesetzt ist) |

Einrichten eines Wandbildschirms:

1. `NOC_PUBLIC_TOKEN` in `/opt/rosenweg-core/.env` (CT 128) setzen (Wert
   `<im Passwortmanager>`), API neu starten.
2. Im Kiosk-Browser als Startseite
   `https://noc.rosenweg4303.ch/noc-fullscreen.html#token=<im Passwortmanager>`
   eintragen. Das Token steht im Fragment (`#`), damit es nicht in Server- und
   Proxy-Logs landet; die Seite schickt es als Kopfzeile `X-Noc-Token`. Die alte Form
   `?token=` funktioniert noch, landet aber in Logs.
3. Die Seite entfernt das Token nach dem Laden aus der Adresszeile. **Ein Neuladen von
   Hand (F5) läuft deshalb ohne Token.** Der Kiosk muss also die gespeicherte
   Startadresse neu öffnen, nicht die aktuelle Seite neu laden.

Token wechseln: neuen Wert in `.env`, API neu starten, Startadresse aller Wandbilder
anpassen.

---

## 9. SSH-Zugriffsmatrix (`ssh-zugriffsmatrix.html`)

Regelt, wer auf welchen Host per SSH (und mit sudo) kommt. Technischer Hintergrund:
[ssh-zugang.md](ssh-zugang.md).

- **Wirkung**: Tabelle Person × Host mit „ssh“, „sudo“ oder „—“. Nur Personen mit
  hinterlegtem Schlüssel erscheinen.
- **Regeln**: Die feste Regel „Gruppe `technik` auf allen Hosts → SSH + sudo“ steht im
  Code und lässt sich hier nicht entfernen.
- **Hosts**: melden sich selbst, sobald sie Schlüssel abholen; „stillgelegt“ heisst,
  dort bekommt niemand mehr Schlüssel.

Regel anlegen oder ändern:

1. **„+ Regel anlegen oder ändern“** aufklappen.
2. **Gilt für**: einen Host oder „alle Hosts“.
3. **Art**: Gruppe oder Benutzer; **Name** (z. B. `technik` oder der Benutzername).
4. **Gewährt**: „SSH“, „SSH + passwortloses sudo“ oder „Entzug (ausdrücklich kein
   Zugang)“.
5. **„Speichern“**. Gibt es schon eine Regel für dieselbe Kombination, wird sie
   geändert.

Auswertung: Die spezifischere Regel gewinnt – Benutzer schlägt Gruppe, ein einzelner
Host schlägt „alle Hosts“. Ein Entzug schlägt eine allgemeinere Erlaubnis. Ohne Regel
kein Zugang.

Regel entfernen: **„Entfernen“** → „Regel entfernen? Wer nur über sie berechtigt war,
kommt danach nicht mehr hinein.“

Unabhängig von der Matrix gilt (siehe [sicherheit.md](sicherheit.md), Abschnitt 4.9):
Systemkonten (`root`, `ansible`, `claude`, `github`, …, ergänzbar über
`SSH_GESPERRTE_LOGINS`) bekommen nie Schlüssel über diesen Weg, und Sitzungsschlüssel
gibt es nie für Technik-/sudo-Konten.

---

## 10. MQTT-App-Passwörter

Ein App-Passwort erlaubt einem Gerät oder Programm (Home Assistant, Skript) die
Anmeldung am MQTT-Broker mit dem Authentik-Benutzernamen. Hintergrund und
Authentik-Einrichtung: [mqtt-authentik-login.md](mqtt-authentik-login.md).

Voraussetzung: `MQTT_PASSWORD_LOGIN=1` in der API-Umgebung, sonst zeigen die Seiten
den Zugang als ausgeschaltet.

**Für eine andere Person vergeben** (nur Gruppe `technik`, nur aus einer
Browsersitzung – ein persönliches Zugangstoken (PAT) wird abgelehnt):

1. `mqtt.html` → Reiter **Zugriffsverwaltung** → Abschnitt **„Bewohner-MQTT-Zugang
   (App-Passwörter)“**.
2. Unter „Bewohner suchen (Name / E-Mail, min. 2 Zeichen)“ suchen → **„Suchen“** →
   Person wählen. Angezeigt werden Benutzername,
   Gruppen, die Topics, die sie lesen darf, und vorhandene App-Passwörter.
3. Bezeichnung eingeben → **„App-Passwort erzeugen“**.
4. Das Passwort wird **nur jetzt** angezeigt. Sicher an die Person übergeben (nicht
   per Klartext-Mail).
5. Widerrufen: beim Passwort **„widerrufen“** → „App-Passwort widerrufen? Geräte mit
   diesem Passwort können sich dann nicht mehr anmelden.“

Bewohner erzeugen eigene App-Passwörter selbst in der PWA **„Meine Daten“**
(`pwa.rosenweg4303.ch/daten/`), höchstens 10 je Konto. Verwaltet werden nur
Authentik-Tokens mit dem Kennzeichen `mqtt-<pk>-…`; andere App-Passwörter des Kontos
bleiben unberührt.

---

## 11. Energie-Konfiguration (`energie-config.html`)

Zähler, Tarife und Zuordnungen des Energy-Collectors (CT 129). Schreibende Aufrufe
gehen über die API (`/api/energie-admin/*`, Recht „Energie-Konfiguration“ = `write`,
Lesen = `read`), die den Admin-Schlüssel `ENERGY_ADMIN_API_KEY` anhängt. Direkt am
Collector sind sie ohne Schlüssel gesperrt.

### 11.1 Zähler

1. Reiter **Zähler** → **„+ Zähler hinzufügen“**.
2. **ID** (eindeutig, Form `<haus>-<bereich>`, daraus entsteht das MQTT-Topic
   `energy/<haus>/<bereich>`), **Name**, **Typ** (Modbus TCP, Shelly, SmartFox),
   **IP-Adresse**, **Port**, **Modbus Unit ID**, **Shelly-Modell**, **Kategorie**
   (Verbraucher, Netzübergabe, Erzeugung), **Gruppe**, **Standort / Zuordnung**.
3. **„Verbindung testen“**, dann **„Speichern“**.

Der Collector prüft jedes Ziel (Schutz vor Missbrauch als Portscanner, siehe
[sicherheit.md](sicherheit.md), Abschnitt 1.1):

| Meldung | Bedeutung |
|---|---|
| „host muss eine IP-Adresse sein (keine Namen, kein Port)“ | nur IP-Literal eintragen |
| „host … liegt ausserhalb der Zaehlernetze (METER_NETWORKS)“ | Zähler liegt nicht im erlaubten Netz (Standard `100.64.90.0/24`); bei einem neuen Zählernetz `METER_NETWORKS` in `/opt/rosenweg-energy/.env` (CT 129) ergänzen |
| „Modbus-Port … nicht erlaubt (erlaubt: 502)“ | Modbus nur auf `MODBUS_ALLOWED_PORTS` |
| „host … ist nicht erlaubt (Loopback/Link-Local/Multicast/reserviert)“ bzw. „(Collector/DB)“ | gesperrte Adresse |
| „Unbekannter Zaehlertyp …“ | nur modbus, shelly, smartfox |
| „Energie-Admin nicht konfiguriert“ (503) | `ENERGY_ADMIN_API_KEY` fehlt in der API-Umgebung |
| „Energy-Collector nicht erreichbar“ (502) | Collector (CT 129) läuft nicht oder ist nicht erreichbar |

Shelly und SmartFox werden immer über `http://<ip>/` (Port 80) abgefragt; das Feld
Port gilt dort nicht.

### 11.2 Tarife

Reiter **Tarife** → **„+ Tarif hinzufügen“**: Name, Preis pro kWh (CHF),
Beschreibung, gültig ab, gültig bis (leer = unbefristet).

### 11.3 Benutzer- und Gruppen-Zuweisungen

Reiter **Benutzer-Zuweisungen**: Zähler wählen, dann Benutzer oder Authentik-Gruppe →
**„Zuweisen“**. Die Zuordnungen bestimmen, welche Zähler eine Person im Dashboard, in
der Zähler-PWA und per MQTT (`energy/<haus>/<bereich>`) sieht. Die Liste mit den
E-Mail-Adressen ist nur hier sichtbar.

---

## 12. Weitere Vorgänge, die nur die Technik macht

| Vorgang | Wo | Hinweis |
|---|---|---|
| ZEV-Rechnung auf eine andere Wohnung umhängen, Rechnungen ohne STWEG zuordnen | `stweg3/pages/zev-smartme.html` | Ausschuss bekommt „Umhängen nur durch Technik“ |
| ZEV Alias-Domain / Alias-Prefix ändern | dito | bestimmt, welche Mailcow-Aliase überschrieben bzw. deaktiviert werden |
| Auto-Zuweisung „Alle STWEG (Standard)“ | `reklamationen.html` → ⚙️ | gilt für alle STWEGs ohne eigene Regel |
| Melde-Orte ohne STWEG („Allgemein / keiner“) | `melde-orte.html` | |
| Dokumente in gesperrten Unterordnern | Dokumente | `auslagen/`, `anzeigen/`, `reklamationen/`, `unterschriftenlisten/`, `grundbuch-bilder/` |
| E-Mail-Log | `email-log.html` | nur Technik/Präsident |
| Ankündigungen und Notfall auf den Anzeigen | `stationen.html` | nur Gruppe `technik`; siehe [mqtt-display.md](mqtt-display.md) |
