# ============================================================================
# programme.ps1 - erlaubte Programme (AppLocker) auf den Windows-Rechnern
# ============================================================================
# Teil der Gruppenrichtlinie "Rosenweg-Look Windows". rosenweg-look.ps1 legt
# dieses Skript beim Start nach C:\Program Files\Rosenweg, ruft es dort einmal
# auf und richtet die Aufgabe "Rosenweg Programme" ein (SYSTEM, alle 30 min).
#
# Zwei Regelwerke:
#
#   Grundschutz    seit 22.11.2026 durchgesetzt: alles unter C:\Windows und
#                  den Programme-Ordnern, signierte Store-Apps, OneDrive.
#                  Blockiert vor allem Heruntergeladenes (Downloads, AppData).
#   Positivliste   wie auf den Linux-Stationen (os-stationen 60-programme.sh):
#                  unter Programme nur, was auf /stationen erlaubt ist - fuer
#                  alle Windows-Rechner und zusaetzlich je Rechner. Ebenso die
#                  Store-Apps. Liste und Katalog: GET /api/stations/programme/
#                  <RECHNER> (api/lib/windowsprogramme.js).
#
# Modus (auf /stationen, Vorgabe "probe"):
#   probe        Durchgesetzt bleibt der Grundschutz. Die Positivliste wird nur
#                geprueft: jedes Programm, das laut AppLocker-Protokoll lief
#                (8002 / 8020), geht durch Test-AppLockerPolicy gegen die
#                Positivliste. Was sie blockiert haette, steht in
#                probe.json und geht an die Verwaltung - /stationen zeigt es.
#                So geht nichts kaputt, waehrend die Liste waechst.
#   durchsetzen  Die Positivliste gilt. Gemeldet werden die echten Sperren
#                (8004 / 8022).
#
# Immer und unabhaengig von der Verwaltung (die API kann nur ERLAUBEN):
#   - alles unter C:\Windows
#   - die Defender-Plattform (C:\ProgramData\Microsoft\Windows Defender\
#     Platform). Sie aktualisiert sich dorthin, nicht nach Programme - der
#     Grundschutz blockierte deshalb DefenderAIPlatformHost.exe (win11-1,
#     26.11.2026, Ereignis 8004 als LocalService).
#   - Dienste (SERVICE, LocalService, NetworkService) unter Programme: die
#     Liste gilt Personen, nicht Diensten. SYSTEM prueft AppLocker ohnehin nicht.
#   - die AD-Gruppe Windows-Programme-frei und Administratoren mit
#     Admin-Token: alles (Begruendung in rosenweg-look.ps1 / README)
#   - programme-freigaben.txt aus der Richtlinie (Git, einrichten.sh)
# Gesperrt (Liste "sperren", heute Edge und OneDrive) sind Verbote in der
# Positivliste - sie wirken also im selben Modus wie sie.
# Freigaben aus der Verwaltung nur unter den Programme-Ordnern (hier noch
# einmal geprueft) - dort schreiben nur Admins.
#
# Ist die Verwaltung nicht erreichbar, gilt die zuletzt geholte Liste. Gab es
# nie eine, bleibt es beim Grundschutz.
#
# Ablage: C:\Program Files\Rosenweg\programme\ (nur Admins schreiben dort -
# unter ProgramData duerften normale Benutzer Dateien anlegen, und eine
# untergeschobene liste.json waere eine Freigabe).
#   liste.json         letzte Antwort der Verwaltung
#   positivliste.xml   die Positivliste als AppLocker-Regeln
#   aktiv.xml          was gerade gesetzt ist (Grundschutz oder Positivliste)
#   probe.json         blockiert (haette), letzte 30 Tage
#   programme.log      Protokoll
#
# Von Hand (als Admin):  & 'C:\Program Files\Rosenweg\programme.ps1'
#   -NurPruefen          setzt nichts, schreibt nichts, zeigt die Auswertung
#                        (wertet dann das ganze Protokoll aus, nicht nur Neues)
#   -ListeJson '<json>'  statt der Verwaltung diese Liste (zum Ausprobieren)
#   -AlsPerson Jeder     mit -NurPruefen: so pruefen, als haette eine normale
#                        Person alles gestartet, was im Protokoll steht (die
#                        Technik ist ausgenommen, ihre Laeufe zeigen sonst nichts)
# ============================================================================
param([switch]$NurPruefen, [string]$ListeJson, [string]$AlsPerson)
if ($AlsPerson -eq 'Jeder') { $AlsPerson = 'S-1-1-0' }
if ($AlsPerson -and -not $NurPruefen) { throw '-AlsPerson nur zusammen mit -NurPruefen' }
$ErrorActionPreference = 'Continue'
Import-Module AppLocker -ErrorAction SilentlyContinue

