# ============================================================================
# rosenweg-look.ps1 - Windows-Rechner im Look der Stationen
# ============================================================================
# Startskript der Gruppenrichtlinie "Rosenweg-Look Windows" (OU=Windows).
# Laeuft beim Start als SYSTEM, vor jeder Anmeldung. Darum ist alles hier
# rechnerweit: Bilder, Farbe, Hersteller-Info, Kontobild - und die Taskleiste
# links fuer jedes Profil, indem dessen NTUSER.DAT kurz geladen wird (geht nur,
# solange niemand angemeldet ist, also genau jetzt).
#
# Warum ein Skript und keine einzelnen Richtlinien: die Bilder muessen erst auf
# den Rechner (Sperrbild und Hintergrund aus dem Netz laedt Windows nicht
# zuverlaessig), Logo und Kontobilder brauchen BMP bzw. feste Groessen, und
# Samba bringt keinen Editor fuer Gruppenrichtlinien-Einstellungen mit. So
# steht alles an einer Stelle, im Website-Repo (ad-dc/gpo-rosenweg-look-windows).
#
# Sperrbild und Hintergrund ueber PersonalizationCSP: das gilt ab Windows
# Enterprise/Education (win11-1 ist Enterprise) und laesst sich vom Benutzer
# nicht ueberschreiben - wie auf den Stationen, wo Anmelde- und Sperrbild der
# Station gehoeren.
#
# Idempotent: ein zweiter Lauf aendert nichts. Protokoll unter
# C:\ProgramData\Rosenweg\look.log.
# ============================================================================
$ErrorActionPreference = 'Continue'

$Quelle = $PSScriptRoot
$Ziel   = Join-Path $env:ProgramData 'Rosenweg'
$Log    = Join-Path $Ziel 'look.log'
# Mint-Y-Blue, die Akzentfarbe der Stationen (mint-themes constants.py)
$Akzent = '#0C75DE'

New-Item -ItemType Directory -Force -Path $Ziel | Out-Null
function Log([string]$t) { "$(Get-Date -Format s)  $t" | Add-Content -Path $Log -Encoding UTF8 }
function Setze([string]$pfad, [string]$name, $wert, [string]$typ = 'String') {
    if (-not (Test-Path $pfad)) { New-Item -Path $pfad -Force | Out-Null }
    New-ItemProperty -Path $pfad -Name $name -Value $wert -PropertyType $typ -Force | Out-Null
}

Log "Start (Quelle $Quelle)"
Add-Type -AssemblyName System.Drawing

# --- Bilder auf den Rechner -------------------------------------------------
foreach ($b in 'hintergrund.png', 'sperrbild.png', 'logo.png', 'startknopf.png') {
    $von = Join-Path $Quelle $b
    $nach = Join-Path $Ziel $b
    if (Test-Path $von) {
        if (-not (Test-Path $nach) -or (Get-FileHash $von).Hash -ne (Get-FileHash $nach).Hash) {
            Copy-Item $von $nach -Force
            Log "kopiert: $b"
        }
    } else { Log "FEHLT in der Richtlinie: $b" }
}

# Logo quadratisch auf weiss in einer Groesse, als PNG oder BMP
function Logo([int]$px, [string]$datei, [string]$format) {
    $src = [System.Drawing.Image]::FromFile((Join-Path $Ziel 'logo.png'))
    try {
        $bmp = New-Object System.Drawing.Bitmap $px, $px
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.Clear([System.Drawing.Color]::White)
        $rand = [int]($px * 0.06)
        $f = [Math]::Min(($px - 2 * $rand) / $src.Width, ($px - 2 * $rand) / $src.Height)
        $w = [int]($src.Width * $f); $h = [int]($src.Height * $f)
        $g.DrawImage($src, [int](($px - $w) / 2), [int](($px - $h) / 2), $w, $h)
        $g.Dispose()
        $fmt = if ($format -eq 'bmp') { [System.Drawing.Imaging.ImageFormat]::Bmp } else { [System.Drawing.Imaging.ImageFormat]::Png }
        $bmp.Save($datei, $fmt)
        $bmp.Dispose()
    } finally { $src.Dispose() }
}

$LogoNeu = (Get-Item (Join-Path $Ziel 'logo.png') -ErrorAction SilentlyContinue).LastWriteTime
$Marke = Join-Path $Ziel 'logo.stand'
$LogoGeaendert = -not (Test-Path $Marke) -or ((Get-Content $Marke -ErrorAction SilentlyContinue) -ne "$LogoNeu")

# --- Hintergrund und Sperrbild ----------------------------------------------
$csp = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\PersonalizationCSP'
# Den Desktop-Hintergrund setzt seit BGInfo (bginfo.ps1) die Anmeldung selbst:
# pro Person, mit Namen und Adressen. Fruehere CSP-Werte deshalb entfernen.
foreach ($v in 'DesktopImagePath', 'DesktopImageUrl', 'DesktopImageStatus') {
    Remove-ItemProperty -Path $csp -Name $v -ErrorAction SilentlyContinue
}
Setze $csp 'LockScreenImagePath' (Join-Path $Ziel 'sperrbild.png')
Setze $csp 'LockScreenImageUrl'  (Join-Path $Ziel 'sperrbild.png')
Setze $csp 'LockScreenImageStatus' 1 'DWord'

# --- Akzentfarbe ------------------------------------------------------------
# Richtlinie "Bestimmte Akzentfarbe erzwingen" (ControlPanelDisplay.admx)
$pers = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
Setze $pers 'PersonalColors_Accent' $Akzent

# --- Hersteller-Info (Einstellungen > System > Info) ------------------------
if ($LogoGeaendert -or -not (Test-Path (Join-Path $Ziel 'oem-logo.bmp'))) {
    Logo 120 (Join-Path $Ziel 'oem-logo.bmp') 'bmp'
    Log "OEM-Logo erzeugt"
}
$oem = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\OEMInformation'
Setze $oem 'Manufacturer' 'Rosenweg'
Setze $oem 'SupportURL'   'https://www.rosenweg4303.ch'
Setze $oem 'Logo'         (Join-Path $Ziel 'oem-logo.bmp')

# --- Standard-Kontobild -----------------------------------------------------
# Windows nimmt die Dateien in "User Account Pictures" fuer alle, die kein
# eigenes Bild haben - mit UseDefaultTile fuer alle.
$bilder = Join-Path $env:ProgramData 'Microsoft\User Account Pictures'
if ($LogoGeaendert -or -not (Test-Path (Join-Path $bilder 'user.rosenweg'))) {
    foreach ($px in 448, 192, 48, 40, 32) {
        $n = if ($px -eq 448) { 'user.png' } else { "user-$px.png" }
        Logo $px (Join-Path $bilder $n) 'png'
    }
    Logo 448 (Join-Path $bilder 'user.bmp') 'bmp'
    Copy-Item (Join-Path $bilder 'user.png') (Join-Path $bilder 'guest.png') -Force
    Copy-Item (Join-Path $bilder 'user.bmp') (Join-Path $bilder 'guest.bmp') -Force
    Set-Content (Join-Path $bilder 'user.rosenweg') 'von rosenweg-look.ps1'
    Log "Kontobilder erzeugt"
}
Setze 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer' 'UseDefaultTile' 1 'DWord'

Set-Content $Marke "$LogoNeu"

