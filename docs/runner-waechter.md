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

## Release-Warteschlange (Flutter-Apps)

Ziel: Nie mehr 14 Releases gleichzeitig. Ein Merge auf `main` startet in einer Flutter-App
**kein** Release mehr, der Wächter führt die Reihe.

- **app.yml** (`rosenweg-basis`): Mit der Org-Variable `RELEASE_WARTESCHLANGE=true` meldet der Job
  `version` bei einem Push nur „Release fällig“ (Hinweis im Lauf, es bauen weiter Linux/Android als
  Prüfung). Ohne die Variable bleibt alles wie bisher.
- **Aufrufer** (`.github/workflows/app.yml` jeder App): `workflow_dispatch` hat die Eingabe
  `veroeffentlichen`; mit ihr (nur am Zweig `main`) gehen Version, Release-Schlüssel und
  `veroeffentlichen` durch. Umbau je Repo mit `scripts/rw-aufrufer-warteschlange.py`, gestaffelt mit
  `rw-massen-pr.sh`.
- **Wächter** (`RELEASE_QUEUE=1` in `/etc/rosenweg-runner-waechter.conf`): Alle `RELEASE_PRUEF_S`
  (300) Sekunden vergleicht er je App-Repo die Version in `pubspec.yaml` auf `main` mit den Tags. Fehlt
  `v<version>`, ist das Release fällig; sortiert wird nach der Zeit des Commits, der die Version
  gesetzt hat (Merge-Zeit). Er startet es per `workflow_dispatch` (`veroeffentlichen=true`, Zweig `main`)
  und wartet, bis der Lauf zu Ende ist. **1** Release gleichzeitig, **2** wenn weniger als 2 macOS-Jobs
  laufen und nicht alle eigenen Runner belegt sind (`RELEASE_PARALLEL_MAX`).
- **Fehler:** Fehlt nach dem Lauf der Tag, startet er das Release **einmal** neu; scheitert auch das,
  wird es übersprungen (steht im NOC rot, Warnung) und die Reihe geht weiter.
- **Berechtigung:** Der Start braucht für die GitHub-App „Rosenweg Automatik“ die Repository-
  Berechtigung **Actions: Read and write** (bisher nur Read). Ohne sie meldet der Wächter „Start nicht
  möglich“ und startet nichts.
- **Kotlin-Apps** (`release.yml`, ausgelöst durch erfolgreiche CI über `workflow_run`): bisher nicht in
  der Reihe. Sie lösen nach jedem Merge mit neuer `VERSION_NAME` ein einzelnes, kurzes Release auf
  einem Runner aus (kein macOS, kein Windows) und stauen deshalb kaum. Soll es später auch dort
  eine Reihe geben, müsste `release.yml` statt `workflow_run` ein `workflow_dispatch` bekommen und
  der Wächter die Tags `v<VERSION_NAME>` gegen `gradle.properties` vergleichen.
- **NOC:** Zeile „Release-Warteschlange“ in der Kachel Runner: läuft / wartend / letzte / übersprungen.
- **Einschalten** erst, wenn alle Aufrufer umgestellt sind: Reihenfolge (1) Basis-PR mergen, (2) Aufrufer
  per `rw-massen-pr.sh` umstellen und mergen, (3) `RELEASE_QUEUE=1` auf pve2, (4) Org-Variable
  `RELEASE_WARTESCHLANGE=true` setzen. Aus: Variable löschen, dann starten Pushes wieder selbst.

## Massenänderungen gestaffelt

`scripts/rw-massen-pr.sh` legt CI-Änderungen in vielen Repos gestaffelt an. Regel: **höchstens 3
Repos gleichzeitig in der Prüfung** und Neues nur, wenn **weniger als 5 Jobs warten** und **keine
Release-Läufe laufen oder anstehen**; sonst wartet das Skript (60 s). Die Lage liest es aus dem NOC
(`NOC_URL`, `NOC_TOKEN`), sonst zählt es selbst.

```bash
scripts/rw-massen-pr.sh neu --zweig ci/x --titel "..." --skript ./aendern.sh repo1 repo2 ...
scripts/rw-massen-pr.sh anstossen --zweig ci/runner-wahl --mergen repo1 repo2 ...   # --trocken zeigt nur
```

`anstossen` startet fehlgeschlagene oder abgebrochene Läufe bestehender PRs neu und führt grüne
PRs mit `--mergen` zusammen; rote bleiben offen und werden gemeldet. Die Regel für Agenten steht in
`docs/entwickeln.md`.

## Stau-Alarm

Warten **mehr als 10 Jobs länger als 20 Minuten** (Label `rosenweg`), wird die NOC-Kachel rot und die
API (`routes/nocrunner.js`) meldet an die Technik-WhatsApp-Gruppe (Ersatz: Mail an technik@), wie
beim Android-Dauertest. **Höchstens eine Meldung pro Stunde**; ist der Stau abgebaut, folgt einmal
eine Entwarnung. Der Wächter zählt die langen Jobs (`STAU_S`, 1200) und liefert sie im Bericht mit;
im Trockenlauf wird nichts gemeldet.
