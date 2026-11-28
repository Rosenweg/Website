# Runner-Wächter

Stand: 28.11.2026. `scripts/rw-runner-waechter.sh` (+ `.service`/`.timer`) schaltet
die Linux-Runner der Organisation Rosenweg (Gruppe `rosenweg-privat`, Label
`rosenweg`) nach Bedarf zu und ab, damit die teils stark belasteten Knoten nur so
viele Runner tragen, wie Arbeit da ist.

## Wo und wie

- Läuft auf **pve2** als root, jede Minute (`rw-runner-waechter.timer`),
  Programm `/usr/local/bin/rw-runner-waechter`, Konfiguration
  `/etc/rosenweg-runner-waechter.conf`, Zustand `/var/lib/rw-runner-waechter/state.json`.
- Runner in Kaskaden-Reihenfolge: **1** (pve2, CT 140) – **2** (pve3, CT 145) –
  **3** (pve2, CT 140) – **4** (pve3, CT 145). Geschaltet werden nur die
  systemd-Dienste `actions.runner.Rosenweg.<name>.service`, nie der Container
  (Container-Start kostet Minuten und bringt gegenüber dem leeren Dienst kaum
  Entlastung). CT 145 auf pve3 wird per `ssh root@100.64.2.22 pct exec …` bedient.
- Die Windows-VM `win-runner` (VM 142) wird **nicht** geschaltet.
- GitHub-Zugang: GitHub-App „Rosenweg Automatik“ (App ID 5960072), Schlüssel
  `/etc/rosenweg-github-app.pem` (0600). Nötig: Organisation → *Self-hosted
  runners: Read*, Repository → *Actions: Read*.

## Regeln

| Regel | Wert |
|---|---|
| Runner 1 | immer an |
| Zuschalten | Runner N+1 nur, wenn alle Vorgänger laufen **und busy** sind, mindestens ein Job mit Label `rosenweg` wartet und die Last des Zielknotens < `LAST_MAX` (12) ist; höchstens einer pro Lauf |
| Abschalten | nur der höchste laufende Runner > 1, nicht busy, `IDLE_MIN` (15) Minuten ohne Job, nichts wartet; höchstens einer pro Lauf |
| Nie abbrechen | busy wird unmittelbar vor dem Stoppen erneut abgefragt |
| Protokoll | Journal (`journalctl -u rw-runner-waechter`), jeder Schaltvorgang eine Zeile |
| Fehler | Exit 1 → Unit `failed` → fällt der Dienstwacht auf (WhatsApp-Gruppe Technik) |

Schwellen in der Konfiguration: `IDLE_MIN`, `LAST_MAX`, `LABEL`, `TROCKEN=1`.

## Einrichten

```bash
scp scripts/rw-runner-waechter.{sh,service,timer} root@100.64.2.21:/tmp/
ssh root@100.64.2.21 'install -m755 /tmp/rw-runner-waechter.sh /usr/local/bin/rw-runner-waechter
  install -m644 /tmp/rw-runner-waechter.service /tmp/rw-runner-waechter.timer /etc/systemd/system/
  printf "TROCKEN=1\nIDLE_MIN=15\nLAST_MAX=12\n" > /etc/rosenweg-runner-waechter.conf
  rw-runner-waechter --trocken            # Trockenlauf: nur Ausgabe
  systemctl daemon-reload'
# scharf: TROCKEN=1 aus der Konfiguration entfernen, dann
ssh root@100.64.2.21 'systemctl enable --now rw-runner-waechter.timer'
```

Voraussetzung: pve2 erreicht pve3 per SSH ohne Passwort.

## NOC-Kachel „Runner · GitHub Actions“

Der Wächter schickt pro Lauf dreimal (alle ~20 s, `MESSUNGEN`/`MESS_S`) einen
Bericht per `POST /api/isp/noc/runner` (Kopf `X-Runner-Token`, nur von pve2). Die
API (`routes/nocrunner.js`, `lib/nocrunner.js`) hält den letzten Bericht im
Speicher; das Cockpit (`js/noc-cockpit.js`, `noc-fullscreen.html` und
`isp-admin.html`) holt ihn alle 20 s über `/api/isp/noc/public/runner`.

