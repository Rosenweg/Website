<#
.SYNOPSIS
    Rosenweg-Agent auf diesem Windows-PC installieren, aktualisieren oder entfernen.

.DESCRIPTION
    Computer-Startskript der Gruppenrichtlinie "Rosenweg-Agent" (einrichten.sh
    daneben). Laeuft als SYSTEM aus dem SYSVOL, bei jedem Start und zusaetzlich
    zweimal am Tag als geplante Aufgabe - so kommt eine neue Version auch auf
    einen PC, der wochenlang nicht neu startet.

    Was es tut:
      1. Liegt im SYSVOL die Datei AUS: Agent sauber entfernen (Sperre
         aufheben, Dienst, Aufgabe, Dateien) und fertig.
      2. Sonst: rosenweg-agent.exe gegen die Pruefsumme daneben pruefen (eine
         halb abgeglichene Datei im SYSVOL wird nicht installiert), bei
         Abweichung zur installierten Fassung Dienst anhalten und ersetzen.
      3. netzstart-einmal.ps1 (os-stationen/sicherung/windows) und agent.json
         daneben legen.
      4. "rosenweg-agent.exe installieren": Dienst anlegen bzw. anpassen, starten.
      5. Die geplante Aufgabe fuer Aktualisierungen anlegen.

    Protokoll: %ProgramData%\Rosenweg\Agent\installieren.log. Der Agent selbst
    schreibt nach agent.log daneben und in die Ereignisanzeige (Anwendung,
    Quelle "Rosenweg-Agent").

    PowerShell 5.1, keine Zusatzmodule.

.PARAMETER Aufgabe
    Aufruf aus der geplanten Aufgabe statt beim Start (steht nur im Protokoll).
#>
param([switch]$Aufgabe)
$ErrorActionPreference = 'Stop'

$Quelle = $PSScriptRoot
$Ziel = Join-Path $env:ProgramFiles 'Rosenweg\Agent'
$Daten = Join-Path $env:ProgramData 'Rosenweg\Agent'
$Exe = Join-Path $Ziel 'rosenweg-agent.exe'
$AufgabeName = 'Rosenweg-Agent aktualisieren'
$Protokoll = Join-Path $Daten 'installieren.log'

function Schreibe([string]$Text) {
    $zeile = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    try {
        if ((Test-Path $Protokoll) -and (Get-Item $Protokoll).Length -gt 256KB) {
            Move-Item -Force $Protokoll "$Protokoll.1"
        }
        Add-Content -Path $Protokoll -Value $zeile -Encoding UTF8
    } catch {
        Write-Output $zeile
    }
}

function Hash([string]$Pfad) {
    if (-not (Test-Path $Pfad)) { return '' }
    return (Get-FileHash -Algorithm SHA256 -Path $Pfad).Hash.ToLowerInvariant()
}

# Nur SYSTEM und Administratoren: hier liegen Protokolle und der Zustand der
# Sperre. Ein Benutzer soll weder das eine lesen noch das andere aendern.
function DatenSchuetzen {
    if (-not (Test-Path $Daten)) { New-Item -ItemType Directory -Path $Daten -Force | Out-Null }
    & icacls.exe $Daten /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls $Daten ist gescheitert ($LASTEXITCODE)" }
}

function Entfernen {
    Schreibe 'AUS liegt im SYSVOL - Agent wird entfernt.'
    if (Test-Path $Exe) {
        $aus = & $Exe entfernen 2>&1
        Schreibe ("rosenweg-agent entfernen: {0}" -f ($aus -join ' '))
        if ($LASTEXITCODE -ne 0) { throw 'rosenweg-agent entfernen ist gescheitert - Dateien bleiben, naechster Lauf versucht es erneut.' }
    }
    Unregister-ScheduledTask -TaskName $AufgabeName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $Ziel -ErrorAction SilentlyContinue
    # Das Protokoll bleibt, damit man sieht, dass und wann entfernt wurde.
    Get-ChildItem $Daten -Exclude 'installieren.log*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Schreibe 'Agent entfernt.'
}

