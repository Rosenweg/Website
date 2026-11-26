# Gruppenrichtlinie «Rosenweg-Look Windows»

Windows-Rechner der Domäne sehen damit aus wie die Stationen:

- dasselbe Hintergrund- und Sperrbild
- Akzentfarbe Mint-Blau `#0C75DE`
- Taskleiste links, mit dem Rosenweg-Wappen als Start-Knopf
- Rosenweg als Hersteller mit Logo
- das Logo als Standard-Kontobild
- BGInfo: Rechner, Adressen, angemeldete Person, Windows-Stand und letztes Update oben rechts auf dem Hintergrund (`bginfo.ps1`, bei jeder Anmeldung)
- eine Programm-Whitelist (AppLocker, erzwungen): Siehe unten
- die Laufwerke H: (Home) und D: (Dokumente) bei jeder Anmeldung
- die Drucker DruckerR9 und DruckerR13 über den CUPS-Server (IPP, ohne Herstellertreiber, A4)
- aufgeräumte Drucker im Benutzerprofil und der Standarddrucker der Station (gepflegt auf /stationen): Siehe unten
- Windows 11: das klassische Startmenü Open-Shell mit dem Rosenweg-Wappen als Start-Knopf: Siehe unten

Gilt für alle Rechner in `OU=Windows`. Seit dem 22.11.2026 liegt dort `WIN11-1` (VM 107 auf pve3, Windows 11 Enterprise).

| Datei | Zweck |
|---|---|
| `einrichten.sh` | auf dc1 als root: OU, Rechner verschieben, Richtlinie anlegen und verlinken, Inhalt ins sysvol, Version hochzählen |
| `rosenweg-look.ps1` | Startskript, läuft beim Start als SYSTEM und setzt alles; Protokoll in `C:\ProgramData\Rosenweg\look.log` |
| `bilder/` | `hintergrund.png` (aus dem Stationsbild von os-stationen, Logo und Schriftzug für Windows vertikal mittig gesetzt, damit die Stationsinfo oben rechts nichts verdeckt), `sperrbild.png` aus os-stationen, `logo.png` von der Website, `startknopf.png` (aus dem Logo, `startknopf-erzeugen.py`) |
| `drucker.ps1` | räumt die Drucker im Profil auf und setzt den Standarddrucker, bei jeder An- und Abmeldung |
| `startknopf-erzeugen.py` | erzeugt `bilder/startknopf.png` neu, falls sich das Logo ändert (braucht Pillow) |
| `programme/` | nicht im Git: der Open-Shell-Installer, den `einrichten.sh` mit Prüfsumme holt |

## Ändern

Bilder oder Skript anpassen, dann auf dc1 im Ordner `./einrichten.sh` ausführen. Das Skript zählt die Version hoch, sodass die Rechner beim nächsten Start den neuen Stand holen. dc2 bekommt die Dateien über `sysvol-abgleich`.

## Warum so

- **Richtlinie direkt in der sam.ldb statt über `samba-tool gpo create`:** Das Maschinenkonto des DC darf keine Richtlinien anlegen, und ein Admin-Passwort gehört nicht in ein Skript.
- **`scripts.ini` mit `powershell.exe -ExecutionPolicy Bypass` statt `psscripts.ini`:** Ein Windows-Client steht ab Werk auf `Restricted` und würde das Skript sonst verweigern.
- **Hintergrund und Sperrbild über PersonalizationCSP:** Das geht nur bei Enterprise/Education, und Benutzer können es nicht überschreiben. Auf den Stationen gehören diese Bilder ebenfalls der Station.
- **Taskleiste links:** Das ist eine Benutzereinstellung (`TaskbarAl=0`). Das Skript lädt deshalb beim Start jedes Profil und die Vorlage für neue Profile kurz und setzt sie dort. Der Start-Knopf von Open-Shell ist genau auf den linksbündigen Windows-Knopf zugeschnitten (siehe unten).
- **BGInfo pro Rechner:** Das Bild heisst `bginfo-<RECHNER>.png` und liegt in `%LOCALAPPDATA%`. Es wird bei jeder Anmeldung frisch erzeugt. Beim Abmelden setzt `bginfo.ps1 -Abmelden` den Hintergrund auf das neutrale Stationsbild zurück, als zweites Abmeldeskript. Windows legt nämlich eine Kopie des Hintergrunds im servergespeicherten Profil ab (`%APPDATA%\Microsoft\Windows\Themes`) und zeigt sie bei der nächsten Anmeldung zuerst an, auch auf einem anderen Rechner. So erschien auf WIN11-1 zuerst «R9-PC1, Windows 10».

