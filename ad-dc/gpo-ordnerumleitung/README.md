# Gruppenrichtlinie «Rosenweg-Ordnerumleitung»

Desktop, Dokumente und Bilder liegen bei Windows-Rechnern im Home auf dem Fileserver statt im Profil:

| Ordner | Ziel |
|---|---|
| Desktop | `\\dokumente\home\%USERNAME%\Desktop` |
| Dokumente | `\\dokumente\home\%USERNAME%\Documents` |
| Bilder | `\\dokumente\home\%USERNAME%\Pictures` |

Das ist derselbe Ordner wie «Persönlich» in der Nextcloud ([Plan](../../docs/plans/persoenlicher-ordner.md)). Die Richtlinie ersetzt den Testabschnitt `:folderredir` in `logon.bat`. Danach braucht es `logon.bat` nicht mehr.

**Wer:** nur Mitglieder der AD-Gruppe **Ordnerumleitung** (Sicherheitsfilterung). Anfangs ist das nur stefan.mueller.

| Datei | Zweck |
|---|---|
| `einrichten.sh` | auf dc1 als root: Gruppe, Richtlinie, Verknüpfung mit der Domäne, Sicherheitsfilterung, Inhalt ins sysvol, Version hochzählen |
| `fdeploy1.ini` | die Umleitung als Vorlage mit Kommentaren. `einrichten.sh` schreibt sie ohne Kommentare als UTF-16LE ins sysvol |
| `logon-bat-abschalten.sh` | auf dc1 als root: Cron-Job abschalten, `scriptPath` entfernen, `logon.bat` umbenennen. Ohne `--ausfuehren` nur ein Probelauf |

## Warum so

- **Die Ordnerumleitung von Windows statt eines Anmeldeskripts:** Sie ist die Clientseite einer gewöhnlichen Gruppenrichtlinie ([MS-GPFR]). Windows holt nur die Datei `User\Documents & Settings\fdeploy1.ini` per SMB aus dem sysvol. Samba muss dafür nichts können, ausser Dateien auszuliefern. Gegenüber `logon.bat` gibt es drei Vorteile:
  - Windows verschiebt die Inhalte selbst. Das ersetzt robocopy und den Marker `.migrated`.
  - Der Explorer kennt die Ordner als umgeleitet.
  - Fehler landen in einem eigenen Ereignisprotokoll.
- **Die leere Richtlinie «Rosenweg-Folder Redirect» übernommen:** Sie wurde am 24.06.2026 angelegt, steht auf Version 0, hat keinen Inhalt und hängt schon an der Domäne. `einrichten.sh` benennt sie um und füllt sie. Sonst lägen zwei Richtlinien für dasselbe nebeneinander. Hat sie inzwischen jemand gefüllt, bricht das Skript ab, statt sie zu überschreiben.
- **An der Domäne statt an `OU=Windows`:** Die Umleitung ist eine Benutzereinstellung, und die Konten liegen in `CN=Users`. An diesen Container lässt sich keine Richtlinie hängen. Die Gruppe begrenzt, wen sie trifft.
- **Flags `1001`, also umleiten und Inhalte verschieben:**
  - **«Exklusive Rechte» bleibt aus.** Windows würde sonst die Rechte der Home-Ordner ersetzen, und der Nextcloud-Dienst (`nextcloud-dienst`) käme nicht mehr hinein.
  - **«Besitz prüfen» bleibt aus.** Ordner, die `logon.bat` oder die Nextcloud angelegt hat, gehören nicht immer der Person. Windows würde die Umleitung dann still auslassen.
  - **«Beim Entfernen zurücklegen» bleibt aus.** Fällt jemand aus der Gruppe, bleiben die Dateien auf dem Server, und nichts wird zurückkopiert.
- **Gleiche Ziele wie `logon.bat`:** Bei stefan.mueller ist der alte Ort derselbe wie der neue. Windows verschiebt also nichts und trägt nur die Umleitung als eigene ein.
- **Keine Offline-Dateien:** Ohne Gegenmassnahme macht Windows umgeleitete Ordner automatisch offline verfügbar. Das führt zu Abgleichkonflikten und zu alten Ständen nach einem Netzausfall. Die Richtlinie setzt deshalb die Benutzerrichtlinie «Umgeleitete Ordner nicht automatisch offline verfügbar machen» (`HKCU\Software\Policies\Microsoft\Windows\NetCache`, `DisableFRAdminPin=1`, in `User\Registry.pol`).
- **Sicherheitsfilterung wie in der GPMC:** Authentifizierte Benutzer dürfen die Richtlinie weiter **lesen**, denn seit MS16-072 liest der Rechner sie mit seinem eigenen Konto. **Anwenden** darf nur die Gruppe Ordnerumleitung. `samba-tool ntacl sysvolreset` überträgt das auf die Dateien im sysvol.
- **Computerteil abgeschaltet** (`flags=2`; `1` hiesse Benutzerteil aus — damit wirkte die Richtlinie nicht): Er ist leer, und die Rechner sparen sich die Auswertung beim Start.
- **Kein `samba-tool gpo create`:** Wie beim [Rosenweg-Look](../gpo-rosenweg-look-windows/README.md) arbeitet das Skript direkt in der sam.ldb. Ein Admin-Passwort gehört nicht in ein Skript.

