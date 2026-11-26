# ============================================================================
# nextcloud-laufwerk.ps1 - die Nextcloud als Laufwerk N: (WebDAV)
# ============================================================================
# Teil der Richtlinie "Rosenweg-Look Windows". Laeuft im Namen der Person:
#   -Anlass Anmelden    geplante Aufgabe "Rosenweg Nextcloud" (rosenweg-look.ps1)
#   -Anlass Einrichten  Startmenue > Rosenweg > "Nextcloud als Laufwerk N"
#   -Anlass Entfernen   Laufwerk trennen und die gespeicherte Anmeldung loeschen
#   -Anlass Probe       nur anzeigen, was der Stand ist (aendert nichts)
#
# Anmeldung: Die Nextcloud kennt keine Passwoerter - ihre Konten kommen aus
# Authentik (user_oidc). WebDAV mit dem AD-Passwort geht deshalb nicht, nur mit
# einem App-Passwort der Nextcloud. Das holt dieses Skript EINMAL pro Person
# ueber den Login-Flow v2 der Nextcloud: Der Browser oeffnet sich, die Person
# meldet sich bei Authentik an (im Haus per Kerberos ohne Passwort, siehe
# README) und klickt "Zugriff gewaehren". Das App-Passwort liegt danach
# DPAPI-verschluesselt im Profil der Person (%APPDATA%\Rosenweg\nextcloud.anmeldung).
# Es wandert mit dem servergespeicherten Profil auf jeden Rechner, ist nur fuer
# diese Person lesbar und steht nie im SYSVOL oder in einer Befehlszeile.
#
# Verbunden wird mit WNetAddConnection2 (wie "net use", aber ohne Rueckfrage
# und ohne Passwort in der Befehlszeile), nicht dauerhaft - jede Anmeldung
# verbindet neu.
#
# Gilt das App-Passwort nicht mehr (in der Nextcloud unter Einstellungen >
# Sicherheit widerrufen, Konto gesperrt), merkt das die naechste Anmeldung,
# loescht es und fragt, ob neu verbunden werden soll.
#
# Protokoll: %LOCALAPPDATA%\Rosenweg\nextcloud.log
# ============================================================================
param(
    [ValidateSet('Anmelden', 'Einrichten', 'Entfernen', 'Probe')] [string]$Anlass = 'Probe'
)
$ErrorActionPreference = 'Continue'

$Server    = 'nextcloud.rosenweg4303.ch'
$Basis     = "https://$Server"
$Buchstabe = 'N:'
$Name      = 'Nextcloud'
$Profil    = Join-Path $env:APPDATA 'Rosenweg'
$Datei     = Join-Path $Profil 'nextcloud.anmeldung'
$Merker    = 'HKCU:\Software\Rosenweg\Nextcloud'
$LogDatei  = Join-Path $env:LOCALAPPDATA 'Rosenweg\nextcloud.log'

New-Item -ItemType Directory -Force -Path (Split-Path $LogDatei) | Out-Null
function Log([string]$t) {
    "$(Get-Date -Format s)  [$Anlass] $t" | Add-Content -Path $LogDatei -Encoding UTF8
    # Write-Host, nicht Write-Output: sonst landete der Text im Rueckgabewert
    if ($Anlass -eq 'Probe') { Write-Host $t }
}
# Windows 10 hat in .NET nicht immer TLS 1.2 als Vorgabe.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Add-Type -Namespace Rosenweg -Name Netz -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public class NETRESOURCE {
    public int dwScope; public int dwType = 1; public int dwDisplayType; public int dwUsage;
    public string lpLocalName; public string lpRemoteName; public string lpComment; public string lpProvider;
}
[DllImport("mpr.dll", CharSet = CharSet.Unicode)]
public static extern int WNetAddConnection2(NETRESOURCE res, string password, string user, int flags);
[DllImport("mpr.dll", CharSet = CharSet.Unicode)]
public static extern int WNetCancelConnection2(string name, int flags, bool force);
[DllImport("mpr.dll", CharSet = CharSet.Unicode)]
public static extern int WNetGetConnection(string local, System.Text.StringBuilder remote, ref int length);
'@

# --- Gespeicherte Anmeldung ------------------------------------------------
function Lies {
    if (-not (Test-Path $Datei)) { return $null }
    try {
        $j = Get-Content $Datei -Raw | ConvertFrom-Json
        $geheim = $j.passwort | ConvertTo-SecureString -ErrorAction Stop
        return [pscustomobject]@{ Benutzer = [string]$j.benutzer; Geheim = $geheim }
    } catch {
        # z.B. DPAPI-Schluessel nach einem Zuruecksetzen des AD-Passworts weg
        Log "gespeicherte Anmeldung nicht lesbar ($($_.Exception.Message)) - geloescht"
        Remove-Item $Datei -Force -ErrorAction SilentlyContinue
        return $null
    }
}
function Speichere([string]$benutzer, [string]$passwort) {
    New-Item -ItemType Directory -Force -Path $Profil | Out-Null
    $geheim = ConvertTo-SecureString $passwort -AsPlainText -Force | ConvertFrom-SecureString
    [ordered]@{ benutzer = $benutzer; passwort = $geheim; seit = (Get-Date -Format s); rechner = $env:COMPUTERNAME } |
        ConvertTo-Json | Set-Content -Path $Datei -Encoding UTF8
}
function Klartext($geheim) {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($geheim))
}

