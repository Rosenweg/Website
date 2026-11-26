# Gruppenrichtlinie «Rosenweg-Look Windows»

Windows-Rechner der Domäne sehen damit aus wie die Stationen:

- dasselbe Hintergrund- und Sperrbild
- Akzentfarbe Mint-Blau `#0C75DE`
- Taskleiste links
- Rosenweg als Hersteller mit Logo
- das Logo als Standard-Kontobild
- BGInfo: Rechner, Adressen, angemeldete Person, Windows-Stand und letztes Update oben rechts auf dem Hintergrund (`bginfo.ps1`, bei jeder Anmeldung)
- eine Programm-Whitelist (AppLocker): Grundschutz erzwungen, Positivliste von /stationen zuerst in Überwachung. Siehe unten
- die Laufwerke H: (Home) und D: (Dokumente) bei jeder Anmeldung
- die Drucker DruckerR9 und DruckerR13 über den CUPS-Server (IPP, ohne Herstellertreiber, A4)
- aufgeräumte Drucker im Benutzerprofil und der Standarddrucker der Station (gepflegt auf /stationen): Siehe unten
- Windows 11: das klassische Startmenü Open-Shell mit dem Rosenweg-Wappen als Start-Knopf: Siehe unten

Gilt für alle Rechner in `OU=Windows`. Seit dem 22.11.2026 liegt dort `WIN11-1` (VM 107 auf pve3, Windows 11 Enterprise).

| Datei | Zweck |
|---|---|
| `einrichten.sh` | auf dc1 als root: OU, Rechner verschieben, Richtlinie anlegen und verlinken, Inhalt ins sysvol, Version hochzählen |
| `rosenweg-look.ps1` | Startskript, läuft beim Start als SYSTEM und setzt alles; Protokoll in `C:\ProgramData\Rosenweg\look.log` |
| `bilder/` | `hintergrund.png` und `sperrbild.png` aus os-stationen, `logo.png` von der Website, `startknopf.png` (aus dem Logo, `startknopf-erzeugen.py`) |
| `programme.ps1` | baut die AppLocker-Regeln aus der Liste auf /stationen und wertet aus, was sie blockiert (hätte); beim Start und alle 30 min |
| `drucker.ps1` | räumt die Drucker im Profil auf und setzt den Standarddrucker, bei jeder An- und Abmeldung |
| `startknopf-erzeugen.py` | erzeugt `bilder/startknopf.png` neu, falls sich das Logo ändert (braucht Pillow) |
| `programme/` | nicht im Git: der Open-Shell-Installer, den `einrichten.sh` mit Prüfsumme holt |

## Ändern

Bilder oder Skript anpassen, dann auf dc1 im Ordner `./einrichten.sh` ausführen. Das Skript zählt die Version hoch, sodass die Rechner beim nächsten Start den neuen Stand holen. dc2 bekommt die Dateien über `sysvol-abgleich`.

## Warum so

- **Richtlinie direkt in der sam.ldb statt über `samba-tool gpo create`:** Das Maschinenkonto des DC darf keine Richtlinien anlegen, und ein Admin-Passwort gehört nicht in ein Skript.
- **`scripts.ini` mit `powershell.exe -ExecutionPolicy Bypass` statt `psscripts.ini`:** Ein Windows-Client steht ab Werk auf `Restricted` und würde das Skript sonst verweigern.
- **Hintergrund und Sperrbild über PersonalizationCSP:** Das geht nur bei Enterprise/Education, und Benutzer können es nicht überschreiben. Auf den Stationen gehören diese Bilder ebenfalls der Station.
- **Taskleiste links:** Das ist eine Benutzereinstellung. Das Skript lädt deshalb beim Start jedes Profil und die Vorlage für neue Profile kurz und setzt sie dort.

## Programm-Whitelist (AppLocker)

Zwei Regelwerke, gebaut von `programme.ps1` (läuft beim Start und danach alle 30 min als SYSTEM, Aufgabe «Rosenweg Programme»):

- **Grundschutz**, seit dem 22.11.2026 durchgesetzt: alles unter `C:\Windows` und den Programme-Ordnern, signierte Store-Apps, OneDrive. Blockiert vor allem Heruntergeladenes (Downloads, AppData). Seit 26.11. auch die Defender-Plattform (`C:\ProgramData\Microsoft\Windows Defender\Platform`): dorthin aktualisiert sich Defender, und der Grundschutz blockierte `DefenderAIPlatformHost.exe` (Ereignis 8004 auf win11-1).
- **Positivliste** wie auf den Linux-Stationen: unter Programme und bei den Store-Apps nur, was auf **/stationen** erlaubt ist. Gepflegt im Kasten «Windows-Programme» (für alle) und beim Rechner unter «Aktionen ▾» → «Einstellen …» → «Programme» (zusätzlich nur dort). Den Katalog (welche Programme es zur Auswahl gibt, mit ihren Regeln) führt `api/lib/windowsprogramme.js`.