## Ausrollen

### 1. Richtlinie einrichten (dc1)

Den Ordner nach dc1 bringen (CT 108 auf pve2), dann:

```sh
pct exec 108 -- bash -c 'cd /root/gpo-ordnerumleitung && ./einrichten.sh stefan.mueller'
```

Das Skript legt die Gruppe Ordnerumleitung an und nimmt stefan.mueller auf. Es übernimmt «Rosenweg-Folder Redirect» als «Rosenweg-Ordnerumleitung» und meldet am Ende die Version, beim ersten Lauf 65536.

Prüfen auf dc1:

```sh
samba-tool gpo listall | grep -A3 Ordnerumleitung
samba-tool group listmembers Ordnerumleitung
samba-tool dsacl get --objectdn='CN={2F9D7E27-94FF-49DD-B34D-0063E87AF431},CN=Policies,CN=System,DC=ad,DC=rosenweg4303,DC=ch' | grep -o '(OA;CI;CR;edacfd8f[^)]*)'
```

Die letzte Zeile muss genau einen Eintrag ausgeben, und zwar mit der SID der Gruppe, nicht mit `AU`.

### 2. Auf dc2 warten

Windows holt das sysvol von irgendeinem DC. Erst wenn dc2 den neuen Stand hat, ist der Test eindeutig. `sysvol-abgleich.timer` läuft auf dc1 zu `*:0/10` und auf dc2 zu `*:5/10`, es dauert also höchstens 10 Minuten. Auf dc2 (CT 136, per HA, zurzeit auf pve1) prüfen:

```sh
cat '/var/lib/samba/sysvol/ad.rosenweg4303.ch/Policies/{2F9D7E27-94FF-49DD-B34D-0063E87AF431}/GPT.INI'   # Version=65536
ls  '/var/lib/samba/sysvol/ad.rosenweg4303.ch/Policies/{2F9D7E27-94FF-49DD-B34D-0063E87AF431}/User/Documents & Settings/'
samba-tool group listmembers Ordnerumleitung   # Replikation
```

### 3. Test auf win11-1 (stefan.mueller)

**Vorher** in einer PowerShell als stefan.mueller den Stand festhalten:

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' |
  Select-Object Desktop, Personal, 'My Pictures'
