# ============================================================================
# bginfo.ps1 - Rechner-Infos auf den Hintergrund, wie BGInfo
# ============================================================================
# Laeuft bei jeder Anmeldung im Namen der Person (geplante Aufgabe "Rosenweg
# BGInfo", eingerichtet von rosenweg-look.ps1) aus C:\Program Files\Rosenweg -
# dort darf die Programm-Whitelist es starten, und niemand ausser Admins kann
# es veraendern.
#
# Es nimmt das Stations-Hintergrundbild und schreibt oben rechts in eine
# halbtransparente Box: Rechner, Adressen, angemeldete Person, Windows-Stand,
# letztes Update. Das Ergebnis liegt pro Person in %LOCALAPPDATA%\Rosenweg.
#
# Darum NICHT mehr ueber PersonalizationCSP: das erzwingt eine einzige Datei
# fuer alle, und der Name der Person ist beim Start noch nicht bekannt. Den
# Hintergrund aendern kann die Person trotzdem nicht (NoChangingWallPaper,
# von rosenweg-look.ps1 in jedes Profil geschrieben).
#
# Pro RECHNER eine Datei (bginfo-<RECHNER>.png) und bei jeder Anmeldung frisch
# erzeugt. Beim ABMELDEN (-Abmelden, Abmeldeskript der Richtlinie) wird der
# Hintergrund auf das neutrale Stationsbild zurueckgesetzt: Windows legt eine
# Kopie des Hintergrunds im servergespeicherten Teil des Profils ab
# (%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper, CachedFiles) und
# zeigt sie bei der naechsten Anmeldung sofort an - auch auf einem anderen
# Rechner. So stand auf WIN11-1 nach der Anmeldung zuerst "R9-PC1, Windows 10"
# (26.11.2026), bis diese Aufgabe lief.
# ============================================================================
param([switch]$Abmelden)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -Namespace Rosenweg -Name Tapete -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d);'

$basis = Join-Path $env:ProgramData 'Rosenweg\hintergrund.png'
$ziel  = Join-Path $env:LOCALAPPDATA 'Rosenweg'
New-Item -ItemType Directory -Force -Path $ziel | Out-Null
$datei = Join-Path $ziel "bginfo-$env:COMPUTERNAME.png"
# Aeltere Fassung ohne Rechnernamen
Remove-Item (Join-Path $ziel 'bginfo.png') -Force -ErrorAction SilentlyContinue

if ($Abmelden) {
    # Neutral: nur das Stationsbild, ohne Rechner und Person. Erst setzen (das
    # schreibt TranscodedWallpaper neu), dann die zwischengespeicherten Bilder
    # in Grossformaten loeschen - Windows baut sie bei Bedarf neu.
    if (Test-Path $basis) {
        Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value '10'
        Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value '0'
        [Rosenweg.Tapete]::SystemParametersInfo(20, 0, $basis, 3) | Out-Null
    }
    Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Themes\CachedFiles') -Recurse -Force -ErrorAction SilentlyContinue
    return
}

# --- Angaben ----------------------------------------------------------------
$rechner = $env:COMPUTERNAME
$adressen = Get-NetIPAddress -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^(fe80|169\.254|127\.|::1)' -and $_.AddressState -eq 'Preferred' } |
    Sort-Object AddressFamily, IPAddress | Select-Object -ExpandProperty IPAddress
# Temporaere IPv6-Datenschutzadressen weglassen - sie wechseln laufend und
# helfen bei einer Fernwartung nicht.
$adressen = $adressen | Where-Object { $_ -notin (Get-NetIPAddress -SuffixOrigin Random -ErrorAction SilentlyContinue).IPAddress }

$anzeige = $null
try { $anzeige = ([adsisearcher]"(sAMAccountName=$env:USERNAME)").FindOne().Properties['displayname'][0] } catch {}
$person = if ($anzeige) { "$anzeige ($env:USERDOMAIN\$env:USERNAME)" } else { "$env:USERDOMAIN\$env:USERNAME" }