## Programm-Whitelist (AppLocker)

Seit dem 22.11.2026 erzwungen. Erlaubt sind:

- alles unter `C:\Windows` und den Programme-Ordnern. Dort schreiben nur Admins, was ein Admin installiert, ist also sofort freigegeben.
- signierte Store-Apps und OneDrive
- Skripte aus SYSVOL/NETLOGON
- alles für die AD-Gruppe **Windows-Programme-frei** (enthält Domain Admins)

Alles andere wird blockiert, vor allem Programme aus Downloads oder AppData.

**Warum eine eigene Gruppe statt Administratoren:** Mit UAC trägt das Token eines Admins die Gruppe Administratoren nur als «deny-only». AppLocker würde ihn dann behandeln wie alle anderen. Eine gewöhnliche AD-Gruppe filtert UAC nicht.

**Programm freigeben**, das nicht in den Programme-Ordnern liegt:

1. Den Pfad in `programme-freigaben.txt` eintragen. Nur Orte, die normale Benutzer nicht beschreiben können.
2. Auf dc1 `./einrichten.sh` ausführen. Die Freigabe wirkt beim nächsten Start.

Eine Person dauerhaft von der Liste ausnehmen: in die Gruppe Windows-Programme-frei aufnehmen.

Geprüft mit `Test-AppLockerPolicy`: Eine Kopie von notepad.exe unter `C:\Users\Public` wird für «Jeder» abgelehnt (DeniedByDefault) und für stefan.mueller erlaubt (über Windows-Programme-frei).

## Drucker im Profil und Standarddrucker

**Warum:** Die Profile sind servergespeichert und tragen Druckereinträge von früheren PCs mit. Bei stefan.mueller standen am 26.11.2026 SMB-Verbindungen wie `\\100.64.2.32\DruckerR9`, ein HP und zwei Brother von einem alten PC, AnyDesk Printer und PDF24 im Profil. Als Standard war ein Drucker gesetzt, den es auf win11-1 nicht gibt. Programme druckten deshalb ins Leere, und beim CUPS kam nie etwas an.

**Was `drucker.ps1` macht** (im Namen der Person):

- Es entfernt aus dem Profil (HKCU) alle Druckerverbindungen und -einträge zu Druckern, die es auf **diesem** Rechner nicht gibt. Betroffen sind `Printers\Connections`, `Devices`, `PrinterPorts`, `DevModes2` und `DevModePerUser`. Rechnerweite Drucker werden nie angefasst, also bleiben DruckerR9, DruckerR13, «Microsoft Print to PDF» und lokal installierte Drucker.
- Es setzt den Standarddrucker der Station.
- Es schaltet «Windows verwaltet Standarddrucker» aus (`LegacyDefaultPrinterMode=1`), damit Windows nicht selbst auf den zuletzt benutzten Drucker umstellt.

**Wann es läuft:**

- **Bei der Anmeldung:** über die geplante Aufgabe «Rosenweg Drucker».
- **Bei der Abmeldung:** als Abmeldeskript der Richtlinie, bevor das Profil hochgeladen wird. So kommt das Profil sauber auf den nächsten Rechner.

**Warum Loopback:** Abmeldeskripte stehen im Benutzerteil einer Richtlinie. Die Konten liegen aber nicht in OU=Windows. Darum schaltet `rosenweg-look.ps1` Loopback im Modus «Zusammenführen» ein (`UserPolicyMode=1`). Die eigenen Benutzerrichtlinien gelten weiter, und der Benutzerteil dieser Richtlinie kommt dazu.

**Standarddrucker einstellen:** Auf /stationen beim Rechner unter «Aktionen ▾» → «Einstellen …» → «Drucken» → Standarddrucker wählen. Windows-Rechner der Domäne erscheinen dort von selbst (AD-Abgleich alle 15 min oder «Windows aus AD abgleichen»), mit Haus und Drucker aus OU oder Namensanfang (`R9-…` → DruckerR9); nur ein Rechner, der nicht im AD steht, wird mit «Windows-Rechner eintragen» angelegt.

Das Skript fragt `https://www.rosenweg4303.ch/api/stations/drucker/<RECHNER>` mit einer Zeitgrenze von 4 s. Die Antworten:

