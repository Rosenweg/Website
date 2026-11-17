# SSH-Zugang aus dem Profil

Stand: 17.11.2026. Sicherheitsregeln im Überblick: [`sicherheit.md`](sicherheit.md) Abschnitt 4.9.

Wer im Rosenweg-Profil einen öffentlichen Schlüssel hinterlegt, bekommt auf
den Hosts, die die Zugriffsmatrix für ihn vorsieht, automatisch ein Konto —
mit passwortlosem `sudo`, wo die Matrix es sagt. Fällt jemand aus der Matrix,
verschwindet das Konto wieder. Die Hostliste pflegt sich selbst.

## Warum so und nicht anders

**Schlüssel werden nicht verteilt, sondern gefragt.** `sshd` ruft bei jeder
Anmeldung `AuthorizedKeysCommand` auf, das Skript fragt die API. Es gibt
keine `authorized_keys`, die auf zwanzig Hosts auseinanderlaufen kann, und
ein im Profil gelöschter Schlüssel ist beim nächsten Anmeldeversuch weg.

**Konten und `sudo` können das nicht.** `sshd` weist eine Anmeldung für einen
unbekannten Benutzer ab, bevor es überhaupt nach Schlüsseln fragt, und `sudo`
liest eine Datei statt zu fragen. Beides hängt deshalb an einem Timer, der
alle fünf Minuten die Liste der Berechtigten für genau diesen Host holt und
das System in Deckung bringt. Wer neu freigegeben wird, wartet also bis zu
fünf Minuten auf sein Konto; ein Entzug greift ebenso schnell.

**Zwei Schlüsselquellen, die sich ergänzen.** Von Hand hinterlegte Schlüssel
und die eines GitHub-Kontos (`https://github.com/<name>.keys`). Die wirksame
Liste ist die Vereinigung beider. GitHub wird stündlich abgeholt und bei uns
zwischengespeichert, **nie im Anmeldepfad live abgefragt** — sonst hinge
github.com zwischen einer Person und ihrer Shell.

**Der Zwischenspeicher unterscheidet zwei Fälle.** Antwortet die API mit
einer leeren Liste, ist das eine Aussage: Diese Person darf hier nicht mehr,
und der Zwischenspeicher wird gelöscht. Antwortet sie gar nicht, gilt der
letzte bekannte Stand — aber höchstens sieben Tage. Sonst hielte ein Host,
der die API seit Wochen nicht erreicht, Zugänge offen, die längst entzogen
sind.

## Konten entstehen und vergehen

`rw-konten-sync` legt an, sperrt und löscht. Vier Regeln begrenzen den
Schaden, den ein Fehler anrichten kann:

**Wir fassen nur an, was wir selbst angelegt haben.** Jedes erzeugte Konto
kommt in die Gruppe `rw-verwaltet`. Ein von Hand angelegtes Konto gleichen
Namens bleibt unberührt, auch wenn es in der Matrix steht. Systemkonten
(UID unter 1000) und `root` sind ohnehin tabu. Auch `rw-authorized-keys`
liefert Schlüssel nur für Mitglieder von `rw-verwaltet` — sonst bekäme ein
lokales Betriebskonto (`claude`, `ansible`, `pi` …) die Portal-Schlüssel
einer gleichnamigen Person. Soll ein von Hand angelegtes Konto trotzdem
Schlüssel aus dem Portal bekommen, steht es ausdrücklich in
`/etc/rosenweg-ssh.conf`: `SCHLUESSEL_AUCH_FUER="login1 login2"` (Einzelheiten
unten im Abschnitt „Wer überhaupt Schlüssel bekommt“).

**Ein Konto braucht einen Schlüssel.** Wer keinen hinterlegt hat, bekommt
keines — ein Konto ohne Schlüssel wäre eine Tür ohne Klinke.

