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
foreach ($p in $profile) {
    if (-not (Test-Path $p.Datei)) { continue }
    if ($p.Geladen) {
        # Angemeldet (Skript von Hand gestartet): direkt in den geladenen Zweig
        $k = "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
        Setze $k 'TaskbarAl' 0 'DWord'
        Setze "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop" 'NoChangingWallPaper' 1 'DWord'
        Setze "Registry::HKEY_USERS\$($p.Sid)\Software\Microsoft\Windows NT\CurrentVersion\Windows" 'LegacyDefaultPrinterMode' 1 'DWord'
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
