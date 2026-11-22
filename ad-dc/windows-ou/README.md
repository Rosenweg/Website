# Windows-Rechner automatisch nach OU=Windows

Ein Windows-Rechner, der der Domäne beitritt, landet in `CN=Computers`. Dort greift keine Gruppenrichtlinie, er bekäme also weder den [Rosenweg-Look](../gpo-rosenweg-look-windows/README.md) noch die Drucker. `windows-ou-einsortieren` prüft alle 10 Minuten `CN=Computers` und verschiebt jeden Rechner mit `operatingSystem: Windows*` nach `OU=Windows`.

- Es wird nur aus `CN=Computers` heraus verschoben. Ein Rechner, den jemand von Hand in eine andere OU gelegt hat, bleibt dort.
- Ausnahmen trägt man in `/etc/windows-ou-ausnahmen` ein, ein Rechnername pro Zeile.
- Jede Verschiebung landet im Journal (`journalctl -t windows-ou`).

| Datei | Ort auf dc1 |
|---|---|
| `windows-ou-einsortieren` | `/usr/local/bin/` |
| `windows-ou-einsortieren.service`, `.timer` | `/etc/systemd/system/`, Timer aktiviert |
