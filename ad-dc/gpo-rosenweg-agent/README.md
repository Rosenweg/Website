# Gruppenrichtlinie „Rosenweg-Agent"

Bringt den [Rosenweg-Agenten](https://github.com/Rosenweg/rosenweg-agent) auf
die Windows-PCs der Domäne. Mit ihm erscheinen sie auf /stationen wie die
Linux-Stationen: Lebenszeichen, angemeldete Personen, Windows-Build,
BitLocker, Updates, Anschluss-Wächter, Sperre — und Befehle (Nachricht,
Abmelden, Neustart, Netzstart für die Sicherung).

Architektur und Begründungen: rosenweg-agent `docs/architektur.md`.
Testplan für win11-1: rosenweg-agent `docs/windows.md`.

| Datei | Wo es läuft | Was |
|---|---|---|
| `kerberos-dienstkonto.sh` | dc1, root, einmal | Konto `stationen-api`, SPN `HTTP/www.rosenweg4303.ch`, nur AES, Keytab |
| `einrichten.sh` | dc1, root, je neue Fassung | GPO anlegen, an OU=Windows hängen, Dateien ins SYSVOL, Version hoch |
| `agent-installieren.ps1` | jeder PC, SYSTEM, beim Start und zweimal täglich | prüfen, installieren, aktualisieren, bei `AUS` entfernen |

## Einrichten

**1. Kerberos in der API** (einmal)

```sh
# dc1
./kerberos-dienstkonto.sh /root/stationen-api.keytab   # auf dc1 (CT 108)
```

Die API läuft auf CT 128 mit docker compose (`/opt/rosenweg-core/compose.yml`).
Die Keytab kommt als Datei dorthin – nie anzeigen, nur weiterleiten – und wird
beim Dienst `api` read-only eingehängt:

```sh
# vom Mac aus, Datei wird nirgends zwischengespeichert:
ssh root@100.64.2.21 'pct pull 108 /root/stationen-api.keytab /root/sa.keytab && cat /root/sa.keytab && rm /root/sa.keytab' \
  | ssh root@100.64.2.20 'umask 077; cat > /root/sa.keytab && pct push 128 /root/sa.keytab /opt/rosenweg-core/secrets/stationen-api.keytab --perms 600 && rm /root/sa.keytab'
ssh root@100.64.2.21 'pct exec 108 -- rm -f /root/stationen-api.keytab'
```

```yaml
  api:
    volumes:
      - /opt/rosenweg-core/secrets/stationen-api.keytab:/run/secrets/stationen-api.keytab:ro
```

Danach `docker compose up -d api`. Eingerichtet am 27.11.2026 (Konto
`stationen-api`, nur AES, KVNO 2).

`STATION_KRB5_KEYTAB` ist mit `/run/secrets/stationen-api.keytab`
vorbelegt; `STATION_KRB5_SPN` (`HTTP/www.rosenweg4303.ch`) und
`STATION_KRB5_REALM` (aus `AD_DOMAIN`) nur bei Abweichung setzen. Ohne Keytab
antwortet `/api/stations/v2/anmelden` mit 503 und sagt warum — sonst ändert
sich nichts.

Prüfen, ohne einen PC anzufassen (dc1 oder eine Station mit Keytab):

```sh
kinit -k 'DC1$'
curl --negotiate -u : -X POST https://www.rosenweg4303.ch/api/stations/v2/anmelden \
     -H 'Content-Type: application/json' -d '{"agent":{"plattform":"windows"}}'
# 404 / 409: Ticket angekommen und gültig (dc1 ist kein Windows-PC auf /stationen)
# 401 "NTLM statt Kerberos": SPN fehlt     401 "abgelehnt: …": Keytab passt nicht
```

**2. Release eintragen**: nach `vX.Y.Z` in rosenweg-agent die Prüfsumme aus
`SHA256SUMS` oben in `einrichten.sh` (`AGENT_SHA256`) ergänzen.

**3. Verteilen**

```sh
# dc1, im Verzeichnis dieses Ordners; netzstart-einmal.ps1 aus os-stationen
# (sicherung/windows/) daneben legen - das Repo ist privat und wird nicht geladen
./einrichten.sh --version 0.1.1 --netzstart netzstart-einmal.ps1
```

Wirkt beim nächsten Start der PCs in OU=Windows. Vorher prüfen, wer dort
liegt (`samba-tool ou listobjects OU=Windows,DC=ad,DC=rosenweg4303,DC=ch`) —
zum Testen zuerst nur win11-1.

## Entfernen

```sh
./einrichten.sh --aus      # beim nächsten Start/Aktualisierungslauf: Sperre aufheben,
                           # Dienst, Aufgabe, Dateien weg (installieren.log bleibt)
./einrichten.sh --an       # wieder installieren
```

Erst wenn alle PCs einmal gelaufen sind, die Richtlinie von OU=Windows
abhängen. Einzeln, von Hand: `"C:\Program Files\Rosenweg\Agent\rosenweg-agent.exe" entfernen`.

## Empfehlung: Computerkonten nur durch Technik

Mit `ms-DS-MachineAccountQuota` (Vorgabe 10) darf jedes Konto der Domäne
Computerkonten anlegen und sich damit als neuer PC bei der API melden — nicht
als ein bestehender (dafür bräuchte es dessen Schlüssel). Auf /stationen fiele
ein solcher PC auf. Sauberer: Quota auf 0, Rechner tritt nur mit dem
Beitrittskonto bei.

```sh
ldbmodify -H /var/lib/samba/private/sam.ldb <<'EOF'
dn: DC=ad,DC=rosenweg4303,DC=ch
changetype: modify
replace: ms-DS-MachineAccountQuota
ms-DS-MachineAccountQuota: 0
EOF
```

Vorher prüfen, ob os-stationen (adcli join mit `domain.join_user`) dann noch
beitreten kann — das Beitrittskonto braucht dafür das Recht „Computer
erstellen" in der Ziel-OU.