# --- Taskleiste links, fuer jedes Profil ------------------------------------
# Links wie auf den Stationen: Startmenue in der Ecke. Der Start-Knopf von
# Open-Shell (startknopf.png) ist genau auf den linksbuendigen Windows-Knopf
# zugeschnitten - zentriert saesse das Windows-Symbol 10 px anders und
# schaute neben dem Wappen hervor.
# TaskbarAl ist eine Benutzereinstellung. Beim Start ist niemand angemeldet,
# also jedes Profil (und die Vorlage fuer neue) kurz laden und setzen.
$profile = @(@{ Name = 'Default'; Datei = 'C:\Users\Default\NTUSER.DAT' })
Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } | ForEach-Object {
    $profile += @{ Name = (Split-Path $_.LocalPath -Leaf); Datei = (Join-Path $_.LocalPath 'NTUSER.DAT'); Sid = $_.SID; Geladen = $_.Loaded }
}
# Autostarts von OneDrive und Edge (siehe "Browser" unten). Fuer die Vorlage
# zaehlt das: dort steht OneDriveSetup, das jedes neue Profil einrichtet.
# Servergespeicherte Profile raeumt aufraeumen.ps1 bei der Anmeldung auf.
function AutostartsWeg([string]$hive) {
    $run = "$hive\Software\Microsoft\Windows\CurrentVersion\Run"
    $k = Get-Item $run -ErrorAction SilentlyContinue
    if (-not $k) { return }
    foreach ($name in $k.GetValueNames()) {
        if ($name -in 'OneDrive', 'OneDriveSetup' -or $name -like 'MicrosoftEdgeAutoLaunch_*') {
            Remove-ItemProperty -Path $run -Name $name -ErrorAction SilentlyContinue
            Log "Autostart $name entfernt ($hive)"
        }
    }
}
foreach ($p in $profile) {
    if (-not (Test-Path $p.Datei)) { continue }
    if ($p.Geladen) {
        # Angemeldet (Skript von Hand gestartet): direkt in den geladenen Zweig
        $k = "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
        Setze $k 'TaskbarAl' 0 'DWord'
        Setze "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop" 'NoChangingWallPaper' 1 'DWord'
        Setze "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows NT\CurrentVersion\Windows" 'LegacyDefaultPrinterMode' 1 'DWord'
        AutostartsWeg "Registry::HKEY_USERS\$($p.Sid)"
        continue
    }
    & reg.exe load 'HKU\RosenwegLook' $p.Datei 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "Profil $($p.Name) nicht ladbar"; continue }
    try {
        Setze 'Registry::HKEY_USERS\RosenwegLook\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' 'TaskbarAl' 0 'DWord'
        # Hintergrund gehoert der Station (wie auf den Linux-Stationen)
        Setze 'Registry::HKEY_USERS\RosenwegLook\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop' 'NoChangingWallPaper' 1 'DWord'
        # Standarddrucker gehoert der Station (siehe "Drucker im Profil" unten):
        # Windows soll ihn nicht selbst auf den zuletzt benutzten umstellen.
        Setze 'Registry::HKEY_USERS\RosenwegLook\Software\Microsoft\Windows NT\CurrentVersion\Windows' 'LegacyDefaultPrinterMode' 1 'DWord'
        AutostartsWeg 'Registry::HKEY_USERS\RosenwegLook'
    } finally {
        [gc]::Collect(); [gc]::WaitForPendingFinalizers()
        & reg.exe unload 'HKU\RosenwegLook' 2>&1 | Out-Null
    }
}

# --- Drucker ---------------------------------------------------------------
# Dieselben Drucker wie auf den Stationen, ueber denselben Weg: der CUPS-Server
# (CT 111) per IPP, mit dem Windows-eigenen "Microsoft IPP Class Driver" - kein
# Herstellertreiber, nichts zu pflegen. Rechnerweit angelegt, gilt also fuer
# jede Person, die sich anmeldet.
#
# Papier A4 fest: DruckerR13 steht im CUPS auf A3 (er kann beides). Auf den
# Stationen wird er deshalb nie Standard (roles/desktop/parts/50-apps.sh);
# hier bekommt er A4 als Vorgabe, damit ein Brief nicht auf A3 herauskommt.
$CupsServer = 'cups-server.ad.rosenweg4303.ch'
foreach ($d in 'DruckerR9', 'DruckerR13') {
    if (-not (Get-Printer -Name $d -ErrorAction SilentlyContinue)) {
        try {
            Add-Printer -Name $d -IppURL "http://${CupsServer}:631/printers/$d" -ErrorAction Stop
            Log "Drucker $d angelegt"
        } catch { Log "Drucker $d FEHLER: $($_.Exception.Message)"; continue }
    }
    try { Set-PrintConfiguration -PrinterName $d -PaperSize A4 -ErrorAction Stop } catch { Log "Drucker ${d}: A4 nicht setzbar: $($_.Exception.Message)" }
}

# --- Laufwerke -------------------------------------------------------------
# H: das eigene Home, D: die Dokumente - dieselben Freigaben wie auf den
# Stationen (files.ad, Kerberos, kein Passwort). Verbunden wird bei jeder
# Anmeldung im Namen der Person, darum eine geplante Aufgabe fuer die Gruppe
# Benutzer statt einer Benutzerrichtlinie (die braeuchte Loopback, weil die
# Konten nicht in OU=Windows liegen). Der Befehl steht in der Aufgabe selbst
# und nicht in einer .cmd-Datei: die Programm-Whitelist erlaubt Skripte nur
# aus Windows- und Programme-Ordnern.
$FileServer = 'files.ad.rosenweg4303.ch'
$befehl = "/c net use H: \\$FileServer\home\%USERNAME% /persistent:no & net use D: \\$FileServer\dokumente /persistent:no"
$aufgabe = Get-ScheduledTask -TaskName 'Rosenweg Laufwerke' -ErrorAction SilentlyContinue
if (-not $aufgabe -or $aufgabe.Actions[0].Arguments -ne $befehl) {
    $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument $befehl
    $t = New-ScheduledTaskTrigger -AtLogOn
    $p = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'Rosenweg Laufwerke' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
    Log "Aufgabe 'Rosenweg Laufwerke' eingerichtet"
}

