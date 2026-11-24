# Plan: AD-Home als einziger persönlicher Ordner

Stand 24.11.2026 · Entscheid Stefan: Der persönliche Ordner ist der AD-Home.
Die Nextcloud zeigt ihn an, statt einen eigenen zu führen.

## Ausgangslage

| | AD-Home | Nextcloud persönlich |
|---|---|---|
| Ort | CephFS `/userdata/home/<name>` | Platte von CT 104, `data/<name>/files` |
| Zugang heute | Windows (H:, Ordnerumleitung per `logon.bat`, Testphase nur stefan.mueller), Linux-Stationen | Browser, Rosenweg Files, Dateiauswahl am Telefon |
| Inhalt | nur `stefan.mueller` hat einen (42 GB) | praktisch leer (nur Testdateien) |
| Rechte | `700`, Besitzer = Person (idmap-rid-uid, bei Stefan 11184), keine ACL | Nextcloud |
| Sicherung | CT 134 liest `/userdata` (read-only, als root) | mit CT 104 |

Es gibt also zwei persönliche Ordner, die nichts voneinander wissen. Weil der
Nextcloud-Ordner leer ist, muss nichts umgezogen werden.

## Ziel

- In der Nextcloud gibt es den Ordner **„Persönlich“**. Das ist für jede Person ihr AD-Home.
- Es ist derselbe Ordner unter Windows (H:, Dokumente/Desktop/Bilder), auf den
  Linux-Stationen, im Browser, in Rosenweg Files und in der Dateiauswahl am Telefon.
- Uploads vom Telefon (Kamera, Diktiergerät, Notizen, Paint) landen in
  `Persönlich/…`, also im AD-Home.
- Zugriff hat nur die Person selbst und der Nextcloud-Dienst, nicht Technik.

## Schritte

### 1. Dienstgruppe für die Nextcloud (AD)

- Eine AD-Gruppe `nextcloud-dienst` anlegen, ohne Mitglieder. Ihre gid kommt per `wbinfo` aus idmap rid.
- In CT 104 eine lokale Gruppe mit **dieser gid** anlegen und `www-data` aufnehmen.
  Das ist dasselbe Muster wie bei `technik` 11156 vom 24.11., aber eine eigene Gruppe.
- **Warum nicht `technik`:** Über Samba könnte sonst jedes Technik-Mitglied fremde Homes lesen.

### 2. ACL auf den Homes (Fileserver, CT 206)

Für jeden Home `/userdata/home/<name>`:

```
user::rwx
user:<uid der Person>:rwx
group::---
group:<gid nextcloud-dienst>:rwx
mask::rwx
other::---
default: dasselbe
```

- Neue Dateien erben die ACL, egal ob die Person sie über Samba anlegt oder die Nextcloud (als www-data).
  Dateien, die die Nextcloud anlegt, **gehören www-data (uid 33)**, nicht der Person. Die Person hat
  über den Eintrag `user:<uid>` trotzdem vollen Zugriff.
- **Voraussetzung Samba:** `[home]` hat heute `create mask = 0600`, `directory mask = 0700`, `inherit acls = No`.
  Damit bekäme alles, was über Samba neu angelegt wird, die Maske `---`, und die Nextcloud käme nicht heran.
  Vor dem Anwenden `inherit acls = yes` in `[home]` auf **CT 106 und CT 206** setzen.
- **Voraussetzung Nextcloud:** `localstorage.umask` ist nicht gesetzt (Standard 0022). Dadurch bekämen
  Dateien der Nextcloud die Maske `r--`, und die Person könnte sie über Samba nicht ändern.
  `'localstorage.umask' => 0007` in die config.php.
- Für bestehende Inhalte (42 GB bei Stefan) wird die ACL rekursiv gesetzt.
- Ablauf wie bei den Ordnerrechten: erst `getfacl`-Sicherung, dann Trockenlauf, dann anwenden.
  Dafür ein eigenes Skript `homes-rechte.sh` neben `/root/ordnerrechte/` (oder als neue Zeilenart dort).
- `profiles/` bleibt unberührt, die Roaming-Profile gehen die Nextcloud nichts an.

### 3. Homes für alle anlegen

Die Nextcloud-Einbindung ist leer, solange es keinen Home gibt. Heute legt Windows ihn erst bei der ersten Anmeldung an.

- Auf dem Fileserver läuft ein Timer, der für jedes Mitglied von `rosenweg` einen fehlenden Home anlegt,
  mit Besitzer = Person und der ACL aus Schritt 2.
- Alternativ kann das `ad-sync/sync.py` auf dc1 übernehmen. dc1 bindet `/userdata` aber nicht ein,
  deshalb lieber auf dem Fileserver.

