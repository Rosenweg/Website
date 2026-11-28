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