**Entzug wirkt sofort, die Löschung folgt.** Wer aus der Matrix fällt, wird
beim nächsten Lauf gesperrt: keine Anmeldung, kein `sudo`. Nach der
Schonfrist von 30 Tagen wird das Konto samt Heimatverzeichnis entfernt.
**Das ist endgültig** — `userdel --remove` nimmt die Daten mit, und von hier
aus gibt es kein Backup. Die Schonfrist ist die einzige Sicherung dagegen,
dass ein Fehler in der Matrix jemandem seine Dateien kostet. Wer sofort
aufräumen will, setzt `KONTEN_SCHONFRIST_TAGE=0`; wer gar nicht löschen
will, `KONTEN_LOESCHEN=nein` — dann bleibt es beim Sperren.

**Erreicht der Host die API nicht, geschieht gar nichts.** Ein Netzausfall
darf keine Konten sperren und schon gar keine löschen.

Kommt jemand später zurück in die Matrix, wird ein noch vorhandenes,
gesperrtes Konto wieder entsperrt statt neu angelegt — samt allem, was darin
liegt.

## Die Zugriffsmatrix

Regeln stehen in `ssh_zugriff`. Jede Regel nennt ein Subjekt (eine Gruppe
oder eine einzelne Person), einen Geltungsbereich (ein Host oder alle) und
was sie gewährt (`ssh`, `sudo`).

Die **spezifischere Regel gewinnt**: Benutzer schlägt Gruppe, ein einzelner
Host schlägt die Regel für alle. So lässt sich ein Host ausnehmen oder eine
Person zusätzlich berechtigen, ohne die Grundregel anzufassen. `ssh = false`
ist ein ausdrücklicher Entzug, kein blosses Fehlen.

Beim ersten Start werden zwei Grundregeln gesetzt: `technik` und
`praesident` kommen überall hin, mit `sudo`. Wer sie später ändert oder
löscht, dem schreibt der nächste Start sie nicht wieder hin.

Der Unix-Login ist `users.username` — also etwa `stefan.mueller`. Wer keinen
Benutzernamen am Konto hat, lässt sich keinem Systemkonto zuordnen und
bekommt nirgends eines.

## Die Hostliste

Es gibt keine gepflegte Liste. Jeder Host, der Schlüssel oder Konten abholt,
trägt sich dabei mit seinem Namen ein; jeder weitere Abruf hält
`zuletzt_gesehen` aktuell. Ein Host, der seit Monaten nicht mehr gefragt
hat, fällt dadurch von selbst auf. Stilllegen lässt sich einer über
`aktiv = false` — dann bekommt dort niemand mehr Schlüssel oder Konten.

## Wer überhaupt Schlüssel bekommt (Stand 17.11.2026)

Die Kurzfassung der Regeln steht in [`sicherheit.md`](sicherheit.md)
Abschnitt 4.9; hier die Einzelheiten.

**Auf der API-Seite** (`api/routes/ssh-zugang.js`):

- Ein Login muss dem Muster `^[a-z_][a-z0-9._-]{0,31}$` entsprechen. Sonst
  antwortet `/api/ssh/authorized-keys/<login>` mit **400** und leerem Text.
- Systemkonten bekommen **nie** Schlüssel und nie ein Konto, auch wenn ein
  Portal-Konto so heisst: `root`, `daemon`, `www-data`, `postgres`, `docker`,
  `admin`, `administrator`, `operator` und weitere, dazu die lokalen
  Betriebskonten `claude`, `ansible`, `github`, `ubuntu`, `debian`, `pi` sowie
  alles, was mit `systemd-` oder `_` beginnt. Weitere Namen ohne Codeänderung über
  die Umgebungsvariable `SSH_GESPERRTE_LOGINS` (kommagetrennt) in
  `/opt/rosenweg-core/.env`, danach API neu starten.
- Wer in der Matrix `sudo` hat, bekommt über `authorized-keys` nur seine
  **eigenen** Schlüssel, nie einen Sitzungsschlüssel (siehe unten).
- Falsche Host-Tokens: nach 20 Fehlversuchen in 10 Minuten je Absender nur noch
  **429**. Ein richtiger Token geht immer durch.

**Auf dem Host** (`rw-authorized-keys`):

