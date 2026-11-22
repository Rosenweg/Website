# Gruppenrichtlinie «Rosenweg-Look Windows»

Windows-Rechner der Domäne sehen damit aus wie die Stationen:

- dasselbe Hintergrund- und Sperrbild
- Akzentfarbe Mint-Blau `#0C75DE`
- Taskleiste links
- Rosenweg als Hersteller mit Logo
- das Logo als Standard-Kontobild
- die Drucker DruckerR9 und DruckerR13 über den CUPS-Server (IPP, ohne Herstellertreiber, A4)

Gilt für alle Rechner in `OU=Windows`. Seit dem 22.11.2026 liegt dort `WIN11-1` (VM 107 auf pve3, Windows 11 Enterprise).

| Datei | Zweck |
|---|---|
| `einrichten.sh` | auf dc1 als root: OU, Rechner verschieben, Richtlinie anlegen und verlinken, Inhalt ins sysvol, Version hochzählen |
| `rosenweg-look.ps1` | Startskript, läuft beim Start als SYSTEM und setzt alles; Protokoll in `C:\ProgramData\Rosenweg\look.log` |
| `bilder/` | `hintergrund.png` und `sperrbild.png` aus os-stationen, `logo.png` von der Website |

## Ändern

Bilder oder Skript anpassen, dann auf dc1 im Ordner `./einrichten.sh` ausführen. Das Skript zählt die Version hoch, sodass die Rechner beim nächsten Start den neuen Stand holen. dc2 bekommt die Dateien über `sysvol-abgleich`.

## Warum so

- **Richtlinie direkt in der sam.ldb statt über `samba-tool gpo create`:** Das Maschinenkonto des DC darf keine Richtlinien anlegen, und ein Admin-Passwort gehört nicht in ein Skript.
- **`scripts.ini` mit `powershell.exe -ExecutionPolicy Bypass` statt `psscripts.ini`:** Ein Windows-Client steht ab Werk auf `Restricted` und würde das Skript sonst verweigern.
- **Hintergrund und Sperrbild über PersonalizationCSP:** Das geht nur bei Enterprise/Education, und Benutzer können es nicht überschreiben. Auf den Stationen gehören diese Bilder ebenfalls der Station.
- **Taskleiste links:** Das ist eine Benutzereinstellung. Das Skript lädt deshalb beim Start jedes Profil und die Vorlage für neue Profile kurz und setzt sie dort.