$Api      = "https://www.rosenweg4303.ch/api/stations/programme/$env:COMPUTERNAME"
$Prog     = Join-Path $env:ProgramFiles 'Rosenweg'
$Ablage   = Join-Path $Prog 'programme'
$LogDatei = Join-Path $Ablage 'programme.log'
$TageAufheben = 30

function Log([string]$t) {
    if ($NurPruefen) { Write-Output $t; return }
    "$(Get-Date -Format s)  $t" | Add-Content -Path $LogDatei -Encoding UTF8
}
if (-not $NurPruefen) {
    New-Item -ItemType Directory -Force -Path $Ablage | Out-Null
    # Protokoll klein halten
    if ((Test-Path $LogDatei) -and (Get-Item $LogDatei).Length -gt 1MB) {
        Move-Item $LogDatei "$LogDatei.alt" -Force
    }
}

# --- Wer darf alles ----------------------------------------------------------
try {
    $frei = (New-Object System.Security.Principal.NTAccount('ROSENWEG', 'Windows-Programme-frei')).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {
    Log "Gruppe Windows-Programme-frei nicht aufloesbar - Regeln bleiben, wie sie sind"
    return
}
$jeder = 'S-1-1-0'; $admins = 'S-1-5-32-544'
$dienste = @('S-1-5-6', 'S-1-5-19', 'S-1-5-20')   # SERVICE, LocalService, NetworkService

# --- Liste von der Verwaltung -----------------------------------------------
$listeDatei = Join-Path $Ablage 'liste.json'
$liste = $null
try {
    $antwort = if ($ListeJson) { $ListeJson | ConvertFrom-Json } else { Invoke-RestMethod -UseBasicParsing -TimeoutSec 8 -Uri $Api }
    if ($antwort.format -eq 1 -and $antwort.modus -and $null -ne $antwort.programme) {
        $liste = $antwort
        if (-not $NurPruefen) { $antwort | ConvertTo-Json -Depth 8 | Set-Content -Path $listeDatei -Encoding UTF8 }
    } else { Log "Antwort der Verwaltung unbrauchbar (format $($antwort.format))" }
} catch { Log "Verwaltung nicht erreichbar ($($_.Exception.Message)) - zuletzt geholte Liste" }
if (-not $liste -and (Test-Path $listeDatei)) {
    try { $liste = Get-Content $listeDatei -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $liste = $null }
}
$modus = if ($liste -and $liste.modus -eq 'durchsetzen') { 'durchsetzen' } else { 'probe' }

# --- Regeln als XML ----------------------------------------------------------
# IDs aus dem Inhalt abgeleitet statt zufaellig: dieselbe Liste ergibt
# dieselbe XML, und "hat sich etwas geaendert?" ist ein Dateivergleich.
function Id([string]$s) {
    $b = [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    (New-Object System.Guid (, [byte[]]$b)).ToString()
}
function X([string]$s) { [System.Security.SecurityElement]::Escape($s) }
# Die ID muss in der ganzen Richtlinie eindeutig sein, auch ueber die
# Sammlungen hinweg - darum gehoeren Sammlung und Name mit hinein.
function Pfad([string]$sid, [string]$pfad, [string]$name, [string]$typ = 'Exe') {
    $id = Id "pfad|$typ|$sid|$pfad|$name"
    "<FilePathRule Id=""$id"" Name=""$(X $name)"" Description="""" UserOrGroupSid=""$sid"" Action=""Allow""><Conditions><FilePathCondition Path=""$(X $pfad)"" /></Conditions></FilePathRule>"
}
function Signatur([string]$sid, [string]$herausgeber, [string]$produkt, [string]$name, [string]$ab = '*', [string]$tun = 'Allow') {
    $id = Id "sig|$tun|$ab|$sid|$herausgeber|$produkt|$name"
    "<FilePublisherRule Id=""$id"" Name=""$(X $name)"" Description="""" UserOrGroupSid=""$sid"" Action=""$tun""><Conditions><FilePublisherCondition PublisherName=""$(X $herausgeber)"" ProductName=""$(X $produkt)"" BinaryName=""*""><BinaryVersionRange LowSection=""$ab"" HighSection=""*"" /></FilePublisherCondition></Conditions></FilePublisherRule>"
}

$defender = '%OSDRIVE%\PROGRAMDATA\MICROSOFT\WINDOWS DEFENDER\PLATFORM\*'

# Zusatzfreigaben aus der Richtlinie (Git). rosenweg-look.ps1 legt die Datei
# neben dieses Skript.
$extra = @()
$txt = Join-Path $Prog 'programme-freigaben.txt'
if (Test-Path $txt) {
    $extra = @(Get-Content $txt | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

# Gemeinsam: Windows, Defender, Technik, Admins, Git-Freigaben
$exeFest = @(
    (Pfad $jeder '%WINDIR%\*' 'Windows'),
    (Pfad $jeder $defender 'Defender-Plattform'),
    (Pfad $frei '*' 'Windows-Programme-frei: alles'),
    (Pfad $admins '*' 'Administratoren (mit Admin-Token): alles')
) + @($extra | ForEach-Object { Pfad $jeder $_ "Freigabe: $_" })

$skript = @(
    (Pfad $jeder '%WINDIR%\*' 'Windows' 'Script'),
    (Pfad $jeder '%PROGRAMFILES%\*' 'Programme' 'Script'),
    (Pfad $jeder '\\ad.rosenweg4303.ch\SysVol\*' 'Gruppenrichtlinien (SYSVOL)' 'Script'),
    (Pfad $jeder '\\ad.rosenweg4303.ch\NETLOGON\*' 'Anmeldeskripte (NETLOGON)' 'Script'),
    (Pfad $frei '*' 'Windows-Programme-frei: alles' 'Script'),
    (Pfad $admins '*' 'Administratoren: alles' 'Script')
)
$msi = @(
    (Pfad $jeder '%WINDIR%\Installer\*' 'Windows Installer' 'Msi'),
    (Pfad $frei '*.*' 'Windows-Programme-frei: alles' 'Msi'),
    (Pfad $admins '*.*' 'Administratoren: alles' 'Msi')
)

# Grundschutz: wie seit dem 22.11.2026, plus Defender-Plattform. Die
# Freigabe fuer OneDrive im Benutzerprofil (AppData) ist seit 26.11. weg:
# OneDrive ist abgeschaltet (rosenweg-look.ps1). Das OneDrive unter
# Programme bleibt bis zum Durchsetzen erlaubt - es startet ohnehin nicht mehr.
$gsExe = $exeFest + @(
    (Pfad $jeder '%PROGRAMFILES%\*' 'Programme')
)
$gsAppx = @(Signatur $jeder '*' '*' 'Signierte Store-Apps' '0.0.0.0')

# Positivliste. Listen statt Arrays: RegelAusListe fuellt sie, und eine
# Liste ist ein Verweis - ein '$script:plExe +=' traefe je nach Aufruf
# (Datei, Skriptblock) einen anderen Gueltigkeitsbereich.
$plExe = New-Object System.Collections.Generic.List[string]
$exeFest + @($dienste | ForEach-Object { Pfad $_ '%PROGRAMFILES%\*' 'Dienste unter Programme' }) | ForEach-Object { $plExe.Add($_) }
$plAppx = New-Object System.Collections.Generic.List[string]
$plAppx.Add((Signatur $frei '*' '*' 'Windows-Programme-frei: alle Store-Apps' '0.0.0.0'))
$plAppx.Add((Signatur $admins '*' '*' 'Administratoren: alle Store-Apps' '0.0.0.0'))
$musterPfad = '^%PROGRAMFILES%\\[^*<>"|?]+(\\\*)?$'
function RegelAusListe($r, [string]$name) {
    switch ($r.art) {
        'pfad' {
            $p = [string]$r.pfad
            if ($p -match $musterPfad -and $p -notmatch '\\\.\.(\\|$)') { $plExe.Add((Pfad $jeder $p $name)) }
            else { Log "Regel verworfen (nicht unter Programme): $p" }
        }
        'herausgeber' {
            if ($r.herausgeber -and $r.herausgeber -ne '*' -and $r.produkt -and $r.produkt -ne '*') {
                $plExe.Add((Signatur $jeder $r.herausgeber $r.produkt $name))
            } else { Log "Regel verworfen (Signatur ohne Herausgeber/Produkt): $name" }
        }
        'paket' {
            $h = [string]$r.herausgeber; $n = [string]$r.paket
            if ($n -notmatch '^[A-Za-z0-9*][A-Za-z0-9.*-]*$') { Log "Regel verworfen (Paketname): $n"; return }
            if ($h -eq '*') {
                # Freigabe von Hand: Herausgeber am installierten Paket ablesen
                $pk = Get-AppxPackage -AllUsers -Name $n -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $pk) { return }   # nicht installiert - nichts zu erlauben
                $h = (Get-AppLockerFileInformation -Packages $pk).Publisher.PublisherName
                if (-not $h) { Log "Herausgeber von $n nicht lesbar"; return }
            }
            $plAppx.Add((Signatur $jeder $h $n.ToUpper() $name '0.0.0.0'))
        }
    }
}
if ($liste) {
    foreach ($p in @($liste.programme)) { foreach ($r in @($p.regeln)) { RegelAusListe $r $p.name } }
    foreach ($r in @($liste.freigaben)) { RegelAusListe $r 'Freigabe (Verwaltung)' }
    # Gesperrt (Edge, OneDrive): Verbote an der Signatur, fuer Jeder - ein
    # Verbot schlaegt bei AppLocker jede Erlaubnis, auch die fuer Technik.
    foreach ($p in @($liste.sperren)) {
        foreach ($r in @($p.regeln)) {
            if ($r.art -eq 'herausgeber' -and $r.herausgeber -and $r.herausgeber -ne '*' -and $r.produkt -and $r.produkt -ne '*') {
                $plExe.Add((Signatur $jeder $r.herausgeber $r.produkt "Gesperrt: $($p.name)" '*' 'Deny'))
            } else { Log "Sperre verworfen: $($p.name)" }
        }
    }
}

function Richtlinie($exe, $appx) {
    '<AppLockerPolicy Version="1">' +
    "<RuleCollection Type=""Exe"" EnforcementMode=""Enabled"">$(($exe | Select-Object -Unique) -join '')</RuleCollection>" +
    "<RuleCollection Type=""Msi"" EnforcementMode=""Enabled"">$($msi -join '')</RuleCollection>" +
    "<RuleCollection Type=""Script"" EnforcementMode=""Enabled"">$($skript -join '')</RuleCollection>" +
    "<RuleCollection Type=""Appx"" EnforcementMode=""Enabled"">$(($appx | Select-Object -Unique) -join '')</RuleCollection>" +
    '</AppLockerPolicy>'
}
$plXml = Richtlinie $plExe $plAppx
# Als Datei: Test-AppLockerPolicy nimmt Store-Apps (-Packages) nur zusammen
# mit -XmlPolicy, nicht mit einem Richtlinien-Objekt. Beim blossen Pruefen
# eine Temp-Datei, die am Ende wieder weg ist.
$plDatei = if ($NurPruefen) { [System.IO.Path]::GetTempFileName() } else { Join-Path $Ablage 'positivliste.xml' }
Set-Content -Path $plDatei -Value $plXml -Encoding UTF8
# Fuer die Auswertung im Speicher - prueft nebenbei, dass AppLocker die XML liest.
try {
    # Der Typ kommt mit dem Modul, die Assembly aber erst beim ersten Aufruf.
    $typ = (Get-AppLockerPolicy -Local -ErrorAction Stop).GetType()
    $plObjekt = $typ::FromXml($plXml)
} catch {
    Log "Positivliste unlesbar: $($_.Exception.Message)"
    return
}

# --- Setzen ------------------------------------------------------------------
# Ohne Liste von der Verwaltung kein Durchsetzen: dann haette die
# Positivliste nur Windows und Technik - das waere eine Sperre, keine Liste.
$soll = if ($modus -eq 'durchsetzen' -and $liste) { Richtlinie $plExe $plAppx } else { Richtlinie $gsExe $gsAppx }
$aktivDatei = Join-Path $Ablage 'aktiv.xml'
$alt = if (Test-Path $aktivDatei) { Get-Content $aktivDatei -Raw -Encoding UTF8 } else { '' }
if ($NurPruefen) {
    Log "Modus $modus, Liste $(if ($liste) { "Stand $($liste.stand)" } else { 'keine' }) - nur pruefen, nichts gesetzt"
} elseif ($alt.Trim() -ne $soll.Trim()) {
    Set-Content -Path $aktivDatei -Value $soll -Encoding UTF8
    try {
        Set-AppLockerPolicy -XmlPolicy $aktivDatei -ErrorAction Stop
        Log "AppLocker gesetzt: $(if ($modus -eq 'durchsetzen' -and $liste) { 'Positivliste DURCHGESETZT' } else { 'Grundschutz (Positivliste in Ueberwachung)' }), $($extra.Count) Freigaben aus der Richtlinie"
    } catch {
        Remove-Item $aktivDatei -Force -ErrorAction SilentlyContinue
        Log "AppLocker FEHLER: $($_.Exception.Message)"
    }
}
if (-not $NurPruefen) {
    # Ohne den Dienst AppIDSvc setzt Windows keine Regel durch.
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\AppIDSvc' -Name Start -Value 2 -ErrorAction SilentlyContinue
    Start-Service AppIDSvc -ErrorAction SilentlyContinue
    # Die Protokolle sind ab Werk 1 MB gross - auf win11-1 reichte das fuer
    # zwei Tage. Die Auswertung liest alle 30 min nach; 8 MB lassen Luft,
    # falls der Rechner ein paar Tage aus war.
    foreach ($n in 'Microsoft-Windows-AppLocker/EXE and DLL', 'Microsoft-Windows-AppLocker/Packaged app-Execution') {
        $l = Get-WinEvent -ListLog $n -ErrorAction SilentlyContinue
        if ($l -and $l.MaximumSizeInBytes -lt 8MB) { & wevtutil.exe sl $n /ms:8388608 | Out-Null }
    }
}

# --- Auswertung --------------------------------------------------------------
# probe:       erlaubt gelaufen (8002 / 8020), aber laut Positivliste nicht erlaubt
# durchsetzen: blockiert (8004 / 8022)
$probeDatei = Join-Path $Ablage 'probe.json'
$probe = $null
if ((Test-Path $probeDatei) -and -not $NurPruefen) { try { $probe = Get-Content $probeDatei -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
$stand = if ($liste) { [string]$liste.stand } else { '' }
$eintraege = @{}
$marken = @{ exe = 0; appx = 0 }
if ($probe) {
    foreach ($e in @($probe.eintraege)) { if ($e) { $eintraege["$($e.art)|$($e.ziel)|$($e.sid)"] = $e } }
    if ($probe.marken) { $marken.exe = [long]$probe.marken.exe; $marken.appx = [long]$probe.marken.appx }
}
$seit = if ($probe -and $probe.seit) { $probe.seit } else { Get-Date -Format s }

$personen = @{}
function Person([string]$sid) {
    if (-not $personen.ContainsKey($sid)) {
        try { $personen[$sid] = (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value }
        catch { $personen[$sid] = $sid }
    }
    $personen[$sid]
}
$pakete = @{}
function Paket([string]$name) {
    if (-not $pakete.ContainsKey($name)) { $pakete[$name] = Get-AppxPackage -AllUsers -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
    $pakete[$name]
}
# $true = Positivliste erlaubt, $false = blockiert, $null = nicht pruefbar
function Erlaubt([string]$art, [string]$ziel, [string]$sid) {
    if ($AlsPerson) { $sid = $AlsPerson }
    try {
        if ($art -eq 'appx') {
            $pk = Paket $ziel
            if (-not $pk) { return $null }
            $t = Test-AppLockerPolicy -XmlPolicy $plDatei -Packages $pk -User $sid -ErrorAction Stop
        } else {
            if (-not (Test-Path -LiteralPath $ziel)) { return $null }
            $t = Test-AppLockerPolicy -PolicyObject $plObjekt -Path $ziel -User $sid -ErrorAction Stop
        }
        return ($t.PolicyDecision -like 'Allowed*')
    } catch { return $null }
}

if (-not $liste -and $modus -eq 'probe') {
    Log "Keine Liste - Auswertung ausgelassen"
} else {
    $ids = if ($modus -eq 'durchsetzen') { @{ exe = 8004; appx = 8022 } } else { @{ exe = 8002; appx = 8020 } }
    $logs = @{ exe = 'Microsoft-Windows-AppLocker/EXE and DLL'; appx = 'Microsoft-Windows-AppLocker/Packaged app-Execution' }
    $geprueft = @{}
    foreach ($art in 'exe', 'appx') {
        # Wurde das Protokoll geleert, faengt die Zaehlung von vorn an.
        $neueste = Get-WinEvent -LogName $logs[$art] -MaxEvents 1 -ErrorAction SilentlyContinue
        if (-not $neueste) { continue }
        if ($neueste.RecordId -lt $marken[$art]) { $marken[$art] = 0 }
        $xpath = "*[System[(EventID=$($ids[$art])) and (EventRecordID > $($marken[$art]))]]"
        $ev = @(Get-WinEvent -LogName $logs[$art] -FilterXPath $xpath -ErrorAction SilentlyContinue)
        foreach ($e in $ev) {
            if ($e.RecordId -gt $marken[$art]) { $marken[$art] = $e.RecordId }
            $d = ([xml]$e.ToXml()).Event.UserData.RuleAndFileData
            $sid = [string]$d.TargetUser
            if ($sid -eq 'S-1-5-18') { continue }   # SYSTEM: prueft AppLocker nicht
            if ($art -eq 'exe') {
                $ziel = [string]$d.FullFilePath
                # Windows ist in beiden Regelwerken erlaubt - die grosse Masse.
                if ($modus -eq 'probe' -and [string]$d.FilePath -match '^%(WINDIR|SYSTEM32)%\\') { continue }
            } else {
                $ziel = [string]$d.Package
            }
            # Fqbn: Herausgeber\Produkt\Datei\Version
            $fq = [string]$d.Fqbn -split '\\'
            $h = $fq[0]; $produkt = if ($fq.Count -gt 1) { $fq[1] } else { '' }
            if (-not $ziel) { continue }
            $schluessel = "$art|$ziel|$sid"
            if ($modus -eq 'probe' -and -not $eintraege.ContainsKey($schluessel)) {
                if (-not $geprueft.ContainsKey($schluessel)) { $geprueft[$schluessel] = Erlaubt $art $ziel $sid }
                if ($geprueft[$schluessel] -ne $false) { continue }
            }
            $wann = $e.TimeCreated.ToString('s')
            if ($eintraege.ContainsKey($schluessel)) {
                $alt = $eintraege[$schluessel]
                $alt.anzahl = [int]$alt.anzahl + 1
                if ($wann -gt $alt.zuletzt) { $alt.zuletzt = $wann }
            } else {
                $eintraege[$schluessel] = [pscustomobject]@{
                    art = $art; ziel = $ziel; herausgeber = $h; produkt = $produkt; sid = $sid; person = (Person $sid)
                    anzahl = 1; zuletzt = $wann
                }
            }
        }
    }

    # Liste geaendert? Dann gespeicherte Eintraege neu pruefen: was jetzt
    # erlaubt ist, faellt heraus - sonst stuende ein eben freigegebenes
    # Programm noch 30 Tage als "waere blockiert" da.
    if ($probe -and $probe.stand -ne $stand) {
        foreach ($k in @($eintraege.Keys)) {
            $e = $eintraege[$k]
            if ((Erlaubt $e.art $e.ziel $e.sid) -eq $true) { $eintraege.Remove($k) }
        }
    }
    # Aelteres als 30 Tage faellt heraus
    $grenze = (Get-Date).AddDays(-$TageAufheben).ToString('s')
    foreach ($k in @($eintraege.Keys)) { if ($eintraege[$k].zuletzt -lt $grenze) { $eintraege.Remove($k) } }

    $liste_ = @($eintraege.Values | Sort-Object { $_.zuletzt } -Descending)
    $neu = [ordered]@{ modus = $modus; stand = $stand; seit = $seit; marken = $marken; eintraege = $liste_ }
    if (-not $NurPruefen) { $neu | ConvertTo-Json -Depth 5 | Set-Content -Path $probeDatei -Encoding UTF8 }

    if ($NurPruefen) {
        Log "$($liste_.Count) Programme $(if ($modus -eq 'durchsetzen') { 'blockiert' } else { 'waeren blockiert' }):"
        $liste_ | Format-Table art, ziel, person, anzahl, zuletzt -AutoSize | Out-String -Width 250 | Write-Output
    } else {
        $melden = [ordered]@{
            format = 1; modus = $modus; stand = $stand; seit = $seit
            eintraege = @($liste_ | Select-Object -First 300 art, ziel, herausgeber, produkt, person, anzahl, zuletzt)
        }
        try {
            $koerper = [System.Text.Encoding]::UTF8.GetBytes(($melden | ConvertTo-Json -Depth 5))
            Invoke-RestMethod -UseBasicParsing -TimeoutSec 8 -Method Post -Uri "$Api/probe" `
                -ContentType 'application/json; charset=utf-8' -Body $koerper | Out-Null
        } catch { Log "Auswertung nicht gemeldet ($($_.Exception.Message))" }
    }
}
if ($NurPruefen) { Remove-Item $plDatei -Force -ErrorAction SilentlyContinue }