- Schlüssel werden nur für Konten ausgegeben, die in der Gruppe **`rw-verwaltet`**
  stehen (also von `rw-konten-sync` angelegt wurden), oder für Logins, die in
  `/etc/rosenweg-ssh.conf` ausdrücklich freigegeben sind:

  ```sh
  SCHLUESSEL_AUCH_FUER="stefan.mueller andere.person"   # leerzeichengetrennt
  ```

  Für alle anderen Logins gibt das Skript nichts aus und löscht einen etwa
  vorhandenen Zwischenspeicher. Grund: Sonst bekäme ein lokales Betriebskonto
  (`claude`, `ansible`, `pi` …) die Portal-Schlüssel einer gleichnamigen Person.
- Der Host-Token geht über **stdin** an curl (`curl -K -`, Konfigzeilen
  `header = "X-Host-Token: …"`) und steht nie in der Prozessliste. `-K -` statt
  `-H @-`, weil curl vor Version 7.55 `-H @-` nicht kennt. Nur wenn kein curl,
  aber wget vorhanden ist, steht der Token kurz in der Prozessliste – dann curl
  nachinstallieren.
- Antwortet die API mit **400 oder 404** (Login ungültig, gesperrt, unbekannt),
  ist das eine endgültige Absage: Der Zwischenspeicher wird sofort gelöscht.
  Nur bei Netzfehler, 5xx oder 401/403 (Token-Problem des Hosts) gilt der letzte
  bekannte Stand, höchstens 7 Tage (`CACHE_MAX_TAGE`).

**sudo** schreibt `rw-konten-sync` nur noch für Konten, die in `rw-verwaltet`
stehen **und** eine UID ab 1000 haben. Steht ein anderes Konto mit `sudo` in der
gelieferten Liste, erscheint im Journal
`sudo fuer <login> nicht gesetzt — kein von uns verwaltetes Benutzerkonto`, und
die Zeile fehlt in `/etc/sudoers.d/90-rosenweg`.

### AD-Hosts: Ausnahme mit `SCHLUESSEL_AUCH_FUER`

Auf den Hosts, die Mitglied der Windows-Domäne sind, kommen die Benutzerkonten
aus dem AD (winbind), nicht aus `rw-konten-sync` – sie stehen also nicht in
`rw-verwaltet`. Damit diese Konten weiter Portal-Schlüssel bekommen, steht ihr
Login dort in `SCHLUESSEL_AUCH_FUER`. Betroffen sind die Container
**102 (ntp3), 106 (fileserver), 108 (dc1), 111 (cups-server), 136 (dc2) und
206 (fileserver2)**.

Auf diesen sechs Hosts läuft bewusst **noch die alte `rw-konten-sync`** (ohne
die neue sudo-Prüfung), damit AD-Konten ihr passwortloses sudo behalten. Wer die
neue Fassung dort ausrollen will, muss vorher klären, wie die sudo-Rechte der
AD-Konten künftig vergeben werden (offener Punkt in `sicherheit.md`
Abschnitt 7.2).

**Vor jedem Ausrollen auf einen Host** prüfen, welche Logins dort tatsächlich
benutzt werden und ob sie in `rw-verwaltet` stehen:

```sh
getent group rw-verwaltet
grep -E '^(SCHLUESSEL_AUCH_FUER|KONTEN_)' /etc/rosenweg-ssh.conf
last -n 30 | awk '{print $1}' | sort -u     # wer hat sich zuletzt angemeldet
```

Fehlt ein benutzter Login, entweder in `SCHLUESSEL_AUCH_FUER` aufnehmen oder
in Kauf nehmen, dass er nach dem Ausrollen keine Portal-Schlüssel mehr bekommt
(Zugang dann nur noch über `/root/.ssh/authorized_keys` bzw. eine eigene
`~/.ssh/authorized_keys`).

## Einrichten

### API-Seite

Die API (CT 128) braucht die Umgebungsvariable `SSH_HOST_TOKEN` in
`/opt/rosenweg-core/.env`. Ohne sie antwortet jede Host-Schnittstelle mit
**503** (`SSH_HOST_TOKEN nicht gesetzt`), und nichts davon ist aktiv. Optional
`SSH_GESPERRTE_LOGINS`. Nach einer Änderung:

```sh
pct exec 128 -- sh -c 'cd /opt/rosenweg-core && docker compose up -d api'
```

Der Token ist für alle Hosts derselbe. Er gilt nach dem Vorfall vom 17.11.2026
als zu rotieren (`sicherheit.md` Abschnitt 7.1, Punkt 11). Beim Rotieren muss
der neue Wert auf **jeden** aufgenommenen Host in `/etc/rosenweg-ssh.conf` –
am einfachsten durch einen erneuten Lauf von `rw-ssh-aufnehmen.sh` mit
`--auch-cts` auf jedem Knoten.

### Einen Proxmox-Knoten mit allen Containern aufnehmen

Auf dem Knoten als root. Den Token **nicht** als Argument übergeben, sondern aus
einer Datei, die nur root lesen kann, oder verdeckt eintippen:

```sh
install -m 0600 /dev/null /root/rw-token
# Token aus dem Passwortmanager als einzige Zeile in /root/rw-token eintragen (Editor)

./rw-ssh-aufnehmen.sh --api https://www.rosenweg4303.ch --token-datei /root/rw-token --auch-cts --probelauf
./rw-ssh-aufnehmen.sh --api https://www.rosenweg4303.ch --token-datei /root/rw-token --auch-cts
rm -f /root/rw-token
```

| Option | Wirkung |
|---|---|
| `--api <url>` | Basisadresse der API (Pflicht) |
| `--token-datei <pfad>` | Token aus der ersten Zeile dieser Datei |
| (keine Token-Option) | fragt `Host-Token:` verdeckt ab, wenn ein Terminal da ist |
| `--token <wert>` | geht noch, mit `WARNUNG: --token steht in der Prozessliste` – nicht verwenden |
| `--auch-cts` | richtet zusätzlich jeden laufenden Container auf diesem Knoten ein (per `pct`) |
| `--probelauf` | zeigt nur, was geschehen würde (`[Probelauf] …`), ändert nichts |

Fehlermeldungen und was zu tun ist:

| Meldung | Bedeutung / Abhilfe |
|---|---|
| `Fehlt: --api und Token (--token-datei oder Abfrage)` | API-Adresse oder Token fehlt. Ohne Terminal (z. B. per `ssh … 'bash -s'`) gibt es keine Abfrage – dann `--token-datei` verwenden. |
| `Token-Datei nicht lesbar: …` | Pfad oder Rechte prüfen. |
| `Token enthaelt unerlaubte Zeichen` | Der Token darf nur `A–Z a–z 0–9 . _ ~ + / = -` enthalten (er landet unquotiert in der Konfiguration). Einen anderen Token erzeugen. |
| `ACHTUNG: <host> erreicht die API nicht (…)` | Netz oder Token prüfen. Der Host ist eingerichtet, holt aber noch nichts. |
| `ACHTUNG in CT <id>: sshd -t meldet einen Fehler — nicht neu geladen.` | sshd-Konfiguration im Container von Hand prüfen; der laufende sshd bleibt unverändert. |

Das Skript ist wiederholbar: Ein zweiter Lauf ändert nichts, was schon stimmt.
In einer vorhandenen `/etc/rosenweg-ssh.conf` ersetzt es **nur** `API_BASE`,
`HOST_TOKEN` und `HOST_NAME`; von Hand gesetzte Werte wie
`SCHLUESSEL_AUCH_FUER`, `KONTEN_LOESCHEN`, `KONTEN_SCHONFRIST_TAGE`,
`KONTEN_TABU` bleiben erhalten (bis zum 17.11.2026 wurden sie überschrieben).

### Das Bündel neu bauen

`scripts/rw-ssh-aufnehmen.sh` ist **erzeugt** und enthält Kopien von
`rw-authorized-keys.sh`, `rw-konten-sync.sh`, `rw-konten-sync.service` und
`rw-konten-sync.timer`. Nach jeder Änderung an einer dieser Dateien im
Repo-Wurzelverzeichnis:

```sh
python3 scripts/rw-ssh-aufnehmen-bauen.py
```

und danach den Unterschied von `scripts/rw-ssh-aufnehmen.sh` ansehen (nur die
erwarteten Änderungen und das neue Datum in der Kopfzeile). Nie
`rw-ssh-aufnehmen.sh` von Hand ändern – der nächste Bau überschreibt es.
Stand 17.11.2026: Bündel und Quellen stimmen überein.

### Von Hand, auf einem einzelnen Host als root

```sh
# 1. Konfiguration — enthält den Token, gehört niemandem sonst
install -m 0640 /dev/null /etc/rosenweg-ssh.conf
cat >> /etc/rosenweg-ssh.conf <<'EOF'
API_BASE=https://www.rosenweg4303.ch
HOST_TOKEN=<Wert von SSH_HOST_TOKEN, aus dem Passwortmanager>
HOST_NAME=ct240-mailcow
# nur auf AD-Hosts oder für von Hand angelegte Konten:
# SCHLUESSEL_AUCH_FUER="stefan.mueller"
EOF

# 2. Eigener Benutzer für die Schlüsselabfrage. Nicht "nobody" — der
#    dürfte sonst überall mitlesen, und der Token liegt in der Datei.
useradd --system --no-create-home --shell /usr/sbin/nologin rw-keys
chown root:rw-keys /etc/rosenweg-ssh.conf
install -d -o rw-keys -g rw-keys -m 0750 /var/cache/rosenweg-ssh
install -d -m 0750 /var/lib/rosenweg-ssh/gesperrt

# 3. Skripte (curl sollte installiert sein, siehe oben)
install -m 0755 rw-authorized-keys.sh /usr/local/bin/rw-authorized-keys
install -m 0755 rw-konten-sync.sh     /usr/local/bin/rw-konten-sync

# 4. sshd
cat >> /etc/ssh/sshd_config.d/50-rosenweg.conf <<'EOF'
AuthorizedKeysCommand /usr/local/bin/rw-authorized-keys %u
AuthorizedKeysCommandUser rw-keys
EOF
sshd -t && systemctl reload ssh

# 5. Konten- und sudo-Abgleich (alle 5 Minuten)
install -m 0644 rw-konten-sync.service rw-konten-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rw-konten-sync.timer
```

**Vor dem Reload eine zweite Sitzung offen lassen.** `sshd -t` prüft die
Syntax, nicht ob die Kette funktioniert. Erst wenn eine neue Anmeldung über
den Schlüssel aus dem Profil klappt, ist es gut.

Einstellungen in `/etc/rosenweg-ssh.conf`:

| Variable | Standard | Wirkung |
|---|---|---|
| `API_BASE` | – (Pflicht) | Basisadresse der API |
| `HOST_TOKEN` | – (Pflicht) | Wert von `SSH_HOST_TOKEN` |
| `HOST_NAME` | `hostname -s` | Name, unter dem sich der Host meldet |
| `SCHLUESSEL_AUCH_FUER` | leer | Logins ausserhalb von `rw-verwaltet`, die trotzdem Schlüssel bekommen |
| `KONTEN_LOESCHEN` | `ja` | `nein` = gesperrte Konten nie löschen |
| `KONTEN_SCHONFRIST_TAGE` | `30` | Tage zwischen Sperre und Löschung, `0` = beim nächsten Lauf |
| `KONTEN_TABU` | `root` | Logins, die nie angefasst werden (Komma oder Leerzeichen) |
| `KONTEN_SHELL` | `/bin/bash` | Shell neuer Konten |
| `CACHE_MAX_TAGE` | `7` | Höchstalter des Schlüssel-Zwischenspeichers bei API-Ausfall |
| `TIMEOUT` | `3` | Sekunden, die `rw-authorized-keys` auf die API wartet |

## Sitzungsgebundener Zugang (Stationen)

