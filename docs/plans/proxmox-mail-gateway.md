# Proxmox Mail Gateway + Mailcow

## Ziel
Eine Public IP für mehrere Mailserver nutzen. PMG als zentraler Mail-Relay/Filter vor Mailcow-Instanzen.

## Architektur

```
Internet (Port 25/465/587)
        │
        ▼
  Proxmox Mail Gateway (PMG)
  ├── Spam/Virus-Filter (ClamAV, SpamAssassin)
  ├── DKIM-Verification
  ├── SPF-Checks
  ├── Greylisting
  └── Domain-basiertes Routing
        │
        ├── rosenweg4303.ch → Mailcow 1 (intern)
        ├── domain2.ch      → Mailcow 2 (intern)
        └── domain3.ch      → Mailcow N (intern)
```

## Outbound

```
Mailcow 1/2/N → PMG (Smarthost) → Internet
                  ├── DKIM-Signing
                  ├── Rate Limiting
                  └── Outbound Queue
```

## Komponenten

### 1. Proxmox Mail Gateway (PMG)
- **Typ**: LXC oder VM auf PVE
- **Ressourcen**: 2 CPU, 4GB RAM, 32GB Disk
- **Netzwerk**: Public IP (Port 25, 465, 587 offen) + internes LAN
- **Funktion**: MX-Record, Relay, Filter, Queue
- **DNS**: MX-Record für alle Domains zeigt auf PMG

### 2. Mailcow (pro Instanz)
- **Typ**: LXC/VM oder Docker
- **Ressourcen**: 2 CPU, 4GB RAM, 50GB+ Disk
- **Komponenten**: Dovecot (IMAP), Postfix (SMTP), SOGo (Webmail), Rspamd
- **Netzwerk**: Nur intern erreichbar (kein Port 25 nach aussen)
- **Funktion**: Mailboxen, IMAP, Webmail, Kalender, Kontakte

## Voraussetzungen

### Netzwerk
- [ ] Public IP mit offenem Port 25 (ISP muss das erlauben)
- [ ] Reverse DNS (PTR) auf die Public IP → mail.rosenweg4303.ch
- [ ] Kein ISP-Block auf Port 25 (viele Consumer-ISPs blocken das)

### DNS (Cloudflare)
- [ ] MX-Record: `rosenweg4303.ch → mail.rosenweg4303.ch` (Prio 10)
- [ ] A-Record: `mail.rosenweg4303.ch → Public IP`
- [ ] SPF: `v=spf1 ip4:<PUBLIC_IP> include:spf.smtp2go.com ~all`
- [ ] DKIM: Wird von Mailcow generiert
- [ ] DMARC: Bleibt bestehen, ggf. Policy auf `reject` hochstufen
- [ ] PTR: `Public IP → mail.rosenweg4303.ch` (beim Hoster/ISP setzen)

### Zertifikate
- [ ] Let's Encrypt für `mail.rosenweg4303.ch` (PMG + Mailcow)
- [ ] Automatische Erneuerung

## Migration

### Phase 1: PMG aufsetzen
1. LXC/VM auf PVE erstellen
2. PMG installieren (Debian + PMG-Repo)
3. Grundkonfiguration (Hostname, Netzwerk, Zertifikat)
4. Transport-Regeln für Domain → Backend-Mailserver
5. Firewall: Port 25/465/587 öffnen

### Phase 2: Mailcow aufsetzen
1. Docker-basierte Installation auf LXC/VM
2. Domain hinzufügen (rosenweg4303.ch)
3. Mailboxen erstellen (Migration von Gmail)
4. Postfix als Relay konfigurieren (Smarthost = PMG)
5. DKIM generieren und in Cloudflare DNS eintragen

### Phase 3: DNS umstellen
1. MX-Record auf PMG umstellen
2. SPF-Record anpassen (Public IP statt SMTP2GO)
3. Testmails senden/empfangen
4. SMTP2GO als Fallback behalten (temporär)

### Phase 4: Gmail-Migration
1. Alle Mailboxen in Mailcow erstellen
2. imapsync für bestehende Mails
3. Verteiler-Adressen als Aliases in Mailcow
4. IMAP-Polling im API-Server auf Mailcow umstellen
5. Gmail deaktivieren

### Phase 5: Weitere Domains
1. Zusätzliche Domains in PMG + Mailcow hinzufügen
2. DNS-Records für jede Domain
3. Separate Mailcow-Instanzen bei Bedarf

## Offene Fragen
- [ ] Welcher ISP/Hoster? Port 25 offen? PTR möglich?
- [ ] Public IP: Statisch oder dynamisch?
- [ ] Wie viele Domains sollen darüber laufen?
- [ ] Braucht es mehrere Mailcow-Instanzen oder reicht eine?
- [ ] Soll SMTP2GO als Fallback-Relay bleiben?
- [ ] SOGo Webmail oder Roundcube?
- [ ] Kalender/Kontakte (CalDAV/CardDAV) gewünscht?

## Kosten
- PMG: Kostenlos (Open Source, optional Support-Abo)
- Mailcow: Kostenlos (Open Source)
- Public IP: Abhängig vom Hoster
- Zertifikate: Kostenlos (Let's Encrypt)