# --- Programm-Whitelist (AppLocker) -----------------------------------------
# Die Regeln baut programme.ps1 (Begruendung dort und im README): durchgesetzt
# ist der Grundschutz - alles unter C:\Windows und den Programme-Ordnern,
# signierte Store-Apps, OneDrive, die Defender-Plattform -, die Positivliste
# von /stationen laeuft in Ueberwachung, bis dort jemand "Durchsetzen" waehlt.
#
# Wer ALLES darf: die AD-Gruppe Windows-Programme-frei (enthaelt Domain
# Admins). Nicht die lokale Gruppe Administratoren: mit UAC traegt das Token
# eines Admins diese Gruppe nur "deny-only", und AppLocker liesse ihn dann so
# wenig zu wie alle anderen. Eine gewoehnliche Gruppe filtert UAC nicht.
#
# Das Skript liegt unter Programme (nur Admins schreiben dort) und laeuft
# jetzt einmal und danach alle 30 Minuten als SYSTEM: so kommt eine Aenderung
# auf /stationen ohne Neustart an, und die Auswertung liest das Protokoll
# nach, bevor es (1 MB ab Werk) ueberlaeuft. programme-freigaben.txt kommt
# mit, die Aufgabe liest sie dort.
$prog = Join-Path $env:ProgramFiles 'Rosenweg'
New-Item -ItemType Directory -Force -Path $prog | Out-Null
foreach ($datei in 'programme.ps1', 'programme-freigaben.txt') {
    $von = Join-Path $Quelle $datei; $nach = Join-Path $prog $datei
    if ((Test-Path $von) -and (-not (Test-Path $nach) -or (Get-FileHash $von).Hash -ne (Get-FileHash $nach).Hash)) {
        Copy-Item $von $nach -Force
        Log "$datei aktualisiert"
    }
}
$alteStand = Join-Path $Ziel 'applocker.stand'   # bis 26.11.2026, ersetzt durch programme\aktiv.xml
if (Test-Path $alteStand) { Remove-Item $alteStand, (Join-Path $Ziel 'applocker.xml') -Force -ErrorAction SilentlyContinue }
$prSkript = Join-Path $prog 'programme.ps1'
if (Test-Path $prSkript) {
    & $prSkript
    Log "Programme (AppLocker): siehe $prog\programme\programme.log"
    $prArg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$prSkript`""
    $prAufgabe = Get-ScheduledTask -TaskName 'Rosenweg Programme' -ErrorAction SilentlyContinue
    if (-not $prAufgabe -or $prAufgabe.Actions[0].Arguments -ne $prArg) {
        $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $prArg
        $t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 30)
        $p = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
        $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        Register-ScheduledTask -TaskName 'Rosenweg Programme' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
        Log "Aufgabe 'Rosenweg Programme' eingerichtet"
    }
} else { Log "programme.ps1 fehlt in der Richtlinie - AppLocker-Regeln bleiben, wie sie sind" }

# --- BGInfo -----------------------------------------------------------------
# Rechner, Adressen, Person, Windows-Stand und letztes Update unten rechts auf
# dem Hintergrund (bginfo.ps1). Das Skript liegt unter Programme, weil die
# Programm-Whitelist Skripte nur von dort und aus Windows startet; es laeuft
# bei jeder Anmeldung im Namen der Person. conhost --headless, damit kein
# Fenster aufblitzt.
$prog = Join-Path $env:ProgramFiles 'Rosenweg'
New-Item -ItemType Directory -Force -Path $prog | Out-Null
$bgQuelle = Join-Path $Quelle 'bginfo.ps1'
$bgZiel = Join-Path $prog 'bginfo.ps1'
if ((Test-Path $bgQuelle) -and (-not (Test-Path $bgZiel) -or (Get-FileHash $bgQuelle).Hash -ne (Get-FileHash $bgZiel).Hash)) {
    Copy-Item $bgQuelle $bgZiel -Force
    Log "bginfo.ps1 aktualisiert"
}
$bgArg = "--headless $env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$bgZiel`""
$bgAufgabe = Get-ScheduledTask -TaskName 'Rosenweg BGInfo' -ErrorAction SilentlyContinue
if (-not $bgAufgabe -or $bgAufgabe.Actions[0].Arguments -ne $bgArg) {
    $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument $bgArg
    $t = New-ScheduledTaskTrigger -AtLogOn
    $p = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'Rosenweg BGInfo' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
    Log "Aufgabe 'Rosenweg BGInfo' eingerichtet"
}

# --- Nextcloud als Laufwerk N: (WebDAV) ---------------------------------------
# Die Anmeldung und das Verbinden macht nextcloud-laufwerk.ps1 im Namen der
# Person (Begruendung dort und im README). Hier nur das Rechnerweite: das
# Skript unter Programme (Programm-Whitelist), die Aufgabe bei der Anmeldung,
# ein Eintrag im Startmenue, der WebDAV-Dienst und die Intranet-Zone.
# Zuruecknehmen: $NextcloudAn = $false, dann raeumt der naechste Start auf.
$NextcloudAn = $true
$ncQuelle = Join-Path $Quelle 'nextcloud-laufwerk.ps1'
$ncZiel = Join-Path $prog 'nextcloud-laufwerk.ps1'
$ncMenue = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Rosenweg\Nextcloud als Laufwerk N.lnk'
$ncZonen = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMapKey'
$ncArg = "--headless $env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ncZiel`" -Anlass Anmelden"
if ($NextcloudAn) {
    if ((Test-Path $ncQuelle) -and (-not (Test-Path $ncZiel) -or (Get-FileHash $ncQuelle).Hash -ne (Get-FileHash $ncZiel).Hash)) {
        Copy-Item $ncQuelle $ncZiel -Force
        Log "nextcloud-laufwerk.ps1 aktualisiert"
    }
    $ncAufgabe = Get-ScheduledTask -TaskName 'Rosenweg Nextcloud' -ErrorAction SilentlyContinue
    if (-not $ncAufgabe -or $ncAufgabe.Actions[0].Arguments -ne $ncArg) {
        $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument $ncArg
        $t = New-ScheduledTaskTrigger -AtLogOn
        $p = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
        # 20 Minuten: beim ersten Mal wartet das Skript auf die Freigabe im Browser
        $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
        Register-ScheduledTask -TaskName 'Rosenweg Nextcloud' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
        Log "Aufgabe 'Rosenweg Nextcloud' eingerichtet"
    }
    # Eintrag im Startmenue (Rosenweg > Nextcloud als Laufwerk N), fuer wer
    # bei der Anmeldung "Nein" gesagt hat oder neu verbinden will
    if (-not (Test-Path $ncMenue)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $ncMenue) | Out-Null
        $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($ncMenue)
        $lnk.TargetPath = "$env:WINDIR\System32\conhost.exe"
        $lnk.Arguments = $ncArg -replace '-Anlass Anmelden$', '-Anlass Einrichten'
        $lnk.IconLocation = "$env:WINDIR\System32\shell32.dll,9"
        $lnk.Description = 'Die Nextcloud als Laufwerk N: einbinden (einmal im Browser freigeben)'
        $lnk.Save()
        Log "Startmenue: Nextcloud als Laufwerk N angelegt"
    }
    # WebDAV-Client: ab Werk "Manuell (Trigger)". Automatisch, damit N: schon
    # bei der Anmeldung verbinden kann (ohne laufenden Dienst: Fehler 67).
    $wc = Get-Service WebClient -ErrorAction SilentlyContinue
    if ($wc) {
        $wcPar = 'HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters'
        # Basic nur ueber HTTPS (das ist die Vorgabe, hier festgehalten)
        Setze $wcPar 'BasicAuthLevel' 1 'DWord'
        # Groesste Datei: ab Werk 50 MB; so 4 GB (0xFFFFFFFF, das Maximum).
        # Der Dienst liest das nur beim Start - darum vor dem Starten setzen.
        Setze $wcPar 'FileSizeLimitInBytes' ([int32]-1) 'DWord'
        if ($wc.StartType -ne 'Automatic') { Set-Service WebClient -StartupType Automatic; Log "WebClient: Start automatisch" }
        if ($wc.Status -ne 'Running') { Start-Service WebClient -ErrorAction SilentlyContinue }
    } else { Log "WebClient-Dienst fehlt - N: geht auf diesem Rechner nicht" }
    # Intranet-Zone (1): Dateien von N: bekommen keine Internet-Markierung
    # (sonst Warnungen beim Oeffnen, Office in der geschuetzten Ansicht), und
    # Edge/Chrome melden sich bei Authentik per Kerberos an, solange keine
    # AuthServerAllowlist gesetzt ist - so braucht die einmalige Freigabe im
    # Haus kein Passwort. Nur einzelne Werte, andere Eintraege bleiben.
    Setze $ncZonen 'https://nextcloud.rosenweg4303.ch' '1'
    Setze $ncZonen 'https://authentik.rosenweg4303.ch' '1'
} else {
    if (Get-ScheduledTask -TaskName 'Rosenweg Nextcloud' -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName 'Rosenweg Nextcloud' -Confirm:$false
        Log "Aufgabe 'Rosenweg Nextcloud' entfernt"
    }
    Remove-Item $ncMenue, $ncZiel -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty $ncZonen -Name 'https://nextcloud.rosenweg4303.ch', 'https://authentik.rosenweg4303.ch' -ErrorAction SilentlyContinue
}