### 4. Einbindung in CT 104

- `mp1: /mnt/pve/userdata/home,mp=/mnt/cephfs-userdata/home` ergänzen, **nur `home`**, nicht `profiles`.
  Prüfen, ob das ohne Neustart von CT 104 geht; sonst ein kurzes Wartungsfenster.
- Neue externe Einbindung: `/Persönlich`, Backend Local, Pfad `/mnt/cephfs-userdata/home/$user`,
  gilt für die Gruppe `rosenweg` (bzw. alle), Teilen erlaubt.
  `$user` funktioniert bei Local, das ist geprüft (`UserPlaceholderHandler` gilt für alle Backends).
- Änderungen über Samba sieht die Nextcloud beim nächsten Öffnen (`filesystem_check_changes`, Standard).
  Beim ersten Öffnen von Stefans Home sind 42 GB zu scannen. Das per `occ files:scan` vorab
  und nicht im Sicherungsfenster ab 01:00 machen.

### 5. Nextcloud-eigenen Ordner zurückdrängen

- Damit niemand versehentlich am alten Ort ablegt: in der Wurzel nichts Eigenes mehr.
  Varianten:
  - **a)** Quota der Personen klein setzen, sodass in der Wurzel nur noch Freigaben empfangen werden.
  - **b)** nur ein Hinweis.
- Zu entscheiden, sobald „Persönlich“ läuft.
- Meine Testdateien (`rw-schreibtest.txt`, „Testkopien Rosenweg Files“) vorher löschen.

### 6. Apps

- **Rosenweg Files:**
  - Startordner der Nextcloud-Ansicht ist „Persönlich“.
  - Die Wurzel mit `allgemein`, `stwegN` usw. bleibt erreichbar.
- **cloud-Bibliothek:** Für die Upload-Warteschlange (Kamera usw.) ist das Standardziel `Persönlich/<App>`,
  zum Beispiel `Persönlich/Kamera`.

## Risiken / zu prüfen

- ~~Windows-Attribut READONLY~~ **geprüft, kein Risiko:** Samba hat `map readonly = no` und
  `store dos attributes = yes`. READONLY steht nur in `user.DOSATTRIB` und ändert den Unix-Modus nicht.
  Die Nextcloud greift lokal aufs CephFS zu und ist davon nicht betroffen.
- ~~GPO „Grant the user exclusive rights“~~ **geprüft:** Die GPO „Rosenweg-Folder Redirect“ ist leer
  (Version 0, kein fdeploy.ini). Die Umleitung macht `logon.bat` (md, robocopy, `reg add` für
  User Shell Folders, nur stefan.mueller). Dabei setzt Windows keine eigenen Rechte. Die leere GPO kann weg.
- **Samba `inherit acls`** bläht neue ACLs auf (siehe Probelauf Ordnerrechte). Das ist kosmetisch,
  die wirksamen Rechte stimmen.
- **Zugriff:** Wer root auf CT 104 hat, kann alle Homes lesen. Das gilt heute für die
  Nextcloud-Daten genauso.
- **Papierkorb/Versionen:** Bei externen Einbindungen legt die Nextcloud sie im eigenen Datenordner ab.
  Löschen über Samba geht dagegen in den `recycle`-Ordner von Samba. Zwei Papierkörbe; dokumentieren.

## Reihenfolge und Freigaben

1. ✓ 24.11.: AD-Gruppe `nextcloud-dienst` **gid 11280** (RID 1280), ohne Mitglieder; in CT 104 lokal mit
   gid 11280, `www-data` Mitglied, php-fpm neu gestartet. Sicherung `/root/group.vor-nextcloud-dienst-2026-11-24`.
2. ✓ 24.11.: Sicherung `/root/homes-rechte-sicherung/` (CT 206, 112'090 Einträge) und Trockenlauf
   `/root/homes-rechte/anwenden.sh` (Standard `--trocken`, ändert nur mit `--ausfuehren`).
   Ergebnis: 1 Home (stefan.mueller, uid 11184), 15'462 Ordner und 96'627 Dateien, keine Auffälligkeiten.
   Kopie der Sicherung auf CT 106 fehlt noch.
2b. Vor dem Anwenden: `inherit acls = yes` in `[home]` (CT 106 + 206) und `localstorage.umask` 0007. *(Freigabe)*
2c. Anwenden. *(Freigabe)*
3. Mountpoint in CT 104 und Einbindung „Persönlich“, zuerst nur für `technik`, also Stefan testet.
4. Timer für fehlende Homes.
5. Für alle freischalten, Apps anpassen, Nextcloud-Wurzel zurückdrängen.