```

Erwartet wird `\\dokumente\home\stefan.mueller\…`, so wie `logon.bat` es gesetzt hat.

**Dann** abmelden und neu anmelden. Die neue Gruppe steht erst im neuen Anmelde-Ticket. Danach:

1. `gpresult /r /scope user` muss «Rosenweg-Ordnerumleitung» unter den angewendeten Gruppenrichtlinienobjekten zeigen und «Ordnerumleitung» unter den Gruppen. Steht dort «Ordnerumleitung muss bei der nächsten Anmeldung …», noch einmal ab- und anmelden. Die Ordnerumleitung greift nur bei einer Anmeldung im Vordergrund.
2. Das Protokoll der Ordnerumleitung auf Fehler prüfen:

   ```powershell
   Get-WinEvent -LogName 'Microsoft-Windows-Folder Redirection/Operational' -MaxEvents 20 |
     Format-List TimeCreated, Id, LevelDisplayName, Message
   ```

   Je Ordner muss eine Erfolgsmeldung stehen, und es darf keinen Fehler geben.
3. Die Werte in `User Shell Folders` sind unverändert. Explorer → Desktop → Eigenschaften → Pfad zeigt `\\dokumente\home\stefan.mueller\Desktop`.
4. Die Dateien sind alle noch da. Auf dem Fileserver ist nichts doppelt, und es gibt keinen neuen Ordner.
5. Keine Offline-Dateien:

   ```powershell
   Get-ItemProperty 'HKCU:\Software\Policies\Microsoft\Windows\NetCache'   # DisableFRAdminPin : 1
   ```

   Im Synchronisierungscenter → «Offlinedateien verwalten» stehen keine umgeleiteten Ordner.
6. Gegenprobe der Filterung mit einem Konto ausserhalb der Gruppe, z. B. `stefan-test`: `gpresult /r /scope user` führt «Rosenweg-Ordnerumleitung» unter «Gefiltert: Zugriff verweigert (Sicherheit)».

**Hängt die Umleitung bei jeder Anmeldung eine Runde hinterher:** Windows verarbeitet die Richtlinie dann im Hintergrund. Personen mit servergespeichertem Profil sollten das nicht haben. Falls doch, im Rosenweg-Look «Beim Neustart des Computers und bei der Anmeldung immer auf das Netzwerk warten» setzen (`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\CurrentVersion\Winlogon`, `SyncForegroundPolicy=1`).

### 4. logon.bat abschalten (dc1)

Erst wenn Schritt 3 stimmt. Zuerst den Probelauf:

```sh
pct exec 108 -- bash -c 'cd /root/gpo-ordnerumleitung && ./logon-bat-abschalten.sh'
```

Stand 26.11.2026: **94 Konten** haben `scriptPath: logon.bat`. Das sind alle Benutzerkonten ausser `Guest` und `krbtgt`, also auch die Dienstkonten wie `svc-fsjoin`, `svc-claude`, `api-svc` und `Administrator`. Ein anderes Anmeldeskript ist bei niemandem eingetragen.

**Falle:** Auf dc1 setzt `/etc/cron.d/sync-logon-script` (`/usr/local/sbin/sync-logon-script.sh`) alle 5 Minuten bei **jedem** Konto ohne `scriptPath` wieder `logon.bat` ein. Wer `scriptPath` nur von Hand löscht, hat ihn 5 Minuten später zurück. Das Skript schaltet deshalb zuerst den Cron-Job ab. Auf dc2 gibt es ihn nicht.

Dann wirklich:

```sh
pct exec 108 -- bash -c 'cd /root/gpo-ordnerumleitung && ./logon-bat-abschalten.sh --ausfuehren'
```

Das Skript arbeitet in dieser Reihenfolge:

1. Es verschiebt den Cron-Job nach `/root/abgeschaltet/`.
2. Es sichert alle `scriptPath`-Werte nach `/root/ad-sicherung/scriptpath-vor-abschalten-<DATUM>.ldif` und entfernt sie danach.
3. Es benennt `logon.bat` im sysvol um in `logon.bat.abgeschaltet-<DATUM>`. `scripts/` selbst bleibt, denn `sync-ad-photo.ps1` gehört zur Richtlinie «Rosenweg - AD Photo Sync».

dc2 bekommt `scriptPath` über die AD-Replikation und die Umbenennung über `sysvol-abgleich`, also innerhalb von 10 Minuten.

Prüfen:

```sh
ldbsearch -H /var/lib/samba/private/sam.ldb '(scriptPath=*)' dn | grep -c '^dn:'   # 0, auf dc1 und dc2
```

Nach mehr als 5 Minuten noch einmal prüfen, denn der Cron-Job darf nichts zurückgesetzt haben. Auf win11-1 nach dem Ab- und Anmelden zeigt `gpresult /r /scope user` kein Anmeldeskript mehr, und Desktop, Dokumente und Bilder zeigen weiter auf den Server. Die Werte bleiben, denn sie stammen jetzt von der Ordnerumleitung.

**Zurück:** Mit `ldbmodify` die Sicherung zurückspielen. Dazu je Eintrag `changetype: modify` / `replace: scriptPath` ergänzen. Den Cron-Job aus `/root/abgeschaltet/` zurücklegen und `logon.bat` zurückbenennen.

## Für alle aufschalten

Die Richtlinie bleibt dieselbe, es ändert sich nur die Gruppe:

```sh
samba-tool group addmembers Ordnerumleitung <name>[,<name>…]
# oder alle Personen auf einmal (verschachtelt):
samba-tool group addmembers Ordnerumleitung rosenweg
```

Wirksam wird das bei der nächsten Anmeldung der Person. Wer noch keine Umleitung hatte, dem **verschiebt** Windows bei dieser Anmeldung Desktop, Dokumente und Bilder aus dem Profil auf den Server. Bei einem grossen Profil dauert diese eine Anmeldung entsprechend länger. Liegen am Ziel schon gleichnamige Dateien, etwa aus der Nextcloud, kann Windows sie überschreiben. Darum vorher einen Blick in das Home werfen.

## Ändern

`fdeploy1.ini` anpassen und auf dc1 `./einrichten.sh` erneut ausführen. Das Skript zählt die Benutzer-Version hoch. Ein **anderes Ziel** verschiebt bei allen Mitgliedern die Inhalte vom alten an den neuen Ort.

## Abschalten

- Für eine Person: aus der Gruppe nehmen. Die Ordner bleiben auf dem Server und zeigen weiter dorthin.
- Ganz: die Verknüpfung an der Domäne entfernen. Dazu `gPLink` von `DC=ad,DC=rosenweg4303,DC=ch` ohne den Eintrag `{2F9D7E27-…}` zurückschreiben.