**Modus** (auf /stationen, für alle oder je Rechner):

| Modus | durchgesetzt | gemeldet |
|---|---|---|
| Überwachen (Vorgabe) | Grundschutz | was die Positivliste blockiert *hätte*: jedes Programm aus dem AppLocker-Protokoll (8002, 8020) geht durch `Test-AppLockerPolicy` gegen die Liste |
| Durchsetzen | Positivliste | was sie blockiert hat (8004, 8022) |

Die Auswertung (letzte 30 Tage) zeigt /stationen beim Rechner, mit Knöpfen «… anhaken» (Programm aus dem Katalog) oder «hier erlauben» (Ordner unter Programme). Ein Rechner, den die Verwaltung nicht kennt, bekommt immer «Überwachen».

**Immer erlaubt**, unabhängig von der Verwaltung: `C:\Windows`, die Defender-Plattform, Dienste (SERVICE, LocalService, NetworkService) unter Programme, die AD-Gruppe **Windows-Programme-frei** (enthält Domain Admins) und Administratoren mit Admin-Token: alles. Die API kann nur *erlauben*, und nur unter den Programme-Ordnern; `programme.ps1` prüft das noch einmal.

**Warum eine eigene Gruppe statt Administratoren:** Mit UAC trägt das Token eines Admins die Gruppe Administratoren nur als «deny-only». AppLocker würde ihn dann behandeln wie alle anderen. Eine gewöhnliche AD-Gruppe filtert UAC nicht.

**Programm freigeben:**

- im Katalog: auf /stationen anhaken (für alle oder je Rechner). Wirkt innerhalb von 30 min.
- unter Programme, aber nicht im Katalog: auf /stationen unter «Weitere Freigaben» eine Zeile `C:\Program Files\Hersteller\Programm\*` oder den Paketnamen der Store-App.
- ausserhalb von Programme: in `programme-freigaben.txt` eintragen (nur Orte, die normale Benutzer nicht beschreiben können), dann auf dc1 `./einrichten.sh`. Wirkt beim nächsten Start.
- dauerhaft alles für eine Person: in die Gruppe Windows-Programme-frei aufnehmen.

**Von Hand prüfen** (als Admin, ändert nichts): `& 'C:\Program Files\Rosenweg\programme.ps1' -NurPruefen -AlsPerson Jeder` wertet das ganze Protokoll aus, als hätte eine normale Person alles gestartet. Ablage und Protokoll: `C:\Program Files\Rosenweg\programme\` (`programme.log`, `positivliste.xml`, `aktiv.xml`, `probe.json`). Nicht unter ProgramData: dort dürfen normale Benutzer Dateien anlegen, und eine untergeschobene Liste wäre eine Freigabe.

**Nicht Teil der Positivliste:** Skripte und MSI bleiben wie im Grundschutz (Skripte aus Windows, Programme, SYSVOL/NETLOGON; MSI nur aus `C:\Windows\Installer`). DLL-Regeln sind aus.

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
   - **Fest:** `MenuStyle=2` (Windows 7), `MouseClick=1` und `WinKey=1` (klassisches Menü), `EnableStartButton=1`, `StartButtonType=2` (eigenes Bild), `StartButtonPath=C:\ProgramData\Rosenweg\startknopf.png`, `StartButtonSize=48`.
   - **Nur Vorgabe:** Skin `Immersive`. Er folgt hell/dunkel und der Akzentfarbe.
   - **Aus:** die Update-Prüfung (`OpenShell\Update=0`).
4. Wirksam wird Open-Shell bei der nächsten Anmeldung. Es startet über `HKLM\...\Run`, ein Explorer-Neustart ist nicht nötig.

**Start-Knopf:** `bilder/startknopf.png`, 144×432 px, PNG mit Transparenz. Open-Shell erwartet die drei Zustände untereinander: normal, darüber und gedrückt (`StartButton.cpp`: Höhe ÷ 3). Je Zustand sind es 144 px, weil Open-Shell die 48 px Breite mit der Anzeigeskalierung hochrechnet. So bleibt der Knopf bis 300 % scharf. Für ein neues Logo: `python3 startknopf-erzeugen.py`, danach `./einrichten.sh`.

**Windows 10 auch:** In `rosenweg-look.ps1` `$OpenShellAbBuild = 10240` setzen.

**Neue Version:**

1. Version, Dateiname und Prüfsumme in `rosenweg-look.ps1` **und** `einrichten.sh` ändern. Die Prüfsumme steht bei GitHub am Release-Asset (`digest`).
2. `./einrichten.sh` ausführen.

Der Installer macht das Upgrade selbst.

**Zurücknehmen:** In `rosenweg-look.ps1` `$OpenShellAn = $false` setzen und `./einrichten.sh` ausführen. Beim nächsten Start entfernt das Skript Open-Shell still (`msiexec /x`) und löscht die Richtlinien. Ab der nächsten Anmeldung ist wieder das Startmenü von Windows 11 da.