Je Runner (runner-1 bis -4, win-runner): online/offline, Job/frei/aus, aktueller
Job mit Repo, Workflow, Job, Branch/PR und Link, Fortschritt in Prozent (aus der
Median-Dauer der letzten fünf erfolgreichen Läufe desselben Jobs; ohne Verlauf
Schritte fertig/gesamt), Rest und aktueller Schritt, Auslastung (Dienst-cgroup
im CT: CPU und RAM des Runner-Dienstes; CT: Last und RAM; win-runner: `qm
status 142 --verbose`). Fusszeile: Zustand des Wächters, letzter Schaltvorgang,
CT-Last, Warteschlange mit Wartezeit. Nur Namen und Status, keine Log-Inhalte.
Ohne Token (NOC_PUBLIC_OPEN) fehlen Repo-/Branchnamen und Links.

Warnungen (Kachel rot): ein Runner, der laufen soll, ist offline; win-runner
offline; Wächter meldet sich 5 Minuten nicht oder meldet einen Fehler.

GitHub-API-Last: Lauflisten je Repo und Jobs je Lauf mit ETag (ein 304 zählt
nicht gegen das Limit, 6500/h je Installation); in den Folgemessungen eines
Laufs nur die Jobs laufender Läufe. Die Zahl der Aufrufe steht im Journal.

Einrichtung: `BERICHT_BASE` und `BERICHT_TOKEN` in
`/etc/rosenweg-runner-waechter.conf` (pve2); dasselbe Token als
`RUNNER_WAECHTER_TOKEN` in der Umgebung der API (CT 128), optional
`RUNNER_WAECHTER_IPS` (Standard `100.64.2.21`).
## Runner-Wahl in den Workflows (alle Org-Repos)

Der wiederverwendbare Workflow `Rosenweg/rosenweg-basis/.github/workflows/runner-wahl.yml`
entscheidet in einem Sekunden-Job auf `ubuntu-latest`, ob die folgenden Linux- und
Windows-Jobs auf unseren Runnern oder auf GitHub laufen. Ausgaben `linux` und
`windows` (JSON für `fromJSON`).

| Fall | Linux | Windows |
|---|---|---|
| Fork-PR (Head-Repo ≠ Repo), egal ob öffentlich oder privat | `ubuntu-latest` | `windows-latest` |
| privates Repo | `[self-hosted, Linux, rosenweg]` | `[self-hosted, Windows, rosenweg-windows]` |
| öffentliches Repo | eigene, wenn ein Runner online und nicht busy ist **oder** ein Runner aus ist (der Wächter kann ihn zuschalten); sonst `ubuntu-latest` | eigene, wenn win-runner online und nicht busy; sonst `windows-latest` |
| kein Zugang zur Runner-Liste (kein Secret, API-Fehler) | `ubuntu-latest` | `windows-latest` |

macOS und iOS bleiben immer bei GitHub (`macos-latest`).

Die Runner-Liste liest der Job mit der GitHub-App (`PAKETE_APP_ID`/`PAKETE_APP_KEY`,
Org-Secrets für alle Repos; dieselbe App wie „Rosenweg Automatik“, Berechtigung
Organisation → Self-hosted runners: Read). Aufrufer reichen die beiden Secrets
ausdrücklich weiter (`secrets:`), auch bei Pull Requests; Fork-PRs und Dependabot
bekommen sie nie, brauchen sie aber auch nicht.

Einbau in einem Workflow: Job `wahl` mit `uses:` auf den Workflow, bei jedem Job
`needs: wahl` und `runs-on: ${{ fromJSON(needs.wahl.outputs.linux) }}` (bzw.
`.windows`). Ausdrücklich `self-hosted` festgelegte Jobs (Deploy, Stationen) bleiben,
wie sie sind. Die Flutter-Apps nutzen die Wahl über `rosenweg-basis/app.yml`; ihr
Aufrufer reicht dazu `PAKETE_APP_ID`/`PAKETE_APP_KEY` immer weiter. Die Kotlin-Apps
rufen `Website/android-release.yml` mit `secrets: inherit`.

Grenzen: Ist der Wächter durch die Lastgrenze gebremst, kann ein Job auf
„zuschaltbar“ warten, obwohl GitHub frei wäre. Alle Jobs eines Laufs entscheiden
nur einmal; viele gleichzeitige Läufe sehen alle denselben freien Runner und
stauen sich dann auf den eigenen, bis der Wächter zugeschaltet hat.
