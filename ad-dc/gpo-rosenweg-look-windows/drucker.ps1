# ============================================================================
# drucker.ps1 - Drucker im Benutzerprofil aufraeumen, Standard der Station
# ============================================================================
# Teil der Richtlinie "Rosenweg-Look Windows". Laeuft im Namen der Person:
#   -Anlass Anmelden   geplante Aufgabe "Rosenweg Drucker" (rosenweg-look.ps1)
#   -Anlass Abmelden   Abmeldeskript der Richtlinie (einrichten.sh)
#
# Warum: Die Profile sind servergespeichert und tragen Druckereintraege von
# frueheren PCs mit - SMB-Verbindungen (\\100.64.2.32\DruckerR9), Brother,
# AnyDesk Printer, PDF24 ... - und als Standard einen Drucker, den es auf dem
# Rechner nicht gibt. Programme druckten dann ins Leere (win11-1, 26.11.2026).
# Die echten Drucker richtet rosenweg-look.ps1 rechnerweit ein (IPP zum CUPS).
#
# Regel: Ein Eintrag im Profil bleibt nur, wenn es den Drucker auf DIESEM
# Rechner gibt (HKLM\...\Print\Printers - die rechnerweiten, inkl.
# "Microsoft Print to PDF"). Alles andere wird entfernt. Rechnerweite Drucker
# werden nie angefasst.
#
# Standarddrucker: der der Station, gepflegt in der Verwaltung auf /stationen
# (GET /api/stations/drucker/<rechner>). Ist sie nicht erreichbar, gilt der
# beim Start zuletzt geholte Wert (C:\ProgramData\Rosenweg\
# standarddrucker.json), sonst $Vorgabe. "keiner" heisst: nicht umstellen -
# ausser der bisherige Standard existiert hier nicht.
#
# Pruefen ohne Aendern:  -Probelauf (zeigt nur, was entfernt wuerde).
# Gegen eine geladene Kopie eines Profils:  -Wurzel 'Registry::HKEY_USERS\Probe'
#
# Protokoll: Ereignisanzeige > Windows-Protokolle > Anwendung, Quelle
# "Rosenweg Drucker" (angelegt von rosenweg-look.ps1); fehlt die Quelle,
# %LOCALAPPDATA%\Rosenweg\drucker.log.
# ============================================================================
param(
    [ValidateSet('Anmelden', 'Abmelden', 'Probe')] [string]$Anlass = 'Probe',
    [switch]$Probelauf,
    [string]$Wurzel = 'HKCU:'
)
$ErrorActionPreference = 'Continue'
if ($Anlass -eq 'Probe') { $Probelauf = $true }

# Gilt, wenn die Verwaltung den Rechner nicht kennt und nichts zwischengespeichert ist.
$Vorgabe = 'DruckerR9'
$Api = "https://www.rosenweg4303.ch/api/stations/drucker/$env:COMPUTERNAME"
$Cache = Join-Path $env:ProgramData 'Rosenweg\standarddrucker.json'

$zeilen = New-Object System.Collections.Generic.List[string]
function Notiz([string]$t) { $zeilen.Add($t); if ($Probelauf) { Write-Output $t } }

# --- Was gibt es hier? -----------------------------------------------------
$hier = @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.PSChildName })
function Gueltig([string]$name) { $hier -contains $name }

# --- Aufraeumen --------------------------------------------------------------
function Entferne([string]$was, [scriptblock]$tun) {
    if ($Probelauf) { Notiz "wuerde entfernen: $was" }
    else { try { & $tun; Notiz "entfernt: $was" } catch { Notiz "FEHLER bei ${was}: $($_.Exception.Message)" } }
}

# Druckerverbindungen (\\server\drucker): Unterschluessel ",,server,drucker"
$verb = "$Wurzel\Printers\Connections"
foreach ($k in @(Get-ChildItem $verb -ErrorAction SilentlyContinue)) {
    $name = $k.PSChildName -replace ',', '\'
    if (-not (Gueltig $name)) {
        $pfad = $k.PSPath
        Entferne "Verbindung $name" { Remove-Item -LiteralPath $pfad -Recurse -Force -ErrorAction Stop }
    }
}
# Werte je Druckername: die Liste der Drucker (Devices, PrinterPorts) und die
# gespeicherten Druckeinstellungen (DevModes2, DevModePerUser).
foreach ($teil in 'Software\Microsoft\Windows NT\CurrentVersion\Devices',
                  'Software\Microsoft\Windows NT\CurrentVersion\PrinterPorts',
                  'Printers\DevModes2', 'Printers\DevModePerUser') {
    $k = "$Wurzel\$teil"
    $item = Get-Item $k -ErrorAction SilentlyContinue
    if (-not $item) { continue }
    foreach ($name in $item.GetValueNames()) {
        if ($name -and -not (Gueltig $name)) {
            Entferne "$(Split-Path $teil -Leaf): $name" { Remove-ItemProperty -LiteralPath $k -Name $name -Force -ErrorAction Stop }
        }
    }
}