# --- Drucker im Profil ------------------------------------------------------
# Servergespeicherte Profile wandern mit. Darin standen Druckerverbindungen von
# frueheren PCs (\\100.64.2.32\DruckerR9 per SMB, Brother, AnyDesk, PDF24 ...)
# und als Standard ein Drucker, den es auf dem Rechner gar nicht gibt -
# Programme druckten dann ins Leere, beim CUPS kam nie etwas an (win11-1,
# 26.11.2026). drucker.ps1 raeumt das im Namen der Person auf und setzt den
# Standarddrucker der Station (gepflegt auf /stationen):
#   - bei jeder Anmeldung (geplante Aufgabe wie BGInfo)
#   - bei jeder Abmeldung (Abmeldeskript der Richtlinie, vor dem Hochladen des
#     Profils - so kommt es sauber auf den naechsten Rechner)
# Liegt unter Programme, weil die Programm-Whitelist Skripte nur von dort und
# aus Windows startet; das Abmeldeskript ruft dieselbe Datei auf.
$drQuelle = Join-Path $Quelle 'drucker.ps1'
$drZiel = Join-Path $prog 'drucker.ps1'
if ((Test-Path $drQuelle) -and (-not (Test-Path $drZiel) -or (Get-FileHash $drQuelle).Hash -ne (Get-FileHash $drZiel).Hash)) {
    Copy-Item $drQuelle $drZiel -Force
    Log "drucker.ps1 aktualisiert"
}
$drArg = "--headless $env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$drZiel`" -Anlass Anmelden"
$drAufgabe = Get-ScheduledTask -TaskName 'Rosenweg Drucker' -ErrorAction SilentlyContinue
if (-not $drAufgabe -or $drAufgabe.Actions[0].Arguments -ne $drArg) {
    $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument $drArg
    $t = New-ScheduledTaskTrigger -AtLogOn
    $p = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'Rosenweg Drucker' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
    Log "Aufgabe 'Rosenweg Drucker' eingerichtet"
}
# Protokoll ins Ereignisprotokoll (Anwendung, Quelle "Rosenweg Drucker").
# Eine Quelle anlegen darf nur ein Admin - darum hier; schreiben duerfen
# angemeldete Personen dann selbst.
if (-not [System.Diagnostics.EventLog]::SourceExists('Rosenweg Drucker')) {
    New-EventLog -LogName Application -Source 'Rosenweg Drucker'
    Log "Ereignisquelle 'Rosenweg Drucker' angelegt"
}
# Abmeldeskripte stehen im Benutzerteil der Richtlinie. Die Konten liegen
# nicht in OU=Windows, also wirkt dieser Teil nur mit Loopback ("Zusammen-
# fuehren": die eigenen Benutzerrichtlinien gelten weiter, die Benutzerteile
# der Richtlinien an OU=Windows kommen dazu).
Setze 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'UserPolicyMode' 1 'DWord'
# Standarddrucker dieser Station auf Vorrat holen. drucker.ps1 fragt bei der
# Anmeldung selbst nach; ist die Verwaltung dann nicht erreichbar, gilt der
# hier zuletzt geholte Wert. Nur ueberschreiben, wenn eine Antwort kam.
try {
    $antwort = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 `
        -Uri "https://www.rosenweg4303.ch/api/stations/drucker/$env:COMPUTERNAME"
    if ($null -ne $antwort.bekannt) {
        $stand = [ordered]@{ bekannt = [bool]$antwort.bekannt; standard = $antwort.standard; geholt = (Get-Date -Format s) }
        $stand | ConvertTo-Json | Set-Content -Path (Join-Path $Ziel 'standarddrucker.json') -Encoding UTF8
        Log "Standarddrucker laut Verwaltung: $(if ($antwort.standard) { $antwort.standard } elseif ($antwort.bekannt) { 'keiner' } else { 'Rechner nicht eingetragen' })"
    }
} catch { Log "Standarddrucker: Verwaltung nicht erreichbar ($($_.Exception.Message)) - bleibt beim zuletzt bekannten" }

# --- Browser: Chrome statt Edge, kein OneDrive -----------------------------
# Stefan, 26.11.2026: auf allen Windows-Rechnern Google Chrome als Browser,
# Edge und OneDrive gesperrt. Aufgeteilt nach Wirkung:
#
#   sofort (hier):  Chrome installieren und einstellen, Chrome als Standard
#                   fuer Webseiten und PDF, Edge-Verknuepfungen weg und keine
#                   neuen, Edge ohne Erstausfuehrung und Hintergrund, OneDrive
#                   per Richtlinie aus und deinstalliert. Nichts davon loescht
#                   Daten; der Ordner %USERPROFILE%\OneDrive bleibt.
#   mit der Liste:  das eigentliche Startverbot fuer Edge und OneDrive steht
#                   als AppLocker-Verbot in der Positivliste (programme.ps1,
#                   api/lib/windowsprogramme.js) und wird zuerst nur
#                   ueberwacht, bis auf /stationen "Durchsetzen" gewaehlt ist.
#                   WebView2 bleibt dabei erlaubt.
#
# Chrome: das Enterprise-MSI (64 bit) legt einrichten.sh einmal neben dieses
# Skript. Google veroeffentlicht es nur unter einer festen Adresse fuer die
# jeweils neueste Version - eine feste Pruefsumme im Git veraltete mit jeder
# Version. Geprueft wird deshalb die Signatur (gueltig, von Google LLC), hier
# vor dem Installieren. Installiert wird nur, wenn Chrome fehlt; danach
# aktualisiert sich Chrome ueber den Google-Updater (laeuft als SYSTEM).
# Bewusst so: der Browser ist das Programm mit den meisten Sicherheits-
# updates, eine im sysvol eingefrorene Version waere nach Wochen ein Risiko.
$ChromeMsi = 'googlechromestandaloneenterprise64.msi'
$chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
               "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) {
    $von = Join-Path $Quelle $ChromeMsi
    if (-not (Test-Path $von)) {
        Log "Chrome: $ChromeMsi fehlt in der Richtlinie - nicht installiert"
    } else {
        # Nach C:\Windows\Temp wie bei Open-Shell: nur Admins/SYSTEM schreiben dort.
        $tmp = Join-Path $env:WINDIR "Temp\Rosenweg-$ChromeMsi"
        Copy-Item $von $tmp -Force
        $sig = Get-AuthenticodeSignature -FilePath $tmp
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Google LLC') {
            Log "Chrome: Signatur NICHT in Ordnung ($($sig.Status), $($sig.SignerCertificate.Subject)) - nicht installiert"
        } else {
            $pr = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -Wait -PassThru `
                -ArgumentList '/i', "`"$tmp`"", '/qn', '/norestart'
            Log "Chrome installiert (Rueckgabe $($pr.ExitCode))"
        }
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        $chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                       "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
}

# Chrome-Richtlinien, angelehnt an die Linux-Stationen (os-stationen,
# roles/desktop/parts/65-browser.sh): keine Uebersetzung, Anmeldung per
# Kerberos nur an Authentik. Dazu fuer geteilte Rechner: keine Anmeldung bei
# Google und kein Sync (sonst landen Verlauf und Passwoerter im Google-Konto
# einer Person, die gerade an einem Hausrechner sitzt), keine Werbe-Tabs,
# kein Chrome im Hintergrund. Der Passwortmanager bleibt an wie auf den
# Stationen - er speichert im eigenen Profil.
$cr = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
Setze $cr 'TranslateEnabled' 0 'DWord'
Setze $cr 'AuthSchemes' 'basic,digest,negotiate'
Setze $cr 'AuthServerAllowlist' 'authentik.rosenweg4303.ch'
Setze $cr 'DisableAuthNegotiateCnameLookup' 1 'DWord'
Setze $cr 'BrowserSignin' 0 'DWord'
Setze $cr 'SyncDisabled' 1 'DWord'
Setze $cr 'PromotionalTabsEnabled' 0 'DWord'
Setze $cr 'MetricsReportingEnabled' 0 'DWord'
Setze $cr 'BackgroundModeEnabled' 0 'DWord'
# Standardbrowser setzt die Richtlinie unten - Chrome soll nicht selbst fragen.
Setze $cr 'DefaultBrowserSettingEnabled' 0 'DWord'
Setze $cr 'HomepageLocation' 'https://www.rosenweg4303.ch'
Setze $cr 'HomepageIsNewTabPage' 0 'DWord'
Setze $cr 'ShowHomeButton' 1 'DWord'
# Startseite nur empfohlen: wer lieber die letzten Tabs wiederhat, darf.
Setze "$cr\Recommended" 'RestoreOnStartup' 4 'DWord'
Setze "$cr\Recommended\RestoreOnStartupURLs" '1' 'https://www.rosenweg4303.ch'

# --- Bilder und Medien: IrfanView und VLC ------------------------------------
# Stefan, 27.11.2026: auf allen Windows-Rechnern IrfanView (64 bit, deutsch,
# mit den offiziellen Plugins) fuer Bilder und VLC fuer Audio und Video -
# auch fuer die Aufnahmen des Rosenweg Diktiergeraets (m4a/aac/ogg).
#
# Wie Open-Shell (unten): feste Versionen, die Installer legt einrichten.sh
# mit Pruefsumme ins sysvol (nicht im Git), hier wird vor dem Start noch
# einmal geprueft. Installiert wird, wenn das Programm fehlt oder der hier
# notierte Stand nicht der verlangte ist - eine neue Version ist also: Datei,
# Version und Pruefsumme hier UND in einrichten.sh aendern, einrichten.sh.
# Beide Programme bringen keinen eigenen Updater mit, der als SYSTEM liefe;
# die Hinweise auf neue Versionen sind aus (VLC: aufraeumen.ps1).
#
# IrfanView-Lizenz: Freeware fuer private und nicht-kommerzielle Nutzung.
# Die Stockwerkeigentuemergemeinschaft gilt dabei wie Privatpersonen
# (Stefan, 27.11.2026) - siehe README.
#
# Erlaubt (AppLocker) sind beide als Pflicht im Katalog (api/lib/
# windowsprogramme.js): die Richtlinie verteilt sie auf jeden Rechner und
# macht sie zum Standard - abwaehlbar duerfen sie dort nicht sein.
#
# Zuruecknehmen: $MedienAn = $false, einrichten.sh - beim naechsten Start
# werden beide still deinstalliert, die Zuordnungen fallen weg.
$MedienAn           = $true
$IrfanViewVersion   = '4.76'
$IrfanViewDatei     = 'iview476g_x64_setup.exe'
$IrfanViewSha256    = 'F4041D0DD55D0020B6725CF650765269DDCFDBD2D74993F566FE5AC733656050'
$IrfanPluginsDatei  = 'iview476_plugins_x64_setup.exe'
$IrfanPluginsSha256 = 'EBC0C4B8BBD25B17F025D56D52FDB92D040E1F7F9215880FF1227ECBA15EF713'
$VlcVersion         = '3.0.24'
$VlcDatei           = 'vlc-3.0.24-win64.msi'
$VlcSha256          = '22172095CE4C2D5F5B600BB4C142D78105DB29A77FA59A931941876F3B20F6D0'

$ivOrdner = Join-Path $env:ProgramFiles 'IrfanView'
$ivExe    = Join-Path $ivOrdner 'i_view64.exe'
$vlcExe   = Join-Path $env:ProgramFiles 'VideoLAN\VLC\vlc.exe'
# Was installiert ist, steht hier (unter Programme: nur Admins schreiben
# dort). Die Versionsangaben der Programme selbst sind uneinheitlich
# (IrfanView "4.76" vs. Dateiversion), so ist der Vergleich eindeutig.
$medienStand = Join-Path $prog 'medien.stand'
$medienIst = @{}
if (Test-Path $medienStand) {
    foreach ($z in Get-Content $medienStand) { if ($z -match '^(\w+)=(.+)$') { $medienIst[$Matches[1]] = $Matches[2].Trim() } }
}
function MedienStandSchreiben {
    ($medienIst.Keys | Sort-Object | ForEach-Object { "$_=$($medienIst[$_])" }) | Set-Content -Path $medienStand -Encoding ASCII
}
# Installer aus der Richtlinie nach C:\Windows\Temp (nur Admins/SYSTEM
# schreiben dort, die Programm-Whitelist erlaubt es) und pruefen.
# Gibt den Pfad zurueck oder $null.
function InstallerHolen([string]$datei, [string]$sha256, [string]$wer) {
    $von = Join-Path $Quelle $datei
    if (-not (Test-Path $von)) { Log "${wer}: $datei fehlt in der Richtlinie - nicht installiert"; return $null }
    $tmp = Join-Path $env:WINDIR "Temp\Rosenweg-$datei"
    Copy-Item $von $tmp -Force
    if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne $sha256) {
        Log "${wer}: Pruefsumme von $datei stimmt NICHT - nicht installiert"
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        return $null
    }
    $tmp
}
function Deinstalleintrag([string]$muster) {
    Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like $muster }
}

if ($MedienAn) {
    # IrfanView: der deutsche Installer (iview...g_...). /assoc=1 meldet die
    # Bildformate bei Windows an (rechnerweit, /assocallusers=1) - Standard
    # werden sie erst ueber die Standardzuordnungen unten. /ini: die
    # Einstellungen je Person im servergespeicherten %APPDATA%\IrfanView
    # (IrfanView loest %APPDATA% selbst auf), nicht im Programmordner.
    if (-not (Test-Path $ivExe) -or $medienIst['irfanview'] -ne $IrfanViewVersion) {
        $tmp = InstallerHolen $IrfanViewDatei $IrfanViewSha256 'IrfanView'
        if ($tmp) {
            $pr = Start-Process -FilePath $tmp -Wait -PassThru -ArgumentList '/silent',
                "/folder=`"$ivOrdner`"", '/desktop=0', '/thumbs=0', '/group=1', '/allusers=1',
                '/assoc=1', '/assocallusers=1', '/ini="%APPDATA%\IrfanView"'
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if ($pr.ExitCode -eq 0 -and (Test-Path $ivExe)) {
                $medienIst['irfanview'] = $IrfanViewVersion; $medienIst.Remove('plugins'); MedienStandSchreiben
            }
            Log "IrfanView $IrfanViewVersion installiert (Rueckgabe $($pr.ExitCode))"
        }
    }
    # Die offiziellen Plugins (64 bit, gleiche Version): z.B. HEIC, AVIF,
    # Kamera-RAW und weitere Formate und Funktionen (Liste: irfanview.com/plugins.htm)
    if ((Test-Path $ivExe) -and ($medienIst['plugins'] -ne $IrfanViewVersion -or -not (Test-Path (Join-Path $ivOrdner 'Plugins')))) {
        $tmp = InstallerHolen $IrfanPluginsDatei $IrfanPluginsSha256 'IrfanView-Plugins'
        if ($tmp) {
            $pr = Start-Process -FilePath $tmp -Wait -PassThru -ArgumentList '/silent', "/folder=`"$ivOrdner`""
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if ($pr.ExitCode -eq 0 -and (Test-Path (Join-Path $ivOrdner 'Plugins'))) { $medienIst['plugins'] = $IrfanViewVersion; MedienStandSchreiben }
            Log "IrfanView-Plugins $IrfanViewVersion installiert (Rueckgabe $($pr.ExitCode))"
        }
    }

    # VLC: das MSI. Es meldet die Audio- und Videoformate bei Windows an
    # (VLC.<endung>.Document); ein Upgrade ersetzt die alte Version. Ein VLC
    # aus dem EXE-Installer (NSIS, uninstall.exe) waere ein zweites Paket im
    # selben Ordner - das wird vorher still entfernt.
    if (-not (Test-Path $vlcExe) -or $medienIst['vlc'] -ne $VlcVersion) {
        $tmp = InstallerHolen $VlcDatei $VlcSha256 'VLC'
        if ($tmp) {
            foreach ($alt in @(Deinstalleintrag 'VLC media player*' | Where-Object { [string]$_.UninstallString -match 'uninstall\.exe' })) {
                $u = ([string]$alt.UninstallString).Trim('"')
                if (Test-Path -LiteralPath $u) {
                    $pr = Start-Process -FilePath $u -Wait -PassThru -ArgumentList '/S'
                    Log "VLC (EXE-Installer $($alt.DisplayVersion)) entfernt (Rueckgabe $($pr.ExitCode))"
                }
            }
            $pr = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -Wait -PassThru `
                -ArgumentList '/i', "`"$tmp`"", '/qn', '/norestart'
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if ($pr.ExitCode -in 0, 3010 -and (Test-Path $vlcExe)) { $medienIst['vlc'] = $VlcVersion; MedienStandSchreiben }
            Log "VLC $VlcVersion installiert (Rueckgabe $($pr.ExitCode))"
        }
    }

    # Keine Verknuepfungen auf dem oeffentlichen Desktop (das MSI von VLC legt
    # eine an; IrfanView mit /desktop=0 nicht, nur zur Sicherheit). Das
    # Startmenue behaelt beide.
    foreach ($lnk in @(Get-ChildItem "$env:PUBLIC\Desktop" -Filter '*.lnk' -ErrorAction SilentlyContinue |
                       Where-Object { $_.Name -like 'VLC*' -or $_.Name -like 'IrfanView*' })) {
        Remove-Item -LiteralPath $lnk.FullName -Force; Log "entfernt: $($lnk.FullName)"
    }
} else {
    $ivWeg = Join-Path $ivOrdner 'iv_uninstall.exe'
    if (Test-Path $ivWeg) {
        $pr = Start-Process -FilePath $ivWeg -Wait -PassThru -ArgumentList '/silent'
        Log "IrfanView entfernt (Rueckgabe $($pr.ExitCode))"
    }
    foreach ($e in @(Deinstalleintrag 'VLC media player*')) {
        $code = [regex]::Match([string]$e.UninstallString, '\{[0-9A-Fa-f-]{36}\}').Value
        if ($code) {
            $pr = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -Wait -PassThru -ArgumentList '/x', $code, '/qn', '/norestart'
            Log "VLC entfernt (Rueckgabe $($pr.ExitCode))"
        }
    }
    Remove-Item $medienStand -Force -ErrorAction SilentlyContinue
}

# --- Standardzuordnungen ------------------------------------------------------
# Chrome fuer Webseiten und PDF, IrfanView fuer Bilder, VLC fuer Audio und
# Video. Windows liest die Datei bei jeder Anmeldung (Richtlinie
# "Standardzuordnungen", nur in der Domaene).
#
# Nur was wirklich da ist: ein Programm, das fehlt, bekommt keine Zuordnung
# (sonst zeigten Links und Dateien ins Leere). Die ProgId einer Endung liest
# das Skript aus der Registrierung, die das Programm selbst angelegt hat
# (RegisteredApplications -> Capabilities\FileAssociations, sonst die Endung
# selbst) - so passt sie zur installierten Version, auch wenn ein Hersteller
# die Namen aendert. Was ein Programm nicht anmeldet, steht im Protokoll.
$IrfanViewEndungen = '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.bmp', '.dib', '.tif', '.tiff',
                     '.webp', '.ico', '.heic', '.heif', '.avif'
$VlcEndungen = '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.wma', '.mka', '.amr', '.3ga',
               '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.mpg', '.mpeg', '.3gp', '.ts', '.mts',
               '.m2ts', '.flv', '.ogv', '.vob'
$klassen = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes'
function Faehigkeiten([string]$muster) {
    # FileAssociations des bei Windows angemeldeten Programms (oder $null)
    $ra = Get-ItemProperty 'HKLM:\SOFTWARE\RegisteredApplications' -ErrorAction SilentlyContinue
    if (-not $ra) { return $null }
    $p = $ra.PSObject.Properties | Where-Object { $_.Name -like $muster } | Select-Object -First 1
    if (-not $p) { return $null }
    Get-ItemProperty "Registry::HKEY_LOCAL_MACHINE\$($p.Value)\FileAssociations" -ErrorAction SilentlyContinue
}
function ProgIdFuer([string]$endung, [string]$muster, $faehig) {
    $kandidaten = @()
    if ($faehig -and $faehig.$endung) { $kandidaten += [string]$faehig.$endung }
    $k = Join-Path $klassen $endung
    $std = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'
    if ($std) { $kandidaten += [string]$std }
    $ow = Get-Item (Join-Path $k 'OpenWithProgids') -ErrorAction SilentlyContinue
    if ($ow) { $kandidaten += $ow.GetValueNames() }
    foreach ($p in $kandidaten) {
        if ($p -like $muster -and (Test-Path -LiteralPath (Join-Path $klassen $p))) { return $p }
    }
    $null
}
$eintraege = New-Object System.Collections.Generic.List[string]
$ohne = New-Object System.Collections.Generic.List[string]
function Zuordnen([string]$endung, [string]$progId, [string]$app) {
    $eintraege.Add("  <Association Identifier=""$endung"" ProgId=""$progId"" ApplicationName=""$app"" />")
}
if ($chromeExe) {
    Zuordnen '.htm' 'ChromeHTML' 'Google Chrome'
    Zuordnen '.html' 'ChromeHTML' 'Google Chrome'
    Zuordnen '.pdf' 'ChromePDF' 'Google Chrome'
    Zuordnen 'http' 'ChromeHTML' 'Google Chrome'
    Zuordnen 'https' 'ChromeHTML' 'Google Chrome'
}
$medienApps = @()
if ($MedienAn -and (Test-Path $ivExe)) { $medienApps += , @('IrfanView', 'IrfanView*', $IrfanViewEndungen) }
if ($MedienAn -and (Test-Path $vlcExe)) { $medienApps += , @('VLC media player', 'VLC*', $VlcEndungen) }
foreach ($m in $medienApps) {
    $faehig = Faehigkeiten $m[1]
    foreach ($e in $m[2]) {
        $p = ProgIdFuer $e $m[1] $faehig
        if ($p) { Zuordnen $e $p $m[0] } else { $ohne.Add("$($m[0]) $e") }
    }
}
$zuordnung = Join-Path $prog 'standardprogramme.xml'
$sys = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
if ($eintraege.Count) {
    $xml = "<?xml version=""1.0"" encoding=""UTF-8""?>`r`n<DefaultAssociations>`r`n" +
           ($eintraege -join "`r`n") + "`r`n</DefaultAssociations>`r`n"
    if (-not (Test-Path $zuordnung) -or (Get-Content $zuordnung -Raw) -ne $xml) {
        Set-Content -Path $zuordnung -Value $xml -Encoding UTF8 -NoNewline
        Log "Standardprogramme: $($eintraege.Count) Zuordnungen ($(if ($chromeExe) { 'Chrome ' })$(($medienApps | ForEach-Object { $_[0] }) -join ', '))$(if ($ohne.Count) { "; nicht angemeldet: $($ohne -join ', ')" })"
    }
    Setze $sys 'DefaultAssociationsConfiguration' $zuordnung
} elseif ((Get-ItemProperty $sys -ErrorAction SilentlyContinue).DefaultAssociationsConfiguration) {
    Remove-ItemProperty $sys -Name 'DefaultAssociationsConfiguration' -ErrorAction SilentlyContinue
    Log "Standardprogramme: keine - Richtlinie entfernt"
}

# Taskleiste (nur Windows 11): Explorer und Chrome statt der Vorgaben von
# Windows (Edge, Store). Richtlinie "Startlayout"; Windows nimmt sie bei der
# naechsten Anmeldung und dann bei jeder Aenderung der Datei. Selbst
# angeheftetes bleibt. Nicht auf Windows 10: dort sperrte dieselbe
# Richtlinie auch die Kacheln im Startmenue.
$build = [Environment]::OSVersion.Version.Build
if ($build -ge 22000 -and $chromeExe) {
    $leiste = Join-Path $prog 'taskleiste.xml'
    $xml = @'
<?xml version="1.0" encoding="utf-8"?>
<LayoutModificationTemplate
    xmlns="http://schemas.microsoft.com/Start/2014/LayoutModification"
    xmlns:defaultlayout="http://schemas.microsoft.com/Start/2014/FullDefaultLayout"
    xmlns:start="http://schemas.microsoft.com/Start/2014/StartLayout"
    xmlns:taskbar="http://schemas.microsoft.com/Start/2014/TaskbarLayout"
    Version="1">
  <CustomTaskbarLayoutCollection PinListPlacement="Replace">
    <defaultlayout:TaskbarLayout>
      <taskbar:TaskbarPinList>
        <taskbar:DesktopApp DesktopApplicationID="Microsoft.Windows.Explorer"/>
        <taskbar:DesktopApp DesktopApplicationLinkPath="%ALLUSERSPROFILE%\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk"/>
      </taskbar:TaskbarPinList>
    </defaultlayout:TaskbarLayout>
  </CustomTaskbarLayoutCollection>
</LayoutModificationTemplate>
'@
    if (-not (Test-Path $leiste) -or (Get-Content $leiste -Raw) -ne $xml) {
        Set-Content -Path $leiste -Value $xml -Encoding UTF8 -NoNewline
        Log "Taskleiste: Explorer und Chrome"
    }
    Setze 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer' 'StartLayoutFile' $leiste 'ExpandString'
    Setze 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer' 'LockedStartLayout' 1 'DWord'
}

# Edge: keine Erstausfuehrung, kein Import, nicht im Hintergrund, kein
# Vorstart, keine Frage nach dem Standardbrowser - falls ihn doch jemand
# oeffnet, solange die Sperre nur ueberwacht wird. Und keine neuen
# Verknuepfungen auf dem Schreibtisch, wenn er sich aktualisiert
# ({56EB18F8-...} ist Edge Stable beim Updater).
$ed = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
Setze $ed 'HideFirstRunExperience' 1 'DWord'
Setze $ed 'AutoImportAtFirstRun' 4 'DWord'
Setze $ed 'BackgroundModeEnabled' 0 'DWord'
Setze $ed 'StartupBoostEnabled' 0 'DWord'
Setze $ed 'DefaultBrowserSettingEnabled' 0 'DWord'
$eu = 'HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate'
Setze $eu 'CreateDesktopShortcutDefault' 0 'DWord'
Setze $eu 'CreateDesktopShortcut{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}' 0 'DWord'
# Rechnerweite Verknuepfungen; die im Profil raeumt aufraeumen.ps1 auf.
# Ein Edge-Update legt die im Startmenue neu an - darum bei jedem Start.
foreach ($lnk in "$env:PUBLIC\Desktop\Microsoft Edge.lnk",
                 "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Microsoft Edge.lnk") {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Log "entfernt: $lnk" }
}

# OneDrive: per Richtlinie aus (startet nicht, synchronisiert nicht) und das
# rechnerweite Programm deinstalliert. Der Ordner %USERPROFILE%\OneDrive und
# alles in der Cloud bleiben; Desktop/Dokumente/Bilder liegen ohnehin auf
# dem Home (Ordnerumleitung).
Setze 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive' 'DisableFileSyncNGSC' 1 'DWord'
$odSetup = Get-ChildItem "$env:ProgramFiles\Microsoft OneDrive\*\OneDriveSetup.exe", "${env:ProgramFiles(x86)}\Microsoft OneDrive\*\OneDriveSetup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($odSetup) {
    Get-Process -Name OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $pr = Start-Process -FilePath $odSetup.FullName -Wait -PassThru -ArgumentList '/uninstall', '/allusers'
    Log "OneDrive deinstalliert (Rueckgabe $($pr.ExitCode))"
}
$odLnk = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\OneDrive.lnk"
if (Test-Path -LiteralPath $odLnk) { Remove-Item -LiteralPath $odLnk -Force; Log "entfernt: $odLnk" }

# Aufraeumen im Profil bei jeder Anmeldung (servergespeicherte Profile)
$auQuelle = Join-Path $Quelle 'aufraeumen.ps1'
$auZiel = Join-Path $prog 'aufraeumen.ps1'
if ((Test-Path $auQuelle) -and (-not (Test-Path $auZiel) -or (Get-FileHash $auQuelle).Hash -ne (Get-FileHash $auZiel).Hash)) {
    Copy-Item $auQuelle $auZiel -Force
    Log "aufraeumen.ps1 aktualisiert"
}
$auArg = "--headless $env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$auZiel`""
$auAufgabe = Get-ScheduledTask -TaskName 'Rosenweg Aufraeumen' -ErrorAction SilentlyContinue
if ((Test-Path $auZiel) -and (-not $auAufgabe -or $auAufgabe.Actions[0].Arguments -ne $auArg)) {
    $a = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument $auArg
    $t = New-ScheduledTaskTrigger -AtLogOn
    $p = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    $o = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'Rosenweg Aufraeumen' -Action $a -Trigger $t -Principal $p -Settings $o -Force | Out-Null
    Log "Aufgabe 'Rosenweg Aufraeumen' eingerichtet"
}

# --- Startmenue: Open-Shell mit Rosenweg-Knopf ------------------------------
# Das klassische Startmenue (Windows-7-Stil, zwei Spalten) statt dem von
# Windows 11, und als Start-Knopf das Rosenweg-Wappen statt der Muschel.
# Open-Shell: https://github.com/Open-Shell/Open-Shell-Menu (MIT).
#
# Nur Windows 11 (Build 22000 und hoeher): dort fehlt das alte Startmenue, und
# der Knopf sitzt links, weil die Taskleiste links steht (oben). Windows 10
# bliebe unberuehrt; wer es dort will, senkt $OpenShellAbBuild auf 10240.
#
# Installiert wird nur die Startmenue-Komponente (kein Explorer-Zusatz, kein
# IE-Teil, kein Update-Dienst: Updates kommen von hier, in fester Version).
# Der Installer liegt neben diesem Skript im sysvol (einrichten.sh holt ihn
# mit Pruefsumme); er wird hier vor dem Start nochmals geprueft.
#
# Zuruecknehmen: $OpenShellAn = $false, einrichten.sh - beim naechsten Start
# wird Open-Shell still entfernt und die Einstellungen geloescht.
$OpenShellAn      = $true
$OpenShellAbBuild = 22000
$OpenShellVersion = '4.4.198'
$OpenShellDatei   = 'OpenShellSetup_4_4_198.exe'
$OpenShellSha256  = 'A4D2D4459DE55B5E962BA2A14F7BB794170511649138173DFA72949837B48C3F'

$osRichtlinie = 'HKLM:\SOFTWARE\Policies\OpenShell'
$osEintrag = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Open-Shell' } | Select-Object -First 1
$osExe = Join-Path $env:ProgramFiles 'Open-Shell\StartMenu.exe'
$build = [Environment]::OSVersion.Version.Build

if ($OpenShellAn -and $build -ge $OpenShellAbBuild) {
    if (-not $osEintrag -or $osEintrag.DisplayVersion -ne $OpenShellVersion -or -not (Test-Path $osExe)) {
        $von = Join-Path $Quelle $OpenShellDatei
        # Nach C:\Windows\Temp: dort darf laut Programm-Whitelist alles laufen,
        # und nur Admins/SYSTEM koennen hineinschreiben.
        $tmp = Join-Path $env:WINDIR "Temp\Rosenweg-$OpenShellDatei"
        if (-not (Test-Path $von)) {
            Log "Open-Shell: $OpenShellDatei fehlt in der Richtlinie - nicht installiert"
        } else {
            Copy-Item $von $tmp -Force
            if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne $OpenShellSha256) {
                Log "Open-Shell: Pruefsumme stimmt NICHT - nicht installiert"
            } else {
                # NOSTART=1: der Installer startete das Menue sonst gleich als
                # SYSTEM. Es startet ohnehin bei jeder Anmeldung (HKLM\...\Run).
                # START_MENU_FOLDER=0: kein Ordner "Open-Shell" im Startmenue,
                # Einstellungen gibt es per Rechtsklick auf den Knopf.
                $pr = Start-Process -FilePath $tmp -Wait -PassThru `
                    -ArgumentList '/qn', 'ADDLOCAL=StartMenu', 'NOSTART=1', 'START_MENU_FOLDER=0'
                Log "Open-Shell $OpenShellVersion installiert (Rueckgabe $($pr.ExitCode))"
            }
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    # Einstellungen als Richtlinie (HKLM\SOFTWARE\Policies\OpenShell, wie die
    # ADMX von Open-Shell sie schreibt): zu jedem Wert ein <Name>_State -
    # 0 = fest, 2 = nur Vorgabe, die Person darf es aendern
    # (Src/Lib/Settings.cpp, CSetting::LoadValue).
    $sm = "$osRichtlinie\StartMenu"
    function OsRegel([string]$name, $wert, [string]$typ, [int]$state = 0) {
        Setze $sm $name $wert $typ
        Setze $sm "${name}_State" $state 'DWord'
    }
    OsRegel 'MenuStyle'         2 'DWord'          # Windows 7: zwei Spalten
    OsRegel 'MouseClick'        1 'DWord'          # Klick auf den Knopf: klassisches Menue
    OsRegel 'WinKey'            1 'DWord'          # Windows-Taste: klassisches Menue
    # Umschalt+Klick / Umschalt+Win bleiben beim Windows-11-Menue (Vorgabe von
    # Open-Shell) - wer es braucht, kommt so noch hin.
    OsRegel 'EnableStartButton' 1 'DWord'
    OsRegel 'StartButtonType'   2 'DWord'          # eigenes Bild
    OsRegel 'StartButtonPath'   (Join-Path $Ziel 'startknopf.png') 'String'
    # Breite bei 100 %: so breit wie der linksbuendige Windows-Knopf (55 px),
    # den Windows nicht ausblendet; das Wappen sitzt im Bild genau ueber dessen
    # Symbol. Open-Shell skaliert mit der Anzeige hoch, das Bild hat dafuer
    # dreifache Groesse. Masse in startknopf-erzeugen.py.
    OsRegel 'StartButtonSize'   56 'DWord'
    # Unten buendig mit der Taskleiste statt "mittig + 1 px" (Open-Shell
    # schob den Knopf sonst 1 px unter den Bildschirmrand).
    OsRegel 'StartButtonAlign'  1 'DWord'
    # "Immersive" folgt hell/dunkel und der Akzentfarbe (Mint-Blau, oben) -
    # sieht damit aus wie der Rest von Windows 11. Nur Vorgabe.
    OsRegel 'SkinW7'            'Immersive' 'String' 2
    # Kein Update-Hinweis bei den Leuten: die Version kommt von hier.
    Setze "$osRichtlinie\OpenShell" 'Update' 0 'DWord'
    Setze "$osRichtlinie\OpenShell" 'Update_State' 0 'DWord'
} elseif (-not $OpenShellAn) {
    if ($osEintrag) {
        $code = [regex]::Match([string]$osEintrag.UninstallString, '\{[0-9A-Fa-f-]{36}\}').Value
        if ($code) {
            $pr = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -Wait -PassThru -ArgumentList '/x', $code, '/qn', '/norestart'
            Log "Open-Shell entfernt (Rueckgabe $($pr.ExitCode))"
        }
    }
    if (Test-Path $osRichtlinie) { Remove-Item $osRichtlinie -Recurse -Force; Log "Open-Shell-Einstellungen entfernt" }
}

Log "Fertig"
