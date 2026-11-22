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
foreach ($b in 'hintergrund.png', 'sperrbild.png', 'logo.png') {
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
Setze $csp 'DesktopImagePath'    (Join-Path $Ziel 'hintergrund.png')
Setze $csp 'DesktopImageUrl'     (Join-Path $Ziel 'hintergrund.png')
Setze $csp 'DesktopImageStatus'  1 'DWord'
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
# TaskbarAl ist eine Benutzereinstellung. Beim Start ist niemand angemeldet,
# also jedes Profil (und die Vorlage fuer neue) kurz laden und setzen.
$profile = @(@{ Name = 'Default'; Datei = 'C:\Users\Default\NTUSER.DAT' })
Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } | ForEach-Object {
    $profile += @{ Name = (Split-Path $_.LocalPath -Leaf); Datei = (Join-Path $_.LocalPath 'NTUSER.DAT'); Sid = $_.SID; Geladen = $_.Loaded }
}
foreach ($p in $profile) {
    if (-not (Test-Path $p.Datei)) { continue }
    if ($p.Geladen) {
        # Angemeldet (Skript von Hand gestartet): direkt in den geladenen Zweig
        $k = "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
        Setze $k 'TaskbarAl' 0 'DWord'
        continue
    }
    & reg.exe load 'HKU\RosenwegLook' $p.Datei 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "Profil $($p.Name) nicht ladbar"; continue }
    try {
        Setze 'Registry::HKEY_USERS\RosenwegLook\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' 'TaskbarAl' 0 'DWord'
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
# Laufen darf, was unter C:\Windows oder den Programme-Ordnern liegt (dorthin
# schreiben nur Admins - was ein Admin installiert, ist damit automatisch
# freigegeben), signierte Store-Apps und OneDrive. Alles andere, vor allem
# Heruntergeladenes in Downloads oder AppData, wird blockiert.
#
# Wer ALLES darf: die AD-Gruppe Windows-Programme-frei (enthaelt Domain
# Admins). Nicht die lokale Gruppe Administratoren: mit UAC traegt das Token
# eines Admins diese Gruppe nur "deny-only", und AppLocker liesse ihn dann so
# wenig zu wie alle anderen. Eine gewoehnliche Gruppe filtert UAC nicht.
#
# Weitere Freigaben: programme-freigaben.txt neben diesem Skript.
# Skripte aus SYSVOL/NETLOGON bleiben erlaubt, sonst sperrte sich diese
# Richtlinie beim naechsten Start selbst aus.
try {
    $frei = (New-Object System.Security.Principal.NTAccount('ROSENWEG', 'Windows-Programme-frei')).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch { $frei = $null; Log "Gruppe Windows-Programme-frei nicht aufloesbar - Whitelist NICHT gesetzt" }
if ($frei) {
    $jeder = 'S-1-1-0'; $admins = 'S-1-5-32-544'
    $n = 0
    function Regel([string]$sid, [string]$pfad, [string]$name) {
        $script:n++
        $id = [guid]::NewGuid().ToString()
        $pfadX = [System.Security.SecurityElement]::Escape($pfad)
        "<FilePathRule Id=""$id"" Name=""$name"" Description="""" UserOrGroupSid=""$sid"" Action=""Allow""><Conditions><FilePathCondition Path=""$pfadX"" /></Conditions></FilePathRule>"
    }
    $extra = @()
    $liste = Join-Path $Quelle 'programme-freigaben.txt'
    if (Test-Path $liste) {
        $extra = Get-Content $liste | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
    }
    $exe = @(
        (Regel $jeder '%WINDIR%\*' 'Windows'),
        (Regel $jeder '%PROGRAMFILES%\*' 'Programme'),
        (Regel $frei '*' 'Windows-Programme-frei: alles'),
        (Regel $admins '*' 'Administratoren (mit Admin-Token): alles')
    ) + ($extra | ForEach-Object { Regel $jeder $_ "Freigabe: $_" })
    $onedrive = '<FilePublisherRule Id="' + [guid]::NewGuid() + '" Name="OneDrive" Description="" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePublisherCondition PublisherName="O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US" ProductName="MICROSOFT ONEDRIVE" BinaryName="*"><BinaryVersionRange LowSection="*" HighSection="*" /></FilePublisherCondition></Conditions></FilePublisherRule>'
    $skript = @(
        (Regel $jeder '%WINDIR%\*' 'Windows'),
        (Regel $jeder '%PROGRAMFILES%\*' 'Programme'),
        (Regel $jeder '\\ad.rosenweg4303.ch\SysVol\*' 'Gruppenrichtlinien (SYSVOL)'),
        (Regel $jeder '\\ad.rosenweg4303.ch\NETLOGON\*' 'Anmeldeskripte (NETLOGON)'),
        (Regel $frei '*' 'Windows-Programme-frei: alles'),
        (Regel $admins '*' 'Administratoren: alles')
    )
    $msi = @(
        (Regel $jeder '%WINDIR%\Installer\*' 'Windows Installer'),
        (Regel $frei '*.*' 'Windows-Programme-frei: alles'),
        (Regel $admins '*.*' 'Administratoren: alles')
    )
    $appx = '<FilePublisherRule Id="a9e18c21-ff8f-43cf-b9fc-db40eed693ba" Name="Signierte Store-Apps" Description="" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePublisherCondition PublisherName="*" ProductName="*" BinaryName="*"><BinaryVersionRange LowSection="0.0.0.0" HighSection="*" /></FilePublisherCondition></Conditions></FilePublisherRule>'
    $xml = "<AppLockerPolicy Version=""1"">" +
        "<RuleCollection Type=""Exe"" EnforcementMode=""Enabled"">$($exe -join '')$onedrive</RuleCollection>" +
        "<RuleCollection Type=""Msi"" EnforcementMode=""Enabled"">$($msi -join '')</RuleCollection>" +
        "<RuleCollection Type=""Script"" EnforcementMode=""Enabled"">$($skript -join '')</RuleCollection>" +
        "<RuleCollection Type=""Appx"" EnforcementMode=""Enabled"">$appx</RuleCollection>" +
        "</AppLockerPolicy>"
    # Nur neu setzen, wenn sich die Regeln (ohne die zufaelligen IDs) geaendert haben
    $kern = ($xml -replace 'Id="[0-9a-f-]+"', '')
    $stand = Join-Path $Ziel 'applocker.stand'
    if (-not (Test-Path $stand) -or (Get-Content $stand -Raw) -ne $kern) {
        $datei = Join-Path $Ziel 'applocker.xml'
        Set-Content -Path $datei -Value $xml -Encoding UTF8
        try {
            Set-AppLockerPolicy -XmlPolicy $datei -ErrorAction Stop
            Set-Content -Path $stand -Value $kern -NoNewline
            Log "AppLocker-Regeln gesetzt ($($extra.Count) Zusatzfreigaben)"
        } catch { Log "AppLocker FEHLER: $($_.Exception.Message)" }
    }
    # Ohne den Dienst AppIDSvc setzt Windows keine Regel durch.
    Setze 'HKLM:\SYSTEM\CurrentControlSet\Services\AppIDSvc' 'Start' 2 'DWord'
    Start-Service AppIDSvc -ErrorAction SilentlyContinue
}

Log "Fertig"