$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$os = "$((Get-CimInstance Win32_OperatingSystem).Caption -replace '^Microsoft ', '') $($cv.DisplayVersion) (Build $($cv.CurrentBuild).$($cv.UBR))"
$update = (Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn | Select-Object -Last 1).InstalledOn
$updateText = if ($update) { $update.ToString('dd.MM.yyyy') } else { 'unbekannt' }

$zeilen = @(
    @('Rechner', $rechner),
    @('Adresse', ($adressen -join "`n")),
    @('Angemeldet', $person),
    @('Windows', $os),
    @('Letztes Update', $updateText)
)

# --- Zeichnen ---------------------------------------------------------------
$schirm = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$arbeit = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [Math]::Max($schirm.Width, 800); $h = [Math]::Max($schirm.Height, 600)

$bild = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bild)
$g.SmoothingMode = 'HighQuality'; $g.InterpolationMode = 'HighQualityBicubic'
$g.TextRenderingHint = 'ClearTypeGridFit'
if (Test-Path $basis) {
    $hg = [System.Drawing.Image]::FromFile($basis)
    # Wie "Ausfuellen": skalieren, bis der Schirm bedeckt ist, mittig zuschneiden
    $f = [Math]::Max($w / $hg.Width, $h / $hg.Height)
    $bw = [int]($hg.Width * $f); $bh = [int]($hg.Height * $f)
    $g.DrawImage($hg, [int](($w - $bw) / 2), [int](($h - $bh) / 2), $bw, $bh)
    $hg.Dispose()
} else { $g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42)) }

$skala = [Math]::Max(1.0, $h / 1080.0)
$fLabel = New-Object System.Drawing.Font 'Segoe UI', ([float](10 * $skala)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
$fWert  = New-Object System.Drawing.Font 'Segoe UI Semibold', ([float](10 * $skala)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
$grau = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 255, 255, 255))
$weiss = [System.Drawing.Brushes]::White

$labelBreite = 0; $wertBreite = 0; $hoehe = 0
foreach ($z in $zeilen) {
    $lb = $g.MeasureString($z[0], $fLabel); $wb = $g.MeasureString($z[1], $fWert)
    $labelBreite = [Math]::Max($labelBreite, $lb.Width); $wertBreite = [Math]::Max($wertBreite, $wb.Width)
    $hoehe += [Math]::Max($lb.Height, $wb.Height) + 2 * $skala
}
$rand = 14 * $skala; $abstand = 12 * $skala
$boxB = $labelBreite + $abstand + $wertBreite + 2 * $rand
$boxH = $hoehe + 2 * $rand
# Oben rechts (Stefan, 26.11.2026: wie auf den Linux-Stationen), innerhalb
# der Arbeitsflaeche (WorkingArea) - eine oben angedockte Taskleiste wird
# also ausgespart -, mit etwas Luft
$x = $arbeit.Right * ($w / $schirm.Width) - $boxB - 24 * $skala
$y = $arbeit.Top * ($h / $schirm.Height) + 24 * $skala

$pfad = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 10 * $skala
$pfad.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90); $pfad.AddArc($x + $boxB - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
$pfad.AddArc($x + $boxB - 2 * $r, $y + $boxH - 2 * $r, 2 * $r, 2 * $r, 0, 90); $pfad.AddArc($x, $y + $boxH - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$pfad.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 10, 15, 30))), $pfad)

$cy = $y + $rand
foreach ($z in $zeilen) {
    $g.DrawString($z[0], $fLabel, $grau, $x + $rand, $cy)
    $g.DrawString($z[1], $fWert, $weiss, $x + $rand + $labelBreite + $abstand, $cy)
    $cy += [Math]::Max($g.MeasureString($z[0], $fLabel).Height, $g.MeasureString($z[1], $fWert).Height) + 2 * $skala
}
$g.Dispose()
$bild.Save($datei, [System.Drawing.Imaging.ImageFormat]::Png)
$bild.Dispose()

# --- Setzen -----------------------------------------------------------------
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value '10'
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value '0'
[Rosenweg.Tapete]::SystemParametersInfo(20, 0, $datei, 3) | Out-Null