- **Drucker gesetzt:** Dieser Drucker wird Standard.
- **«keiner»:** Der Standard bleibt, wie er ist. Gibt es den bisherigen Drucker auf diesem Rechner nicht, wird `DruckerR9` Standard.
- **Rechner nicht eingetragen:** `DruckerR9` wird Standard (`$Vorgabe` in `drucker.ps1`).
- **Keine Antwort:** Es gilt der Wert, den `rosenweg-look.ps1` beim letzten Start geholt hat (`C:\ProgramData\Rosenweg\standarddrucker.json`).

Eine Änderung auf /stationen wirkt also bei der nächsten Anmeldung.

**Protokoll:** Ereignisanzeige → Windows-Protokolle → Anwendung, Quelle «Rosenweg Drucker». Jeder Lauf schreibt ein Ereignis mit dem, was entfernt oder gesetzt wurde.

**Prüfen, ohne etwas zu ändern:** Der Probelauf zeigt nur an, was entfernt würde. Gegen eine Kopie des Profils, als Admin:

```powershell
Copy-Item C:\Users\<name>\NTUSER.DAT C:\Windows\Temp\probe.dat
reg load HKU\Probe C:\Windows\Temp\probe.dat
& 'C:\Program Files\Rosenweg\drucker.ps1' -Anlass Probe -Wurzel 'Registry::HKEY_USERS\Probe'
reg unload HKU\Probe
```

Als die angemeldete Person selbst genügt `drucker.ps1 -Anlass Probe`.

**Zurücknehmen:**

- Die Aufgabe «Rosenweg Drucker» löschen und den Block «Drucker im Profil» in `rosenweg-look.ps1` entfernen.
- In `einrichten.sh` das Abmeldeskript entfernen und `./einrichten.sh` ausführen.
- Was schon entfernt wurde, ist weg. Es waren aber nur Einträge zu Druckern, die es auf dem Rechner nicht gab.

## Startmenü: Open-Shell (Windows 11)

**Was:**

