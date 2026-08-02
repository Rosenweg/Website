# Scripts

Dieses Verzeichnis enthält Automatisierungsskripte für das Website-Repository.

Aktuell sind keine aktiven Scripts vorhanden. Email-Routing wird über Cloudflare "Forward to" Regeln + IMAP-Polling im API-Server abgewickelt.

## sync-avatars-to-ad.py

Schreibt die Benutzerbilder aus Authentik ins AD-Attribut `thumbnailPhoto`.
Läuft per Cron auf dem **Domänencontroller (CT 108)**, nicht in der API.

```bash
# Ausrollen
scp scripts/sync-avatars-to-ad.py root@100.64.2.21:/tmp/
ssh root@100.64.2.21 'pct push 108 /tmp/sync-avatars-to-ad.py /usr/local/sbin/sync-avatars-to-ad.py'
ssh root@100.64.2.21 'pct exec 108 -- chmod 0755 /usr/local/sbin/sync-avatars-to-ad.py'

# Probelauf, ohne etwas zu schreiben
ssh root@100.64.2.21 'pct exec 108 -- sh -c "set -a; . /etc/default/sync-avatars-to-ad; set +a; /usr/local/sbin/sync-avatars-to-ad.py --trocken"'
```

Die Zugangsdaten stehen auf dem DC in `/etc/default/sync-avatars-to-ad`
(`AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN`, Modus 0600) — **nicht** hier im Repo.
Der Cron-Eintrag liest sie mit `set -a` ein; ohne das setzt `.` nur
Shell-Variablen und Python sieht nichts.

Das Skript lag bis zum 3. August 2026 in keinem Repo. Es zeigte fest verdrahtet
auf eine Adresse aus dem abgebauten Docker Swarm und stürzte seit dessen Abbau
alle zehn Minuten ab; davor hatte es allen Konten dasselbe Rosenweg-Wappen
zugewiesen. Beides steht im Kopfkommentar der Datei.
