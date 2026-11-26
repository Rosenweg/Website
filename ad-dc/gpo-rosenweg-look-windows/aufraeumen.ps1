# ============================================================================
# aufraeumen.ps1 - Edge und OneDrive aus dem Profil, bei jeder Anmeldung
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

if ($notiz.Count) {
    try {
        Write-EventLog -LogName Application -Source 'Rosenweg Drucker' -EventId 20 -EntryType Information `
            -Message ("Aufraeumen ($env:USERNAME):`r`n" + ($notiz -join "`r`n"))
    } catch { }
}