# --- Standarddrucker ---------------------------------------------------------
$win = "$Wurzel\Software\Microsoft\Windows NT\CurrentVersion\Windows"
# Windows soll den Standard nicht selbst auf den zuletzt benutzten umstellen
# ("Windows verwaltet Standarddrucker" aus) - er gehoert der Station.
if (-not $Probelauf) {
    if (-not (Test-Path $win)) { New-Item -Path $win -Force | Out-Null }
    New-ItemProperty -Path $win -Name 'LegacyDefaultPrinterMode' -Value 1 -PropertyType DWord -Force | Out-Null
}

# Was soll Standard sein? Erst die Verwaltung (nur bei der Anmeldung - beim
# Abmelden soll niemand auf ein Netz warten), dann der Vorrat vom Start.
$soll = $null; $quelle = $null
if ($Anlass -ne 'Abmelden') {
    try {
        $a = Invoke-RestMethod -UseBasicParsing -TimeoutSec 4 -Uri $Api
        if ($null -ne $a.bekannt) { $soll = $a; $quelle = 'Verwaltung' }
    } catch { Notiz "Verwaltung nicht erreichbar: $($_.Exception.Message)" }
}
if (-not $soll -and (Test-Path $Cache)) {
    try { $soll = Get-Content $Cache -Raw | ConvertFrom-Json; $quelle = "Vorrat vom $($soll.geholt)" } catch { }
}
$ziel = $null
if ($soll -and $soll.bekannt) { $ziel = $soll.standard }      # $null = "keiner"
elseif ($soll) { $ziel = $Vorgabe; $quelle += ', Rechner nicht eingetragen -> Vorgabe' }
else { $ziel = $Vorgabe; $quelle = 'Vorgabe' }

$jetzt = [string](Get-ItemProperty $win -Name Device -ErrorAction SilentlyContinue).Device
$jetztName = ($jetzt -split ',')[0]
if (-not $ziel -and $jetztName -and -not (Gueltig $jetztName)) {
    # "keiner" - aber der bisherige existiert hier nicht: auf einen gueltigen.
    $ziel = $Vorgabe; $quelle += ', bisheriger ungueltig -> Vorgabe'
}
if ($ziel -and -not (Gueltig $ziel)) {
    Notiz "Standarddrucker $ziel ($quelle) gibt es auf diesem Rechner nicht - nicht gesetzt"
    $ziel = $null
}
if ($ziel -and $ziel -ne $jetztName) {
    if ($Probelauf) { Notiz "wuerde Standarddrucker setzen: $ziel (bisher: $(if ($jetztName) { $jetztName } else { 'keiner' }); $quelle)" }
    else {
        $ok = $false
        if ($Wurzel -eq 'HKCU:' -and $Anlass -eq 'Anmelden') {
            # Ueber die Druckerverwaltung: meldet die Aenderung auch laufenden Programmen.
            try {
                Get-CimInstance Win32_Printer -Filter ("Name='{0}'" -f $ziel.Replace("'", "''")) -ErrorAction Stop |
                    Invoke-CimMethod -MethodName SetDefaultPrinter -ErrorAction Stop | Out-Null
                $ok = $true
            } catch { Notiz "SetDefaultPrinter: $($_.Exception.Message)" }
        }
        if (-not $ok) {
            # Beim Abmelden direkt in den Wert, den Windows bei der naechsten
            # Anmeldung liest: "<Name>,winspool,<Port>" wie in Devices.
            $port = [string](Get-ItemProperty "$Wurzel\Software\Microsoft\Windows NT\CurrentVersion\Devices" -Name $ziel -ErrorAction SilentlyContinue).$ziel
            if (-not $port) { $port = 'winspool,Ne00:' }
            New-ItemProperty -Path $win -Name 'Device' -Value "$ziel,$port" -PropertyType String -Force | Out-Null
        }
        Notiz "Standarddrucker gesetzt: $ziel (bisher: $(if ($jetztName) { $jetztName } else { 'keiner' }); $quelle)"
    }
}

# --- Protokoll ---------------------------------------------------------------
if (-not $Probelauf) {
    $text = "drucker.ps1 ($Anlass) fuer $env:USERNAME auf ${env:COMPUTERNAME}:`r`n" +
        $(if ($zeilen.Count) { $zeilen -join "`r`n" } else { 'nichts zu tun' })
    try {
        Write-EventLog -LogName Application -Source 'Rosenweg Drucker' -EventId 1000 -EntryType Information -Message $text -ErrorAction Stop
    } catch {
        $ordner = Join-Path $env:LOCALAPPDATA 'Rosenweg'
        New-Item -ItemType Directory -Force -Path $ordner | Out-Null
        "$(Get-Date -Format s)  $text" | Add-Content -Path (Join-Path $ordner 'drucker.log') -Encoding UTF8
    }
}
