# SSH-Zugang aus dem Profil

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
(UID unter 1000) und `root` sind ohnehin tabu.

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

## Einrichten

Auf der API-Seite genügt die Umgebungsvariable `SSH_HOST_TOKEN`. Ohne sie
antwortet die Host-Schnittstelle mit 503, und nichts davon ist aktiv. Sie
gehört nach der Regel des Stacks in die `.env` auf dem Docker-Host, nicht in
`docker-stack.yml` — dort würde ein `${VAR}` beim Deploy aus der
Aufrufer-Shell expandiert und das Geheimnis mit einem Leerstring
überschreiben.

Auf einem Proxmox-Knoten nimmt ein Aufruf den Knoten und auf Wunsch gleich
alle laufenden Container mit:

```sh
./rw-ssh-aufnehmen.sh --api https://www.rosenweg4303.ch --token GEHEIM --auch-cts
```

`--probelauf` zeigt vorher, was geschehen würde. Das Skript ist
wiederholbar: Ein zweiter Lauf ändert nichts, was schon stimmt. Es enthält
Kopien der Host-Dateien; nach jeder Änderung an `rw-authorized-keys.sh`,
`rw-konten-sync.sh` oder den Units muss
`python3 scripts/rw-ssh-aufnehmen-bauen.py` neu laufen.

Von Hand, auf einem einzelnen Host als root:

```sh
# 1. Konfiguration — enthält das Token, gehört niemandem sonst
cat > /etc/rosenweg-ssh.conf <<'EOF'
API_BASE=https://www.rosenweg4303.ch
HOST_TOKEN=<derselbe Wert wie SSH_HOST_TOKEN>
HOST_NAME=ct240-mailcow
EOF
chmod 0640 /etc/rosenweg-ssh.conf

# 2. Eigener Benutzer für die Schlüsselabfrage. Nicht "nobody" — der
#    dürfte sonst überall mitlesen, und das Token liegt in der Datei.
useradd --system --no-create-home --shell /usr/sbin/nologin rw-keys
chown root:rw-keys /etc/rosenweg-ssh.conf
install -d -o rw-keys -g rw-keys -m 0750 /var/cache/rosenweg-ssh
install -d -m 0750 /var/lib/rosenweg-ssh/gesperrt

# 3. Skripte
install -m 0755 rw-authorized-keys.sh /usr/local/bin/rw-authorized-keys
install -m 0755 rw-konten-sync.sh     /usr/local/bin/rw-konten-sync

# 4. sshd
cat >> /etc/ssh/sshd_config.d/50-rosenweg.conf <<'EOF'
AuthorizedKeysCommand /usr/local/bin/rw-authorized-keys %u
AuthorizedKeysCommandUser rw-keys
EOF
sshd -t && systemctl reload ssh

# 5. Konten- und sudo-Abgleich
install -m 0644 rw-konten-sync.service rw-konten-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rw-konten-sync.timer
```

**Vor dem Reload eine zweite Sitzung offen lassen.** `sshd -t` prüft die
Syntax, nicht ob die Kette funktioniert. Erst wenn eine neue Anmeldung über
den Schlüssel aus dem Profil klappt, ist es gut.

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
# Was bekäme dieser Login auf diesem Host?
sudo -u rw-keys /usr/local/bin/rw-authorized-keys stefan.mueller

# Wer soll hier ein Konto haben?
curl -fsS -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $(hostname -s)" \
  "$API_BASE/api/ssh/konten"

# Abgleich von Hand anstossen und Ergebnis ansehen
systemctl start rw-konten-sync.service
journalctl -u rw-konten-sync.service -n 20 --no-pager
getent group rw-verwaltet
ls /var/lib/rosenweg-ssh/gesperrt
```

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
| `GET /api/ssh/hosts` | Technik | selbst gemeldete Hosts |
| `PATCH /api/ssh/hosts/:id` | Technik | stilllegen, Notiz |
| `GET /api/ssh/matrix` | Technik | Regeln und ihre Wirkung |
| `POST /api/ssh/matrix` | Technik | Regel anlegen oder ändern |
| `DELETE /api/ssh/matrix/:id` | Technik | Regel entfernen |
