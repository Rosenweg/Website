# Scripts

Stand: 17.11.2026. Betriebsskripte, die **ausserhalb** der API auf Knoten oder
in Containern laufen. Jedes Skript beschreibt im Kopfkommentar, wo es läuft und
warum es so gebaut ist; hier die Übersicht mit Ausroll- und Prüfbefehlen.
Sicherheitsregeln im Überblick: [`../docs/sicherheit.md`](../docs/sicherheit.md).

Knoten: pve1 `100.64.2.20`, pve2 `100.64.2.21`, pve3 `100.64.2.22`. `pct` geht nur
auf dem Knoten, der den Container gerade hat (`ha-manager status`).

## Übersicht

| Skript | Läuft auf | Zweck | Im Detail |
|---|---|---|---|
| `rw-authorized-keys.sh` | jedem aufgenommenen Host, als `/usr/local/bin/rw-authorized-keys` | `AuthorizedKeysCommand` für sshd: Schlüssel aus dem Profil | [`docs/ssh-zugang.md`](../docs/ssh-zugang.md) |
| `rw-konten-sync.sh` + `.service`/`.timer` | dito, `/usr/local/bin/rw-konten-sync`, alle 5 Min | Unix-Konten und sudo aus der Zugriffsmatrix | dito |
| `rw-ssh-aufnehmen.sh` | PVE-Knoten | **erzeugt** – Knoten und Container in einem Lauf aufnehmen | dito |
| `rw-ssh-aufnehmen-bauen.py` | Arbeitsplatz | baut `rw-ssh-aufnehmen.sh` aus den vier Dateien oben neu | dito |
| `rw-dienstwacht.sh` + `.service`/`.timer` | PVE-Knoten, alle 15 Min | meldet fehlgeschlagene/hängende Units in Knoten und Containern an `/api/ssh/dienste` | Kopfkommentar, `docs/website.md` („Wenn die Dienstwacht viel meldet“) |
| `rw-platz-machen.sh` | in einem Container | Platz schaffen ohne Datenverlust (apt-Cache, Journal deckeln, Logs komprimieren, logrotate-Regeln) | Kopfkommentar |
| `rw-web-ausrollen.sh` | Arbeitsplatz | einzelne Web-Dateien auf alle passenden `fe-*`-Container | [`docs/website.md`](../docs/website.md#deployment) |
| `doc-github-backup.sh` | CT 106 `fileserver`, `/usr/local/bin/`, Cron `/etc/cron.d/rosenweg-documents` | Dokumentenablage ↔ Repo `Rosenweg/documents` | unten |
| `desktop-schreibschutz-loesen.sh` | CT 106 | entfernt das Windows-READONLY-Bit von angepassten Ordnern | Kopfkommentar |
| `docker-images-aufraeumen.sh` + `docker-aufraeumen.service`/`.timer` | CT 128 `core-backend`, sonntags 04:15 | namenlose API-Images löschen | Kopfkommentar |
| `konten-druckerr-umbenennen.py` | PVE-Knoten (root), einmalig; `ssh root@100.64.2.21 'python3 -' < scripts/konten-druckerr-umbenennen.py` | Konten `druckerr9vorname.nachname` auf `vorname.nachname` (AD, Authentik, Portal-DB, Ordner); Standard Probelauf, `--ausfuehren` nur für Plan AUTO, pausiert ad-sync währenddessen | Kopfkommentar |
| `authentik-apps-sso.py` | PVE-Knoten (root), einmalig; `ssh root@100.64.2.20 'python3 -' < scripts/authentik-apps-sso.py` | Authentik für die stille Kerberos-Anmeldung der Rosenweg-Apps (`rosenweg-apps` implizite Zustimmung, optional `--hausnetz`); Standard Probelauf, `--ausfuehren`, `--zurueck` | Kopfkommentar, rosenweg-basis `docs/authentik.md` |
| `sync-avatars-to-ad.py` | CT 108 `dc1`, Cron | Profilbilder aus Authentik ins AD (`thumbnailPhoto`) | unten |
| `whatsapp-bot-session-backup.sh` | CT 116, Cron 03:00 | Sicherung der WhatsApp-Sitzung | Kopfkommentar |
| `whatsapp-bot-session-restore.sh` | CT 116 | Sitzung aus einer Sicherung zurückspielen | Kopfkommentar |
| `wa-session-empfangen` | CT 106, erzwungener SSH-Befehl | nimmt die Sitzungssicherung von CT 116 entgegen (nur stdin, 14 Tage Aufbewahrung, Ablage `/var/backups/wa-session` 0700/0600 — bewusst nicht auf der Samba-Freigabe) | Kopfkommentar |
| `gen-unterschriftenlisten.py` | Arbeitsplatz | Unterschriftenlisten (DOCX) je STWEG aus einem DB-Export | Kopfkommentar |
| `shelly-surplus-switch.js` | Shelly Gen2 (Skript im Gerät) | Überschuss-Steuerung | `shelly-surplus-switch.md` |

## doc-github-backup.sh (CT 106)

`/mnt/cephfs-stage` ist zugleich die Samba-Freigabe `dokumente` und ein
Arbeitsverzeichnis des Repos `Rosenweg/documents`. Stündlich 07–22 Uhr: holen,
aufnehmen, committen, pushen; täglich 03:30 Uhr mit `--full` zusätzlich `git gc`.
Alarme gehen über PMG (Port 26) mit Absender `technik@` an `technik@rosenweg4303.ch`.

**Seit 17.11.2026:** Weil jeder mit Schreibrecht auf der Freigabe auch `.git/`
ändern könnte (Hooks, `core.fsmonitor`, `credential.helper` …), ruft das Skript
git nur noch über eine Funktion auf, die diese Optionen bei jedem Aufruf
überstimmt (`core.hooksPath=/dev/null`, `core.fsmonitor=false`,
`protocol.ext.allow=never`, `protocol.file.allow=never` u. a.). Die Sperrdatei
liegt in `/run/doc-github-backup.lock` statt in `/tmp`. Vollständig schützt nur,
`.git/` in Samba zu sperren (`veto files`) oder das Git-Verzeichnis ausserhalb
der Freigabe zu halten – das ist noch offen.

```bash
scp scripts/doc-github-backup.sh root@100.64.2.21:/tmp/
ssh root@100.64.2.21 'pct push 106 /tmp/doc-github-backup.sh /usr/local/bin/doc-github-backup.sh
  pct exec 106 -- chmod 755 /usr/local/bin/doc-github-backup.sh'
# Prüfen: Probelauf von Hand, dann Log ansehen
ssh root@100.64.2.21 'pct exec 106 -- sh -c "/usr/local/bin/doc-github-backup.sh; tail -n 20 /var/log/doc-github-backup.log"'
```

Zurück: `/usr/local/bin/doc-github-backup.sh.vor-sicherheit-2026-11-17`.

**Ab 28.11.2026 (Fund R3, Vollmachten):** `Vollmachten/` (unterschriebene
Vollmachten der API) geht nie nach GitHub. Das Skript nimmt den Ordner mit
`git add -A -- . ':(exclude)Vollmachten'` nicht auf und nimmt ihn aus dem Index,
falls er dort doch steht (die Dateien bleiben auf der Freigabe). Zusätzlich steht
`Vollmachten/` in der `.gitignore` von `Rosenweg/documents`. Einspielen auf CT 106
erst nach Freigabe durch Stefan.

## sync-avatars-to-ad.py (CT 108)

Schreibt die Benutzerbilder aus Authentik ins AD-Attribut `thumbnailPhoto`.
Läuft per Cron auf dem **Domänencontroller dc1 (CT 108, pve2)**, nicht in der API.
Drei Fälle: hochgeladenes Foto (data:-URL), Gravatar, sonst Initialen.

**Seit 17.11.2026:**

- Fremde Bilder werden nur noch von Hosts aus `AVATAR_HOSTS` geholt (Standard:
  die Gravatar-Hosts), nur über https mit Zertifikatsprüfung, ohne Umleitungen,
  ohne Token, höchstens 5 MB. Jede andere Adresse → Initialen. Grund: Das
  Avatar-Feld setzt jede Person selbst; vorher holte der DC beliebige, auch
  interne Adressen und schickte dabei den Authentik-Token mit.
- Der Authentik-Token geht nur noch an `AUTHENTIK_URL`.
- Benutzernamen werden für den LDAP-Filter maskiert und für Cache-Dateinamen
  geprüft (ungewöhnliche Namen → Hash).

Konfiguration in `/etc/default/sync-avatars-to-ad` (Modus 0600, **nicht** im
Repo): `AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN`, optional `AVATAR_HOSTS`
(kommagetrennt). Der Cron-Eintrag liest sie mit `set -a`; ohne das setzt `.` nur
Shell-Variablen und Python sieht nichts.

```bash
scp scripts/sync-avatars-to-ad.py root@100.64.2.21:/tmp/
ssh root@100.64.2.21 'pct push 108 /tmp/sync-avatars-to-ad.py /usr/local/sbin/sync-avatars-to-ad.py'
ssh root@100.64.2.21 'pct exec 108 -- chmod 0755 /usr/local/sbin/sync-avatars-to-ad.py'

# Probelauf, ohne etwas zu schreiben
ssh root@100.64.2.21 'pct exec 108 -- sh -c "set -a; . /etc/default/sync-avatars-to-ad; set +a; /usr/local/sbin/sync-avatars-to-ad.py --trocken"'
```

Zurück: `/usr/local/sbin/sync-avatars-to-ad.py.vor-sicherheit-2026-11-17`.

Das Skript lag bis zum 3. August 2026 in keinem Repo. Es zeigte fest verdrahtet
auf eine Adresse aus dem abgebauten Docker Swarm und stürzte seit dessen Abbau
alle zehn Minuten ab; davor hatte es allen Konten dasselbe Rosenweg-Wappen
zugewiesen. Beides steht im Kopfkommentar der Datei.

## E-Mail-Weiterleitung

Mails an die Verteiler laufen über Mailcow und den IMAP-Abruf der API, nicht
über Skripte in diesem Ordner (siehe [`docs/email.md`](../docs/email.md)).