function AufgabeAnlegen {
    $skript = Join-Path $Quelle 'agent-installieren.ps1'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $aktion = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Aufgabe' -f $skript)
    # Mittags und frueh morgens; verpasst (PC aus) -> sobald er laeuft.
    $ausloeser = @(
        (New-ScheduledTaskTrigger -Daily -At '12:30'),
        (New-ScheduledTaskTrigger -Daily -At '03:30')
    )
    $einst = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $wer = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $AufgabeName -Action $aktion -Trigger $ausloeser -Settings $einst -Principal $wer -Force `
        -Description 'Holt eine neue Fassung des Rosenweg-Agenten aus dem SYSVOL (Gruppenrichtlinie Rosenweg-Agent).' | Out-Null
}

try {
    DatenSchuetzen
    Schreibe ("Lauf {0} aus {1}" -f ($(if ($Aufgabe) { 'als Aufgabe' } else { 'beim Start' })), $Quelle)

    if (Test-Path (Join-Path $Quelle 'AUS')) { Entfernen; exit 0 }

    $neu = Join-Path $Quelle 'rosenweg-agent.exe'
    $sollDatei = Join-Path $Quelle 'rosenweg-agent.exe.sha256'
    if (-not (Test-Path $neu) -or -not (Test-Path $sollDatei)) { throw "rosenweg-agent.exe oder .sha256 fehlt in $Quelle" }
    $soll = ((Get-Content -Raw $sollDatei).Trim() -split '\s+')[0].ToLowerInvariant()
    $ist = Hash $neu
    if ($ist -ne $soll) { throw "Pruefsumme im SYSVOL stimmt nicht ($ist statt $soll) - Abgleich zwischen dc1 und dc2 noch nicht fertig? Naechster Lauf." }

    if (-not (Test-Path $Ziel)) { New-Item -ItemType Directory -Path $Ziel -Force | Out-Null }
    if ((Hash $Exe) -ne $soll) {
        Schreibe "Neue Fassung $soll - ersetze."
        $dienst = Get-Service -Name 'RosenwegAgent' -ErrorAction SilentlyContinue
        if ($dienst -and $dienst.Status -ne 'Stopped') { Stop-Service -Name 'RosenwegAgent' -Force; $dienst.WaitForStatus('Stopped', '00:00:30') }
        Copy-Item -Force $neu "$Exe.neu"
        if ((Hash "$Exe.neu") -ne $soll) { throw 'Kopie stimmt nicht mit der Pruefsumme ueberein.' }
        Move-Item -Force "$Exe.neu" $Exe
    }

    foreach ($datei in 'netzstart-einmal.ps1') {
        $q = Join-Path $Quelle $datei
        if ((Test-Path $q) -and ((Hash $q) -ne (Hash (Join-Path $Ziel $datei)))) {
            Copy-Item -Force $q (Join-Path $Ziel $datei)
            Schreibe "$datei aktualisiert."
        }
    }
    $konfig = Join-Path $Quelle 'agent.json'
    if ((Test-Path $konfig) -and ((Hash $konfig) -ne (Hash (Join-Path $Daten 'agent.json')))) {
        Copy-Item -Force $konfig (Join-Path $Daten 'agent.json')
        Schreibe 'agent.json aktualisiert - Dienst startet neu.'
        Restart-Service -Name 'RosenwegAgent' -Force -ErrorAction SilentlyContinue
    }

    $aus = & $Exe installieren 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("rosenweg-agent installieren: {0}" -f ($aus -join ' ')) }
    Schreibe ("Fassung {0}: {1}" -f ((& $Exe version) -join ''), ($aus -join ' '))

    AufgabeAnlegen
} catch {
    Schreibe ("FEHLER: {0}" -f $_.Exception.Message)
    exit 1
}