# --- Pruefen und Verbinden -------------------------------------------------
function Erreichbar {
    try { $null = Invoke-RestMethod -UseBasicParsing -TimeoutSec 8 -Uri "$Basis/status.php"; return $true } catch { return $false }
}
# 'gut', 'abgelehnt' (401: App-Passwort ungueltig) oder 'unklar'
function Gueltig($a) {
    $paar = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($a.Benutzer):$(Klartext $a.Geheim)"))
    try {
        $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$Basis/ocs/v2.php/cloud/user?format=json" `
            -Headers @{ Authorization = "Basic $paar"; 'OCS-APIRequest' = 'true' }
        return 'gut'
    } catch {
        $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401) { return 'abgelehnt' }
        Log "Pruefung der Anmeldung: $($_.Exception.Message)"
        return 'unklar'
    }
}
function Ziel([string]$benutzer) { "\\$Server@SSL\remote.php\dav\files\$benutzer" }
function Verbunden([string]$ziel) {
    $sb = New-Object Text.StringBuilder 1024; $n = 1024
    $fehler = [Rosenweg.Netz]::WNetGetConnection($Buchstabe, $sb, [ref]$n)
    # 2250 = keine Netzverbindung unter diesem Buchstaben
    if ($fehler -eq 2250 -and -not (Test-Path "$Buchstabe\")) { return 'frei' }
    if ($fehler -eq 0 -and $sb.ToString().TrimEnd('\') -ieq $ziel) { return 'ja' }
    return "belegt ($(if ($fehler -eq 0) { $sb.ToString() } else { 'lokal oder getrennt' }))"
}
function Verbinde($a) {
    $ziel = Ziel $a.Benutzer
    $stand = Verbunden $ziel
    if ($stand -eq 'ja') { Log "$Buchstabe ist schon verbunden"; return 0 }
    if ($stand -ne 'frei') { Log "$Buchstabe ist $stand - nicht verbunden"; return -1 }
    $r = New-Object Rosenweg.Netz+NETRESOURCE
    $r.lpLocalName = $Buchstabe; $r.lpRemoteName = $ziel
    # flags 0: nicht dauerhaft, keine Rueckfrage
    $fehler = [Rosenweg.Netz]::WNetAddConnection2($r, (Klartext $a.Geheim), $a.Benutzer, 0)
    if ($fehler -eq 0) {
        # Anzeigename im Explorer statt "stefan.mueller (\\nextcloud...@SSL\...)"
        $schluessel = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2\' + ($ziel -replace '\\', '#')
        New-Item -Path $schluessel -Force | Out-Null
        New-ItemProperty -Path $schluessel -Name '_LabelFromReg' -Value $Name -PropertyType String -Force | Out-Null
        Log "$Buchstabe verbunden mit $ziel"
    } else {
        Log "$Buchstabe verbinden FEHLER $fehler ($((New-Object ComponentModel.Win32Exception $fehler).Message))"
    }
    return $fehler
}
function Trenne {
    $null = [Rosenweg.Netz]::WNetCancelConnection2($Buchstabe, 0, $true)
}

# --- Einmal einrichten: Login-Flow v2 --------------------------------------
Add-Type -AssemblyName System.Windows.Forms
# DefaultDesktopOnly: die Frage steht vorne, auch wenn bei der Anmeldung
# gerade Explorer und andere Fenster aufgehen (das Skript hat kein Fenster).
function Frage([string]$text) {
    [Windows.Forms.MessageBox]::Show($text, 'Nextcloud als Laufwerk N:', 'YesNo', 'Question', 'Button1', 'DefaultDesktopOnly') -eq 'Yes'
}
function Hinweis([string]$text, [string]$art = 'Information') {
    $null = [Windows.Forms.MessageBox]::Show($text, 'Nextcloud als Laufwerk N:', 'OK', $art, 'Button1', 'DefaultDesktopOnly')
}
function Einrichten {
    # Der Name erscheint in der Nextcloud unter Einstellungen > Sicherheit
    $ua = "Windows-Laufwerk N: (eingerichtet auf $env:COMPUTERNAME)"
    try {
        $flow = Invoke-RestMethod -UseBasicParsing -Method Post -TimeoutSec 15 -UserAgent $ua -Uri "$Basis/index.php/login/v2"
    } catch {
        Log "Login-Flow nicht startbar: $($_.Exception.Message)"
        Hinweis "Die Nextcloud ist gerade nicht erreichbar. Später im Startmenü unter Rosenweg > «Nextcloud als Laufwerk N» erneut versuchen." 'Warning'
        return $null
    }
    Start-Process $flow.login
    Log "Login-Flow gestartet, warte auf Freigabe im Browser"
    # Der Flow gilt 20 Minuten; die Nextcloud antwortet 404, bis freigegeben ist.
    $bis = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $bis) {
        Start-Sleep -Seconds 3
        try {
            $e = Invoke-RestMethod -UseBasicParsing -Method Post -TimeoutSec 15 -Uri $flow.poll.endpoint -Body @{ token = $flow.poll.token }
        } catch { continue }
        if ($e.appPassword -and $e.loginName) {
            if ($e.server.TrimEnd('/') -ne $Basis) { Log "Login-Flow: unerwarteter Server $($e.server) - verworfen"; return $null }
            Speichere $e.loginName $e.appPassword
            Log "App-Passwort fuer $($e.loginName) gespeichert"
            return Lies
        }
    }
    Log "Login-Flow: keine Freigabe innert 15 Minuten"
    return $null
}
function MitFrage([string]$text) {
    if (-not (Frage $text)) {
        New-Item -Path $Merker -Force | Out-Null
        New-ItemProperty -Path $Merker -Name 'NichtFragen' -Value 1 -PropertyType DWord -Force | Out-Null
        Hinweis "In Ordnung. Einrichten geht jederzeit im Startmenü unter Rosenweg > «Nextcloud als Laufwerk N»."
        Log "abgelehnt - bei der Anmeldung wird nicht mehr gefragt"
        return $null
    }
    return Einrichten
}

# --- Ablauf ----------------------------------------------------------------
$a = Lies
switch ($Anlass) {
    'Probe' {
        Log "Anmeldung gespeichert: $(if ($a) { "ja, als $($a.Benutzer)" } else { 'nein' })"
        Log "Nicht fragen: $([bool](Get-ItemProperty $Merker -ErrorAction SilentlyContinue).NichtFragen)"
        Log "Server erreichbar: $(Erreichbar)"
        if ($a) { Log "App-Passwort: $(Gueltig $a)"; Log "$Buchstabe : $(Verbunden (Ziel $a.Benutzer))" }
        Log "Dienst WebClient: $((Get-Service WebClient -ErrorAction SilentlyContinue).Status)"
    }
    'Entfernen' {
        Trenne
        Remove-Item $Datei -Force -ErrorAction SilentlyContinue
        New-Item -Path $Merker -Force | Out-Null
        New-ItemProperty -Path $Merker -Name 'NichtFragen' -Value 1 -PropertyType DWord -Force | Out-Null
        Log "entfernt (App-Passwort in der Nextcloud unter Einstellungen > Sicherheit widerrufen)"
    }
    'Einrichten' {
        Remove-ItemProperty -Path $Merker -Name 'NichtFragen' -ErrorAction SilentlyContinue
        if ($a -and (Gueltig $a) -ne 'abgelehnt') {
            if ((Verbinde $a) -eq 0) { Hinweis "Die Nextcloud ist als Laufwerk N: verbunden."; Start-Process explorer.exe $Buchstabe }
            else { Hinweis "N: liess sich nicht verbinden. Details: $LogDatei" 'Warning' }
            break
        }
        Trenne
        $a = Einrichten
        if (-not $a) { break }
        if ((Verbinde $a) -eq 0) {
            Hinweis "Fertig. Die Nextcloud ist als Laufwerk N: verbunden, ab jetzt bei jeder Anmeldung – auch an anderen Rosenweg-PCs."
            Start-Process explorer.exe $Buchstabe
        } else { Hinweis "Die Anmeldung ist gespeichert, aber N: liess sich nicht verbinden. Details: $LogDatei" 'Warning' }
    }
    'Anmelden' {
        if (-not $a) {
            if ((Get-ItemProperty $Merker -ErrorAction SilentlyContinue).NichtFragen) { Log "nicht eingerichtet, Fragen abgelehnt"; break }
            if (-not (Erreichbar)) { Log "nicht eingerichtet, Server nicht erreichbar - naechstes Mal"; break }
            $a = MitFrage ("Die Nextcloud als Laufwerk N: einbinden?`n`n" +
                "Dafür öffnet sich einmal der Browser. Dort anmelden (im Haus genügt «SSO Login») " +
                "und «Zugriff gewähren» klicken. Danach ist N: bei jeder Anmeldung da, auch an anderen Rosenweg-PCs.")
            if ($a) { $null = Verbinde $a }
            break
        }
        $fehler = Verbinde $a
        if ($fehler -eq 0 -or $fehler -eq -1) { break }
        if (-not (Erreichbar)) { Log "Server nicht erreichbar - naechstes Mal"; break }
        if ((Gueltig $a) -eq 'abgelehnt') {
            Remove-Item $Datei -Force -ErrorAction SilentlyContinue
            Log "App-Passwort abgelehnt (401) - geloescht"
            $a = MitFrage ("Die Verbindung der Nextcloud (Laufwerk N:) ist nicht mehr gültig, " +
                "zum Beispiel weil sie in der Nextcloud abgemeldet wurde.`n`nNeu verbinden? Dafür öffnet sich einmal der Browser.")
            if ($a) { $null = Verbinde $a }
        }
    }
}