- [Open-Shell](https://github.com/Open-Shell/Open-Shell-Menu) (Nachfolger von Classic Shell, MIT-Lizenz) ersetzt das Startmenü von Windows 11 durch das klassische im Windows-7-Stil mit zwei Spalten.
- Als Start-Knopf dient das Rosenweg-Wappen statt der Muschel.
- Ein Klick auf den Knopf und die Windows-Taste öffnen das klassische Menü.
- Umschalt+Klick und Umschalt+Win öffnen weiterhin das Menü von Windows 11.
- Die Taskleiste bleibt die von Windows.

**Version:** 4.4.198 (aktuelles stabiles Release vom 12.05.2026), `OpenShellSetup_4_4_198.exe`, SHA-256 `a4d2d4459de55b5e962ba2a14f7bb794170511649138173dfa72949837b48c3f`. Die Prüfsumme stimmt mit der von GitHub angegebenen überein.

**Wie es auf den Rechner kommt:**

1. `einrichten.sh` lädt den Installer einmal von GitHub nach `programme/`, prüft die Prüfsumme und legt ihn ins sysvol. Der Installer kommt nicht ins Git, weil er ein 10 MB grosses Fremdprogramm ist. Hat dc1 kein Netz, die Datei von Hand nach `programme/` legen. Die Prüfsumme wird trotzdem geprüft.
2. `rosenweg-look.ps1` prüft beim Start, ob der Rechner Windows 11 hat (Build 22000 oder höher) und ob Open-Shell 4.4.198 schon installiert ist. Fehlt es oder ist eine andere Version installiert, kopiert das Skript den Installer nach `C:\Windows\Temp`, prüft die Prüfsumme erneut und installiert still nur die Startmenü-Komponente: `/qn ADDLOCAL=StartMenu NOSTART=1 START_MENU_FOLDER=0`. Explorer-Zusatz, IE-Teil und Update-Dienst werden nicht installiert, Updates kommen von hier.
3. Die Einstellungen setzt das Skript als Richtlinie unter `HKLM\SOFTWARE\Policies\OpenShell\StartMenu`, so wie die ADMX von Open-Shell sie schreibt: zu jedem Wert ein `<Name>_State`, 0 = fest, 2 = nur Vorgabe.
   - **Fest:** `MenuStyle=2` (Windows 7), `MouseClick=1` und `WinKey=1` (klassisches Menü), `EnableStartButton=1`, `StartButtonType=2` (eigenes Bild), `StartButtonPath=C:\ProgramData\Rosenweg\startknopf.png`, `StartButtonSize=56`, `StartButtonAlign=1` (unten bündig).
   - **Nur Vorgabe:** Skin `Immersive`. Er folgt hell/dunkel und der Akzentfarbe.
   - **Aus:** die Update-Prüfung (`OpenShell\Update=0`).
4. Wirksam wird Open-Shell bei der nächsten Anmeldung. Es startet über `HKLM\...\Run`, ein Explorer-Neustart ist nicht nötig.

**Start-Knopf:** `bilder/startknopf.png`, 168×432 px, PNG mit Transparenz.

- **Format:** Open-Shell erwartet die drei Zustände untereinander: normal, darüber und gedrückt (`StartButton.cpp`: Höhe ÷ 3). Das Bild ist in dreifacher Grösse gezeichnet, weil Open-Shell die 56 px Breite mit der Anzeigeskalierung hochrechnet. So bleibt der Knopf bis 300 % scharf.
- **Wichtig:** Unter Windows 11 legt Open-Shell seinen Knopf nur **über** den Windows-Knopf, an dessen linke Kante, und blendet diesen nicht aus. Wo das Bild durchsichtig ist, schaut das Windows-Symbol durch.
- **Masse:** Der linksbündige Windows-Knopf ist 55×48 px gross, sein Symbol sitzt bei x=21..43, Mitte (32 | 24), gemessen am 26.11.2026 auf win11-1. Das Wappen sitzt mit 40 px Durchmesser genau dort, die Herleitung steht in `startknopf-erzeugen.py`.
- **Zentrierte Taskleiste:** Dafür passt das Bild nicht, weil das Symbol dort 10 px weiter links sitzt. Für ein neues Logo: `python3 startknopf-erzeugen.py`, danach `./einrichten.sh`.

**Windows 10 auch:** In `rosenweg-look.ps1` `$OpenShellAbBuild = 10240` setzen.

**Neue Version:**

1. Version, Dateiname und Prüfsumme in `rosenweg-look.ps1` **und** `einrichten.sh` ändern. Die Prüfsumme steht bei GitHub am Release-Asset (`digest`).
2. `./einrichten.sh` ausführen.

Der Installer macht das Upgrade selbst.

**Zurücknehmen:** In `rosenweg-look.ps1` `$OpenShellAn = $false` setzen und `./einrichten.sh` ausführen. Beim nächsten Start entfernt das Skript Open-Shell still (`msiexec /x`) und löscht die Richtlinien. Ab der nächsten Anmeldung ist wieder das Startmenü von Windows 11 da.

## Nextcloud als Laufwerk N: (WebDAV)

**Was:** Bei jeder Anmeldung verbindet `nextcloud-laufwerk.ps1` die eigene Nextcloud (`https://nextcloud.rosenweg4303.ch/remote.php/dav/files/<name>`) als Laufwerk **N:** mit dem Namen «Nextcloud». Die Person muss das einmal freigeben, danach gibt es keine Abfrage mehr, auch nicht an einem anderen Rosenweg-PC.

**Was N: gegenüber H:/D: bringt:** Inhaltlich fast nichts. Die Nextcloud bindet dieselben CephFS-Ordner ein: `/docs` als `stwegN`, `meg`, `allgemein` usw. (wie D:) und den AD-Home als `Persönlich` (wie H:). Neu sind nur:

- was andere in der Nextcloud mit der Person teilen
- der eigene Nextcloud-Ordner (heute praktisch leer)
- die Ansicht so, wie sie in der Nextcloud und in Rosenweg Files aussieht

Die Rechte kommen dabei aus den Einbindungen der Nextcloud (pro Nextcloud-Gruppe, Eigentümer nur lesend) und nicht aus den Samba-ACLs. Für die Arbeit an Dateien bleiben H: und D: der bessere Weg: Sie sind schneller, haben Sperren und kennen keine Grössengrenze.

**Anmeldung, und warum so:**

- Die Konten der Nextcloud kommen aus Authentik (`user_oidc`). Es gibt kein LDAP-Backend und kein Nextcloud-Passwort. WebDAV mit Benutzername und AD-Passwort geht deshalb nicht, nur mit einem **App-Passwort**.
- Kerberos direkt an der Nextcloud bräuchte ein GSSAPI-Modul im Apache und ein zweites Benutzer-Backend neben `user_oidc`. Das ist zu viel Umbau für ein Laufwerk.
- Das App-Passwort holt das Skript über den **Login-Flow v2** der Nextcloud. Der Browser öffnet sich, die Person meldet sich bei Authentik an und klickt «Zugriff gewähren».
  - Im Haus genügt bei Authentik «SSO Login», das läuft über Kerberos ohne Passwort. Dafür stehen `authentik.rosenweg4303.ch` und `nextcloud.rosenweg4303.ch` in der Intranet-Zone. Edge und Chrome melden sich dann per Kerberos an, solange keine `AuthServerAllowlist` gesetzt ist. Kommt eine dazu, muss `authentik.rosenweg4303.ch` darin stehen.
- Gespeichert wird das App-Passwort mit DPAPI verschlüsselt in `%APPDATA%\Rosenweg\nextcloud.anmeldung`.
  - Lesen kann es nur die Person selbst. Es reist mit dem servergespeicherten Profil auf jeden Rechner.
  - Es steht nie im SYSVOL, in der Aufgabe oder in einer Befehlszeile: Verbunden wird mit `WNetAddConnection2`, nicht mit `net use … passwort`.
- Das App-Passwort läuft nicht ab und hängt nicht am AD-Passwort. Ungültig wird es nur, wenn es in der Nextcloud unter *Einstellungen > Sicherheit* widerrufen wird (Name «Windows-Laufwerk N: (eingerichtet auf RECHNER)») oder wenn das Konto gesperrt ist.
  - Dann bemerkt die nächste Anmeldung die 401, löscht das gespeicherte Passwort und fragt, ob neu verbunden werden soll.
  - Ist die Nextcloud nur nicht erreichbar, passiert nichts. N: fehlt dann bis zur nächsten Anmeldung.
- Wer bei der ersten Frage «Nein» sagt, wird nicht mehr gefragt (`HKCU\Software\Rosenweg\Nextcloud\NichtFragen`). Einrichten geht später über *Startmenü > Rosenweg > Nextcloud als Laufwerk N*.

**Rechnerweit setzt `rosenweg-look.ps1` beim Start:**

- `nextcloud-laufwerk.ps1` nach `C:\Program Files\Rosenweg` (Programm-Whitelist), die Aufgabe «Rosenweg Nextcloud» bei der Anmeldung (Gruppe Benutzer, 20 Minuten Laufzeit wegen der ersten Freigabe) und den Startmenü-Eintrag
- den Dienst **WebClient** auf «Automatisch». Ab Werk steht er auf «Manuell (Trigger)», und ohne laufenden Dienst scheitert das Verbinden mit Fehler 67.
- `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`:
  - `BasicAuthLevel=1`: Basic nur über HTTPS. Das ist die Vorgabe, hier festgehalten. Nie 2.
  - `FileSizeLimitInBytes=0xFFFFFFFF`: 4 GB statt 50 MB. Mehr kann der WebDAV-Client von Windows nicht. Nextcloud und Traefik haben keine tiefere Grenze (PHP 16 GB, keine Zeitlimits).
- die Intranet-Zone (`ZoneMapKey`, Wert 1) für `https://nextcloud.rosenweg4303.ch` und `https://authentik.rosenweg4303.ch`. Ohne das bekämen Dateien von N: die Internet-Markierung: Warnungen beim Öffnen, Office in der geschützten Ansicht.

**Grenzen des WebDAV-Clients:** Er hat keine echten Sperren und keinen Offline-Zugriff. Grosse Ordner öffnen sich langsamer als über SMB. Microsoft führt den WebClient seit Ende 2023 als «veraltet». Er ist in Windows 10 und 11 noch enthalten, wird aber nicht mehr weiterentwickelt. Die Alternative mit eigener Anmeldung ist der Nextcloud-Desktop-Client mit virtuellen Dateien (Platzhalter, Dateien werden erst beim Öffnen geladen). Dafür braucht es eine Installation und eine Freigabe in der Programm-Whitelist.

**Prüfen** als die angemeldete Person (ändert nichts):

```powershell
& 'C:\Program Files\Rosenweg\nextcloud-laufwerk.ps1' -Anlass Probe
```

Das zeigt, ob eine Anmeldung gespeichert ist, ob die Nextcloud sie annimmt, ob N: verbunden ist und ob der WebClient läuft. Das Protokoll steht in `%LOCALAPPDATA%\Rosenweg\nextcloud.log`.

**Für eine Person entfernen:** `nextcloud-laufwerk.ps1 -Anlass Entfernen` trennt N: und löscht die gespeicherte Anmeldung. Danach in der Nextcloud unter *Einstellungen > Sicherheit* das App-Passwort widerrufen.

**Zurücknehmen für alle:** In `rosenweg-look.ps1` `$NextcloudAn = $false` setzen und `./einrichten.sh` ausführen. Der nächste Start entfernt die Aufgabe, den Startmenü-Eintrag, das Skript und die beiden Zonen-Einträge. Der WebClient bleibt auf «Automatisch», das schadet nicht.
