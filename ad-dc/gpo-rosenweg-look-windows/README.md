# Gruppenrichtlinie «Rosenweg-Look Windows»

Windows-Rechner der Domäne sehen damit aus wie die Stationen:

- dasselbe Hintergrund- und Sperrbild
- Akzentfarbe Mint-Blau `#0C75DE`
- Taskleiste links, mit dem Rosenweg-Wappen als Start-Knopf
- Rosenweg als Hersteller mit Logo
- das Logo als Standard-Kontobild
- BGInfo: Rechner, Adressen, angemeldete Person, Windows-Stand und letztes Update oben rechts auf dem Hintergrund (`bginfo.ps1`, bei jeder Anmeldung)
- eine Programm-Whitelist (AppLocker): Grundschutz erzwungen, Positivliste von /stationen zuerst in Überwachung. Siehe unten
- die Laufwerke H: (Home) und D: (Dokumente) bei jeder Anmeldung
- die Drucker DruckerR9 und DruckerR13 über den CUPS-Server (IPP, ohne Herstellertreiber, A4)
- aufgeräumte Drucker im Benutzerprofil und der Standarddrucker der Station (gepflegt auf /stationen): Siehe unten
- Google Chrome als Browser und Standard für Webseiten und PDF; Edge und OneDrive gesperrt: Siehe unten
- IrfanView (deutsch, mit Plugins) als Standard für Bilder, VLC für Audio und Video, auch für die Aufnahmen des Diktiergeräts: Siehe unten
- Windows 11: das klassische Startmenü Open-Shell mit dem Rosenweg-Wappen als Start-Knopf: Siehe unten

Gilt für alle Rechner in `OU=Windows`. Seit dem 22.11.2026 liegt dort `WIN11-1` (VM 107 auf pve3, Windows 11 Enterprise).

| Datei | Zweck |
|---|---|
| `einrichten.sh` | auf dc1 als root: OU, Rechner verschieben, Richtlinie anlegen und verlinken, Inhalt ins sysvol, Version hochzählen |
| `rosenweg-look.ps1` | Startskript, läuft beim Start als SYSTEM und setzt alles; Protokoll in `C:\ProgramData\Rosenweg\look.log` |
| `bilder/` | `hintergrund.png` (aus dem Stationsbild von os-stationen, Logo und Schriftzug für Windows vertikal mittig gesetzt, damit die Stationsinfo oben rechts nichts verdeckt), `sperrbild.png` aus os-stationen, `logo.png` von der Website, `startknopf.png` (aus dem Logo, `startknopf-erzeugen.py`) |
| `programme.ps1` | baut die AppLocker-Regeln aus der Liste auf /stationen und wertet aus, was sie blockiert (hätte); beim Start und alle 30 min |
| `aufraeumen.ps1` | bei jeder Anmeldung im Namen der Person: Autostarts von Edge/OneDrive und Edge-Verknüpfungen aus dem (servergespeicherten) Profil; VLC ohne Update-Hinweis und Netz-Metadaten, IrfanView auf Deutsch |
| `drucker.ps1` | räumt die Drucker im Profil auf und setzt den Standarddrucker, bei jeder An- und Abmeldung |
| `startknopf-erzeugen.py` | erzeugt `bilder/startknopf.png` neu, falls sich das Logo ändert (braucht Pillow) |
| `programme/` | nicht im Git: der Open-Shell-Installer (mit Prüfsumme) und das Chrome-Enterprise-MSI (Signatur wird auf Windows geprüft), beide holt `einrichten.sh` einmal; das VLC-MSI (Prüfsumme, holt `einrichten.sh`) und die beiden IrfanView-Installer (Prüfsumme, **von Hand** hierher, siehe unten) |

## Ändern

Bilder oder Skript anpassen, dann auf dc1 im Ordner `./einrichten.sh` ausführen. Das Skript zählt die Version hoch, sodass die Rechner beim nächsten Start den neuen Stand holen. dc2 bekommt die Dateien über `sysvol-abgleich`.

## Warum so

