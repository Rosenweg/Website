# ============================================================================
# aufraeumen.ps1 - Edge und OneDrive aus dem Profil, VLC und IrfanView
#                  einstellen, bei jeder Anmeldung
# ============================================================================
# Teil der Gruppenrichtlinie "Rosenweg-Look Windows". Laeuft im Namen der
# Person (geplante Aufgabe "Rosenweg Aufraeumen", wie BGInfo), weil die
# Profile servergespeichert sind: was das Startskript beim Start im lokalen
# Profil loescht, kaeme mit der naechsten Anmeldung vom Server zurueck.
#
# Entfernt - nur Verknuepfungen und Autostarts, keine Daten:
#   - Autostart von OneDrive und Edge (HKCU\...\Run: OneDrive, OneDriveSetup,
#     MicrosoftEdgeAutoLaunch_*)
#   - "Microsoft Edge.lnk" auf dem Schreibtisch und in der Taskleiste
#   - laufendes OneDrive (die Richtlinie DisableFileSyncNGSC haelt es ab da fern)
# Der Ordner %USERPROFILE%\OneDrive bleibt, wie er ist.
#
# Setzt (die Programme lesen das nur aus dem Profil, nicht rechnerweit):
#   - VLC (%APPDATA%\vlc\vlcrc): keine Frage nach Datenschutz/Netz beim
#     ersten Start, keine Hinweise auf neue Versionen (die kommen ueber die
#     Richtlinie), keine Titel/Cover aus dem Netz
#   - IrfanView (%APPDATA%\IrfanView\i_view64.ini): Sprache Deutsch, wenn
#     die deutsche Sprachdatei installiert ist
# Nur diese Werte; alles andere bleibt, wie die Person es eingestellt hat.
#
# Protokoll: Ereignisanzeige > Anwendung, Quelle "Rosenweg Drucker" (die
# Quelle gibt es schon; eine eigene anzulegen darf nur ein Admin).
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'
$notiz = New-Object System.Collections.Generic.List[string]

$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$k = Get-Item $run
if ($k) {
    foreach ($name in $k.GetValueNames()) {
        if ($name -in 'OneDrive', 'OneDriveSetup' -or $name -like 'MicrosoftEdgeAutoLaunch_*') {
            Remove-ItemProperty -Path $run -Name $name
            $notiz.Add("Autostart entfernt: $name")
        }
    }
}

$orte = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
foreach ($ort in $orte) {
    $lnk = Join-Path $ort 'Microsoft Edge.lnk'
    if ($ort -and (Test-Path -LiteralPath $lnk)) {
        Remove-Item -LiteralPath $lnk -Force
        $notiz.Add("entfernt: $lnk")
    }
}

$od = Get-Process -Name OneDrive | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }
if ($od) { $od | Stop-Process -Force; $notiz.Add('OneDrive beendet') }

# --- VLC ---------------------------------------------------------------------
# VLC liest vlcrc ohne Abschnitte (Zeilen "name=wert", [..] und # werden
# uebergangen) - eine neue Datei mit nur diesen Zeilen genuegt, VLC ergaenzt
# den Rest beim Speichern. UTF-8; ein BOM (schreibt VLC selbst) liest .NET mit.
$vlcExe = Join-Path $env:ProgramFiles 'VideoLAN\VLC\vlc.exe'
if (Test-Path $vlcExe) {
    $vlcSoll = [ordered]@{ 'qt-privacy-ask' = '0'; 'qt-updates-notif' = '0'; 'metadata-network-access' = '0' }
    $vlcrc = Join-Path $env:APPDATA 'vlc\vlcrc'
    $zeilen = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $vlcrc) { foreach ($z in [System.IO.File]::ReadAllLines($vlcrc)) { $zeilen.Add($z) } }
    $geaendert = @()
    foreach ($n in $vlcSoll.Keys) {
        $soll = "$n=$($vlcSoll[$n])"
        $i = -1
        for ($j = 0; $j -lt $zeilen.Count; $j++) { if ($zeilen[$j] -match "^#?$([regex]::Escape($n))=") { $i = $j; if ($zeilen[$j] -notlike '#*') { break } } }
        if ($i -lt 0) { $zeilen.Add($soll); $geaendert += $n }
        elseif ($zeilen[$i] -ne $soll) { $zeilen[$i] = $soll; $geaendert += $n }
    }
    if ($geaendert.Count) {
        New-Item -ItemType Directory -Force -Path (Split-Path $vlcrc) | Out-Null
        [System.IO.File]::WriteAllLines($vlcrc, $zeilen, (New-Object System.Text.UTF8Encoding($false)))
        $notiz.Add("VLC eingestellt: $($geaendert -join ', ')")
    }
}

# --- IrfanView --------------------------------------------------------------
# Die INI liegt je Person in %APPDATA%\IrfanView (Installer mit /ini). Sie ist
# eine gewoehnliche INI; IrfanView schreibt sie als UTF-16 (mit BOM) oder
# ANSI - beim Zurueckschreiben bleibt es bei der Kodierung, die sie hatte.
$ivSprache = Join-Path $env:ProgramFiles 'IrfanView\Languages\Deutsch.dll'
if (Test-Path $ivSprache) {
    $ini = Join-Path $env:APPDATA 'IrfanView\i_view64.ini'
    $kod = [System.Text.Encoding]::Default
    $text = ''
    if (Test-Path -LiteralPath $ini) {
        $roh = [System.IO.File]::ReadAllBytes($ini)
        if ($roh.Length -ge 2 -and $roh[0] -eq 0xFF -and $roh[1] -eq 0xFE) { $kod = [System.Text.Encoding]::Unicode }
        elseif ($roh.Length -ge 3 -and $roh[0] -eq 0xEF -and $roh[1] -eq 0xBB -and $roh[2] -eq 0xBF) { $kod = New-Object System.Text.UTF8Encoding($true) }
        $text = [System.IO.File]::ReadAllText($ini, $kod)
    }
    $neu = $text
    # Nur innerhalb von [Language] (bis zum naechsten Abschnitt)
    $abschnitt = [regex]'(?m)^\[Language\][ \t]*\r?$([^\[]*?)^DLL=[^\r\n]*'
    if ($abschnitt.IsMatch($neu)) {
        $neu = $abschnitt.Replace($neu, { param($t) $t.Value -replace 'DLL=[^\r\n]*$', 'DLL=Deutsch.dll' }, 1)
    } elseif ($neu -match '(?m)^\[Language\][ \t]*\r?$') {
        $neu = ([regex]'(?m)^\[Language\][ \t]*\r?$').Replace($neu, "[Language]`r`nDLL=Deutsch.dll", 1)
    } else {
        if ($neu -and -not $neu.EndsWith("`n")) { $neu += "`r`n" }
        $neu += "[Language]`r`nDLL=Deutsch.dll`r`n"
    }
    if ($neu -ne $text) {
        New-Item -ItemType Directory -Force -Path (Split-Path $ini) | Out-Null
        [System.IO.File]::WriteAllText($ini, $neu, $kod)
        $notiz.Add('IrfanView: Sprache Deutsch')
    }
}

if ($notiz.Count) {
    try {
        Write-EventLog -LogName Application -Source 'Rosenweg Drucker' -EventId 20 -EntryType Information `
            -Message ("Aufraeumen ($env:USERNAME):`r`n" + ($notiz -join "`r`n"))
    } catch { }
}
