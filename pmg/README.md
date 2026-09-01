# pmg-restore-relay

Hält die Postfix-Einstellungen auf **CT 230 (`pmg`)**, die `pmgconfig sync`
zurücksetzt. Läuft dort als `/usr/local/sbin/pmg-restore-relay.sh`.

## Wie es hierher kam

Bis zum 1. September 2026 lag das Skript **nur** auf dem Container — wie
`wg-control` vor ihm. Aufgefallen ist es, als die Dienstwacht meldete, dass
`pmg-restore-relay.service` fehlschlägt.

## Was es hält

**Ausgehender Relay.** Primär der eigene VPS (`smtp-relay.rosenweg4303.ch`,
rDNS und SRS), als Ausweichziel SMTP2GO.

**Interne Relay-Adressen** in `smtpd/pass/mynetworks` — damit Mailcow und der
WhatsApp-Gateway über PMG hinaus dürfen.

**Den Transport `intern`.** Interne Ziele gehen über einen eigenen Transport
*ohne* Ausweichrelay. Das ist der Kern, und er hat einen Anlass: Am
1. September war der WhatsApp-Gateway (100.64.2.39:2525) einen Moment nicht
erreichbar. Postfix wich auf SMTP2GO aus, und das lehnte ab — der Absender
war `gmx.ch`, dort nicht als verifizierte Domäne hinterlegt. Aus einer
Störung von Sekunden wurde ein endgültiger Fehlschlag: Die Nachricht war
verloren, und der Absender bekam eine Fehlermeldung, die auf gmx.ch zeigte,
also auf etwas, das mit der Ursache nichts zu tun hatte.

Für Mail nach draussen bleibt das Ausweichziel richtig und aktiv. Nur intern
gilt: Wer gerade schweigt, wird später erneut gefragt.

## Zwei Fallstricke, die hier schon zugeschlagen haben

**Der Rückgabewert.** Die letzte Zeile war lange ein Test, der im Normalfall
falsch ergibt — womit das Skript mit 1 endete und systemd den Dienst als
fehlgeschlagen führte, obwohl er das Richtige tat. Darum steht am Ende ein
ausdrückliches `exit 0`.

**`pmgconfig sync` schreibt zurück.** Alles hier Gesetzte muss idempotent
sein und nach jedem Sync erneut greifen. Deshalb prüft jeder Abschnitt erst,
ob etwas zu tun ist, und meldet nur dann `RELOAD=1`.

## Ausrollen

```bash
scp pmg-restore-relay.sh root@100.64.2.21:/tmp/
ssh root@100.64.2.21 'pct push 230 /tmp/pmg-restore-relay.sh \
    /usr/local/sbin/pmg-restore-relay.sh --perms 755
  pct exec 230 -- systemctl start pmg-restore-relay'
```

Danach prüfen — beides muss stimmen:

```bash
pct exec 230 -- postconf -P intern/unix/smtp_fallback_relay   # muss LEER sein
pct exec 230 -- postmap -q whatsapp.rosenweg4303.ch hash:/etc/pmg/transport
# erwartet: intern:[100.64.2.39]:2525
```