- **Richtlinie direkt in der sam.ldb statt über `samba-tool gpo create`:** Das Maschinenkonto des DC darf keine Richtlinien anlegen, und ein Admin-Passwort gehört nicht in ein Skript.
- **`scripts.ini` mit `powershell.exe -ExecutionPolicy Bypass` statt `psscripts.ini`:** Ein Windows-Client steht ab Werk auf `Restricted` und würde das Skript sonst verweigern.
- **Hintergrund und Sperrbild über PersonalizationCSP:** Das geht nur bei Enterprise/Education, und Benutzer können es nicht überschreiben. Auf den Stationen gehören diese Bilder ebenfalls der Station.
- **Taskleiste links:** Das ist eine Benutzereinstellung (`TaskbarAl=0`). Das Skript lädt deshalb beim Start jedes Profil und die Vorlage für neue Profile kurz und setzt sie dort. Der Start-Knopf von Open-Shell ist genau auf den linksbündigen Windows-Knopf zugeschnitten (siehe unten).
- **BGInfo pro Rechner:** Das Bild heisst `bginfo-<RECHNER>.png` und liegt in `%LOCALAPPDATA%`. Es wird bei jeder Anmeldung frisch erzeugt. Beim Abmelden setzt `bginfo.ps1 -Abmelden` den Hintergrund auf das neutrale Stationsbild zurück, als zweites Abmeldeskript. Windows legt nämlich eine Kopie des Hintergrunds im servergespeicherten Profil ab (`%APPDATA%\Microsoft\Windows\Themes`) und zeigt sie bei der nächsten Anmeldung zuerst an, auch auf einem anderen Rechner. So erschien auf WIN11-1 zuerst «R9-PC1, Windows 10».

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

## Browser: Chrome statt Edge, kein OneDrive

Seit dem 26.11.2026 auf allen Rechnern in OU=Windows.

**Wirkt sofort** (rosenweg-look.ps1 beim Start, aufraeumen.ps1 bei der Anmeldung). Nichts davon löscht Daten:

- **Chrome** (Enterprise-MSI, 64 bit) wird installiert, wenn es fehlt. Vorher prüft das Skript die Signatur (gültig, von Google LLC). Eine feste Prüfsumme gibt es nicht, weil Google das MSI nur unter einer Adresse für die jeweils neueste Version anbietet. Danach aktualisiert der Google-Updater (läuft als SYSTEM). Das ist bewusst so: Der Browser braucht die meisten Sicherheitsupdates.
- **Richtlinien für Chrome**, wie auf den Linux-Stationen (`65-browser.sh`): keine Übersetzung, Kerberos-Anmeldung nur an `authentik.rosenweg4303.ch`. Zusätzlich für geteilte Rechner:
  - keine Anmeldung bei Google, kein Sync
  - keine Werbe-Tabs, kein Chrome im Hintergrund
  - Startseite `www.rosenweg4303.ch` (beim Start nur empfohlen) mit Home-Knopf
  - Der Passwortmanager bleibt an, wie auf den Stationen.
- **Chrome als Standard** für http, https, .htm, .html und .pdf. Dafür sorgt die Richtlinie «Standardzuordnungen» (`standardprogramme.xml`), die Windows bei jeder Anmeldung anwendet. Dieselbe Datei trägt seit 27.11.2026 auch IrfanView und VLC (unten).
- **Taskleiste** (nur Windows 11): Explorer und Chrome statt Edge und Store, über die Richtlinie «Startlayout» (`taskleiste.xml`). Selbst Angeheftetes bleibt. Unter Windows 10 sperrte dieselbe Richtlinie die Kacheln, darum dort nicht.
- **Edge**:
  - keine Erstausführung, kein Import, nicht im Hintergrund, keine Frage nach dem Standardbrowser
  - Beim Aktualisieren legt der Updater keine Desktop-Verknüpfung mehr an.
  - Die Verknüpfungen auf dem öffentlichen Desktop und im Startmenü entfernt das Startskript. Die auf dem eigenen Desktop, in der Taskleiste und den Autostart `MicrosoftEdgeAutoLaunch_*` entfernt aufraeumen.ps1.
- **OneDrive**:
  - Die Richtlinie `DisableFileSyncNGSC=1` hält es vom Starten und Synchronisieren ab.
  - Das Programm wird rechnerweit deinstalliert (`OneDriveSetup.exe /uninstall /allusers`).
  - Die Autostarts `OneDrive` und `OneDriveSetup` werden entfernt, auch in der Vorlage für neue Profile.
  - Der Ordner `%USERPROFILE%\OneDrive` und die Daten in der Cloud bleiben.

**Wirkt erst mit «Durchsetzen»:** Das eigentliche Startverbot gehört zur Positivliste (oben). Es besteht aus AppLocker-Verbotsregeln an der Signatur, die auch für Technik gelten:

- Edge: die Produkte «Microsoft Edge», «… Installer» und «… Update»
- OneDrive: das Produkt «Microsoft OneDrive»

WebView2 (`msedgewebview2.exe`, Produkt «Microsoft Edge WebView2») bleibt erlaubt.

Bis zum Durchsetzen zeigt /stationen unter «Wäre blockiert», wo Edge oder OneDrive noch gestartet wurden. Geprüft auf win11-1 mit `Test-AppLockerPolicy`:

- `msedge.exe` (auch unter `EdgeCore`), `MicrosoftEdgeUpdate.exe`, `OneDrive.exe` und `OneDriveSetup.exe` werden abgelehnt.
- `msedgewebview2.exe` (unter `EdgeWebView` und `EdgeCore`) ist erlaubt.
- Auch der Copilot-Installer fällt unter «Microsoft Edge Installer».

## Bilder und Medien: IrfanView und VLC

Seit dem 27.11.2026 auf allen Rechnern in OU=Windows (Stefan): Bilder öffnen in **IrfanView**, Audio und Video in **VLC**, auch die Aufnahmen des Rosenweg Diktiergeräts (m4a, aac, ogg). Chrome bleibt Browser und PDF-Programm.

**Versionen** (feste Versionen mit Prüfsumme, wie Open-Shell):

| Datei | Quelle | SHA-256 |
|---|---|---|
| `iview476g_x64_setup.exe` – IrfanView 4.76, 64 bit, deutscher Installer | [irfanview.com/64bit.htm](https://www.irfanview.com/64bit.htm) | `f4041d0dd55d0020b6725cf650765269ddcfdbd2d74993f566fe5ac733656050` |
| `iview476_plugins_x64_setup.exe` – die offiziellen Plugins 4.76, 64 bit | ebenda | `ebc0c4b8bbd25b17f025d56d52fdb92d040e1f7f9215880ff1227ecba15ef713` |
| `vlc-3.0.24-win64.msi` – VLC 3.0.24, 64 bit | [download.videolan.org](https://download.videolan.org/pub/videolan/vlc/3.0.24/win64/) | `22172095ce4c2d5f5b600bb4c142d78105db29a77fa59a931941876f3b20f6d0` |

Die IrfanView-Prüfsummen sind die, die irfanview.com neben den Downloads angibt. Die VLC-Prüfsumme stimmt mit der veröffentlichten `.sha256` überein (selbst geladen und nachgerechnet am 27.11.2026); VideoLAN signiert zusätzlich mit PGP (`.asc`).

**Lizenz:** VLC ist freie Software (GPL). IrfanView ist Freeware für private und nicht-kommerzielle Nutzung, kommerziell braucht es eine Lizenz. Der Rosenweg ist eine Stockwerkeigentümergemeinschaft und gilt dabei wie Privatpersonen; die kostenlose Nutzung ist damit in Ordnung (Stefan, 27.11.2026). Eine Lizenzdatei gibt es nicht und braucht es nicht. Käme eine kommerzielle Nutzung dazu (Firma, Verein mit Erwerbszweck), wäre das neu zu prüfen.

**Wie es auf den Rechner kommt:**

1. `einrichten.sh` holt das VLC-MSI einmal nach `programme/` und prüft alle drei Prüfsummen, bevor es die Dateien ins sysvol legt. Ältere Versionen dort entfernt es.
   - **IrfanView von Hand:** irfanview.info gibt die Dateien nur nach einem Klick auf der Download-Seite heraus, ein `curl` bekommt eine HTML-Seite («Click again to start Download»). Darum beide Dateien im Browser von [irfanview.com/64bit.htm](https://www.irfanview.com/64bit.htm) laden («IrfanView-64 Deutsch/German, EXE-Installer» und «IrfanView-64 PlugIns, EXE-Installer») und nach `programme/` legen. Fehlen sie, bricht `einrichten.sh` mit einem Hinweis ab; stimmt die Prüfsumme nicht, ebenso.
2. `rosenweg-look.ps1` installiert beim Start, wenn das Programm fehlt oder der notierte Stand (`C:\Program Files\Rosenweg\medien.stand`) nicht die verlangte Version ist. Vorher kopiert es den Installer nach `C:\Windows\Temp` und prüft die Prüfsumme erneut.
   - **IrfanView:** `/silent /folder="C:\Program Files\IrfanView" /desktop=0 /thumbs=0 /group=1 /allusers=1 /assoc=1 /assocallusers=1 /ini="%APPDATA%\IrfanView"`. Startmenü-Eintrag für alle, keine Desktop-Verknüpfung, kein «IrfanView Thumbnails». `/assoc=1` meldet die Bildformate bei Windows an; die Einstellungen liegen je Person im servergespeicherten `%APPDATA%\IrfanView`.
   - **Plugins:** danach `/silent /folder="C:\Program Files\IrfanView"`.
   - **VLC:** `msiexec /i … /qn /norestart`. Ein VLC aus dem EXE-Installer (mit `uninstall.exe`) wird vorher still entfernt, sonst lägen zwei Pakete im selben Ordner. Die Desktop-Verknüpfung, die das MSI anlegt, entfernt das Skript bei jedem Start.
3. `aufraeumen.ps1` stellt bei jeder Anmeldung im Profil ein (nur diese Werte, der Rest bleibt):
   - VLC (`%APPDATA%\vlc\vlcrc`): `qt-privacy-ask=0` (keine Frage zu Datenschutz und Netz beim ersten Start), `qt-updates-notif=0` (keine Update-Hinweise, die Version kommt von hier), `metadata-network-access=0` (keine Titel und Cover aus dem Netz).
   - IrfanView (`%APPDATA%\IrfanView\i_view64.ini`): `[Language] DLL=Deutsch.dll`, sofern `Languages\Deutsch.dll` installiert ist. Hat der deutsche Installer Deutsch fest eingebaut und keine solche Datei, ist nichts zu tun; was zutrifft, zeigt der erste Test auf win11-1.
   - VLC folgt der Sprache von Windows.

**Standard für Dateien:** In `standardprogramme.xml` stehen neben Chrome:

- IrfanView: .jpg .jpeg .jpe .jfif .png .gif .bmp .dib .tif .tiff .webp .ico .heic .heif .avif
- VLC: .mp3 .m4a .aac .ogg .oga .opus .wav .flac .wma .mka .amr .3ga .mp4 .m4v .mkv .avi .mov .wmv .webm .mpg .mpeg .3gp .ts .mts .m2ts .flv .ogv .vob

Die ProgId zu jeder Endung liest das Skript aus dem, was das Programm bei Windows angemeldet hat (`RegisteredApplications` → `Capabilities\FileAssociations`, sonst die Endung selbst). Bei VLC heissen sie `VLC.<endung>.Document`. Meldet ein Programm eine Endung nicht an (VLC 3.0.24 etwa kennt `.opus` im MSI nicht), bleibt sie weg, und `look.log` nennt sie («nicht angemeldet: …»). Ein Programm, das fehlt, bekommt keine Zuordnung.

**Programm-Whitelist:** IrfanView (`%PROGRAMFILES%\IrfanView\*`) und VLC (`%PROGRAMFILES%\VideoLAN\*`) stehen in `api/lib/windowsprogramme.js` als **Pflicht** («Immer erlaubt»), nicht nur als Vorgabe wie Chrome. Die Richtlinie verteilt sie auf jeden Rechner und macht sie zum Standard; eine schon gespeicherte Vorgabe auf /stationen kennte sie sonst nicht, und mit «Durchsetzen» liefen Doppelklicks auf Fotos und Aufnahmen ins Leere. Pfadregeln wie bei Chrome: unter Programme schreiben nur Admins.

**Prüfen** auf dem Rechner (als Admin):

```powershell
Get-Content C:\ProgramData\Rosenweg\look.log -Tail 30
Get-Content 'C:\Program Files\Rosenweg\medien.stand'
Get-Content 'C:\Program Files\Rosenweg\standardprogramme.xml'
Test-AppLockerPolicy -XmlPolicy 'C:\Program Files\Rosenweg\programme\positivliste.xml' -User S-1-1-0 `
    -Path 'C:\Program Files\IrfanView\i_view64.exe', 'C:\Program Files\VideoLAN\VLC\vlc.exe'
```

**Neue Version:**

1. Version, Dateinamen und Prüfsummen in `rosenweg-look.ps1` **und** `einrichten.sh` ändern. IrfanView: Prüfsummen von irfanview.com/64bit.htm, Dateien von Hand nach `programme/` (die Plugins haben dieselbe Versionsnummer und werden mit aktualisiert). VLC: Prüfsumme aus der `.sha256` neben dem MSI auf download.videolan.org und selbst nachrechnen (`sha256sum`).
2. Auf dc1 `./einrichten.sh` ausführen. Beim nächsten Start installiert jeder Rechner über die alte Version; das sysvol behält nur die neuen Installer.

Sicherheitsupdates von VLC (Medien-Parser) gelegentlich nachsehen: [videolan.org/security](https://www.videolan.org/security/). Für IrfanView: [Versionsgeschichte](https://www.irfanview.com/main_history.htm).

**Zurücknehmen:** In `rosenweg-look.ps1` `$MedienAn = $false` setzen und `./einrichten.sh` ausführen. Beim nächsten Start deinstalliert das Skript beide still (IrfanView mit `iv_uninstall.exe /silent`, VLC mit `msiexec /x`) und löscht `medien.stand`. Die Zuordnungen fallen aus `standardprogramme.xml` weg, Windows nimmt wieder seine eigenen Apps (Fotos, Medienwiedergabe). Die Einstellungen in den Profilen bleiben liegen, sie stören nicht. Die Freigaben im Katalog können bleiben oder per Pull Request zurück auf «abwählbar».

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