Auf Stationen (geteilten Geräten) entsteht der Zugang mit der Anmeldung und
vergeht mit der Abmeldung. Die Station meldet sich über
`POST /api/ssh/sitzung` (Host-Token) mit `{ login, pubkey }` an und über
`DELETE /api/ssh/sitzung` wieder ab. Regeln seit dem 17.11.2026:

- Nur ein Host, der schon als Station bekannt ist (in `ssh_hosts` als
  `sitzungsgebunden` markiert oder in `stations` mit Status `aktiv` und nicht
  widerrufen), darf Sitzungen melden. Andere bekommen **403**
  `Host ist keine registrierte Station`.
- Systemkonten (Liste oben) → **400** `Ungültiger Anmeldename`.
- Konten, die irgendwo `sudo` haben (Technik, Präsident oder eine Matrix-Regel
  mit `sudo`), bekommen **keinen Sitzungsschlüssel**: Die Sitzung gilt, aber die
  Antwort enthält `schluessel: null` und den Hinweis, den eigenen Schlüssel zu
  verwenden. Grund: Der Sitzungsschlüssel hängt nur am gemeinsamen Host-Token
  und liegt auf einem geteilten Gerät.
- Eine Sitzung, die sich 16 Stunden nicht gemeldet hat, gilt als beendet.
- Stationen, die von Nicht-Technik registriert werden, sind zuerst gesperrt und
  bekommen ihre Geheimnisse erst nach Freigabe durch Technik
  (`sicherheit.md` Abschnitt 4.9).

Wer gerade wo angemeldet ist: `GET /api/ssh/sitzungen` (Technik).

## Was der Notweg ist

`/root/.ssh/authorized_keys` wird von `sshd` zusätzlich gelesen und von
diesem Aufbau nie angetastet. Ebenso vergibt `/etc/sudoers.d/90-rosenweg`
nur Rechte und nimmt keine weg, die lokal in `/etc/sudoers` stehen, und
`root` steht auf der Tabu-Liste des Konten-Abgleichs. Fällt die API dauerhaft
aus, bleibt der Weg über root offen — er ist der Grund, warum man diesen
Aufbau überhaupt wagen kann.

Ein lokales Konto mit Passwort-`sudo` als Rückfalltür ist trotzdem
empfehlenswert. Die Webseite ist mit diesem Aufbau die Wurzel der
Rechtevergabe im ganzen Cluster: Wer dort schreiben kann, kann sich Root
geben und fremde Konten löschen. Deshalb schreiben Schlüssel nur
SSO-angemeldete Personen für sich selbst, die Matrix nur Technik und
Präsident, und beide Tabellen hängen am Audit-Trigger.

## Prüfen, ob es tut

```sh
# Was bekäme dieser Login auf diesem Host? (leer = nichts)
sudo -u rw-keys /usr/local/bin/rw-authorized-keys stefan.mueller

# Wer soll hier ein Konto haben? Token über stdin, nicht als Argument:
. /etc/rosenweg-ssh.conf
printf 'header = "X-Host-Token: %s"\nheader = "X-Host-Name: %s"\n' "$HOST_TOKEN" "$(hostname -s)" \
  | curl -fsS -K - "$API_BASE/api/ssh/konten"

# Abgleich von Hand anstossen und Ergebnis ansehen
systemctl start rw-konten-sync.service
journalctl -u rw-konten-sync.service -n 20 --no-pager
getent group rw-verwaltet
cat /etc/sudoers.d/90-rosenweg
ls /var/lib/rosenweg-ssh/gesperrt

# Neue Fassung installiert? (beide Ausgaben nicht leer)
grep -c 'curl -sS --max-time' /usr/local/bin/rw-authorized-keys
grep -c 'kein von uns verwaltetes Benutzerkonto' /usr/local/bin/rw-konten-sync
```

Erwartete Journalzeilen von `rw-konten-sync`:

| Zeile | Bedeutung |
|---|---|
| `rw-konten-sync: fertig — N angelegt, N gesperrt, N geloescht` | Lauf erfolgreich |
| `rw-konten-sync: API nicht erreichbar — es wird nichts geaendert` | Netz/API weg; nichts gesperrt oder gelöscht |
| `rw-konten-sync: API_BASE/HOST_TOKEN fehlen` | Konfiguration unvollständig |
| `rw-konten-sync: Antwort der API unlesbar` | API liefert kein JSON (z. B. 503 ohne `SSH_HOST_TOKEN`) |
| `rw-konten-sync: erzeugte sudoers-Datei ist fehlerhaft — … bleibt unveraendert` | `visudo -c` schlug fehl; alte Datei gilt weiter |
| `rw-konten-sync: ACHTUNG — sudo laut Matrix vorgesehen, liess sich aber nicht installieren` | Paket `sudo` fehlt und konnte nicht nachinstalliert werden |

## Zurückbauen

- **Einen Host ganz herausnehmen:** In `/etc/ssh/sshd_config.d/50-rosenweg.conf`
  (bzw. am Ende von `/etc/ssh/sshd_config`) die beiden Zeilen
  `AuthorizedKeysCommand…` entfernen, `sshd -t && systemctl reload ssh`, dann
  `systemctl disable --now rw-konten-sync.timer`. Angelegte Konten bleiben
  bestehen; `/etc/sudoers.d/90-rosenweg` von Hand löschen, wenn deren sudo weg
  soll. Im Portal den Host über `PATCH /api/ssh/hosts/:id` (Technik) auf
  `aktiv = false` setzen.
- **Auf die Fassung vor dem 17.11.2026 zurück:** Die ersetzten Dateien liegen
  als `/usr/local/bin/rw-authorized-keys.vor-sicherheit-2026-11-17` und
  `/usr/local/bin/rw-konten-sync.vor-sicherheit-2026-11-17` daneben
  (`sicherheit.md` Abschnitt 8.3). Zurückkopieren genügt; sshd liest das Skript
  bei jeder Anmeldung neu. Achtung: Die alte Fassung gibt Schlüssel wieder an
  jedes gleichnamige lokale Konto aus und zeigt den Token in der Prozessliste.
- **Ein einzelnes Konto sofort sperren:** In der Matrix `ssh = false` für die
  Person setzen; der nächste Lauf (≤ 5 Minuten) sperrt, und
  `rw-authorized-keys` liefert ab sofort nichts mehr.

## Endpunkte

| Endpunkt | Wer | Wozu |
|---|---|---|
| `GET /api/ssh/me` | angemeldet | eigene Schlüssel, erreichbare Hosts |
| `POST /api/ssh/me/schluessel` | angemeldet | Schlüssel von Hand hinterlegen |
| `DELETE /api/ssh/me/schluessel/:id` | angemeldet | eigenen Schlüssel entfernen |
| `PUT /api/ssh/me/github` | angemeldet | GitHub-Konto setzen oder lösen |
| `POST /api/ssh/me/github/abgleich` | angemeldet | GitHub sofort nachziehen |
| `GET /api/ssh/authorized-keys/:login` | Host-Token | von `sshd` aufgerufen |
| `GET /api/ssh/konten` | Host-Token | Konten und `sudo` für diesen Host |
| `POST /api/ssh/sitzung` | Host-Token, nur bekannte Station | Anmeldung an einer Station, optional Sitzungsschlüssel |
| `DELETE /api/ssh/sitzung` | Host-Token | Abmeldung, Sitzungsschlüssel wird gelöscht |
| `GET /api/ssh/sitzungen` | Technik | aktive Sitzungen |
| `POST /api/ssh/dienste` | Host-Token | Bericht der Dienstwacht (`rw-dienstwacht`) |
| `GET /api/ssh/dienste` | Technik | aktuelle Befunde der Dienstwacht |
| `GET /api/ssh/hosts` | Technik | selbst gemeldete Hosts |
| `PATCH /api/ssh/hosts/:id` | Technik | stilllegen, Notiz |
| `GET /api/ssh/matrix` | Technik | Regeln und ihre Wirkung |
| `POST /api/ssh/matrix` | Technik | Regel anlegen oder ändern |
| `DELETE /api/ssh/matrix/:id` | Technik | Regel entfernen |
