# Rosenweg PBX (Asterisk)

Stand: 17.11.2026. Sicherheitsregeln im Überblick:
[`../docs/sicherheit.md`](../docs/sicherheit.md) Abschnitt 4.8. Deploy der
PBX-API Schritt für Schritt: [DEPLOY-PBX-API.md](DEPLOY-PBX-API.md).

Telefonanlage für die +41 61 551 01 52 (SIP-Trunk von peoplefone). Läuft nicht in
Docker, sondern in einem eigenen LXC, weil SIP/RTP hinter Docker-NAT unnötig
schwierig ist.

| | |
|---|---|
| Container | **CT 220 `asterisk-pbx`** |
| Knoten | **pve3** (`100.64.2.22`) |
| Adresse | **100.64.2.55** (bis 27.06.2026 `.29`, Konflikt mit der Fileserver-Adresse; ältere Angaben „pve2/100.64.2.30“ und „pve1/100.64.2.29“ sind überholt) |
| Dienste | `asterisk`, `pbx-api` (Flask/waitress, Port 8095), `certbot.timer` |
| Admin-Oberfläche | `https://pbx.rosenweg4303.ch` (Technik/Präsident) |
| SIP intern | `sip.rosenweg4303.ch` → `100.64.2.55` (nur internes DNS) |

`pct`-Befehle gehen nur auf dem Knoten, auf dem CT 220 gerade läuft
(`ha-manager status | grep ct:220` bzw. `pct list` auf pve3).

## Was die Anlage tut

Die ganze PBX-Steuerung lebt seit 16.06.2026 als eigener Python-Dienst in
CT 220 (`pbx/api/`, eigene SQLite-Datenbank), nicht mehr in der Haupt-API:

- **Ring-Group** mit Geschäftszeiten; je Mitglied eine **Zeitsperre**
  (`bypass_hours` = „klingelt immer“).
- **SIP-Telefone** (nur LAN/VPN) – Verwaltung in der Oberfläche, daraus erzeugt
  die API `/etc/asterisk/pjsip_phones.conf`.
- **Technik-Konferenz:** `100` am SIP-Telefon, **`*100`** als Eskalation während
  eines angenommenen Anrufs.
- **Voicemail-KI:** Whisper (Groq, sonst OpenRouter) → Zusammenfassung →
  **WhatsApp direkt über den Gateway** (`/gateway/send`, Schlüssel `mg_…`) →
  Anrufliste. Optional Weitergabe an die Haupt-API für eine automatische
  Reklamation (`FORWARD_VOICEMAIL_URL`); dort gilt: höchstens **3 automatische
  Reklamationen je Anrufernummer und 20 pro Tag** insgesamt (Anrufernummern sind
  fälschbar).
- Trunk-Status, Testanruf, Anrufliste.

```
PSTN ─▶ peoplefone SIP-Trunk ─(udp/5060, nur 95.128.80.0/25)─▶ UDM ─▶ CT 220 (100.64.2.55)
                                                                     Asterisk + chan_pjsip
            Geschäftszeit: Dial → Ring-Group (Mobile über peoplefone, SIP-Telefone)
            sonst:         Record → AGI transcribe_voicemail.py → pbx-api :8095
                                     → Whisper → Zusammenfassung → WhatsApp-Gateway
                                     → optional Haupt-API /api/pbx/voicemail (Auto-Reklamation)
```

## Sicherheitsregeln (Stand 17.11.2026)

**AMI (Asterisk Manager Interface, Port 5038).** AMI kann Anrufe auslösen
(`originate`) und CLI-Befehle ausführen (`command`). In
`asterisk-config/manager.conf` sind darum nur zwei Aufrufer zugelassen:

```
deny   = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255      ; PBX-API in CT 220 (pbx/api/ami.py)
permit = 100.64.2.52/255.255.255.255    ; Haupt-API (CT 128, amiCommand)
```

`bindaddr` bleibt `0.0.0.0` (beide Wege werden gebraucht, Asterisk kennt nur
eine Bindeadresse); die ACL sperrt alle anderen. Fehlt die Zeile für
`127.0.0.1`, meldet Asterisk für die PBX-API fälschlich `Authentication failed`.
Empfohlen zusätzlich: in der Proxmox-Firewall von CT 220 Port 5038 nur für
`100.64.2.52` öffnen.

Das `secret` in der Repo-Datei ist der **Platzhalter**
`ROSENWEG_AMI_PLACEHOLDER`. Der echte Wert steht nur in CT 220
(`/etc/asterisk/manager.conf`) und als `PBX_AMI_SECRET` in
`/opt/rosenweg-core/.env` (CT 128). **Beim Ausrollen von `manager.conf` den
Platzhalter nicht übernehmen** – vorher den echten Wert einsetzen oder nur die
`permit`/`deny`-Zeilen von Hand übertragen.

**Eingaben, die in Asterisk landen.** Namen und Rufnummern gehen in Dial-Strings,
Call-Files, AGI-Befehle und `pjsip_phones.conf`. Dort wäre ein Zeilenumbruch ein
eigener Befehl bzw. ein eigener Abschnitt. Darum prüft die PBX-API seit dem
17.11.2026 beim Anlegen **und** Ändern:

| Feld | Regel | Fehlermeldung (HTTP 400) |
|---|---|---|
| Ring-Mitglied `name` | 1–80 Zeichen, keine Steuerzeichen, kein `" \ < >` | `name ungueltig (1-80 Zeichen, …)` |
| Ring-Mitglied `phone` (Mobil) | `+` und 6–20 Ziffern | `Telefonnummer im intl. Format (+41...)` |
| Ring-Mitglied `phone` (SIP) | `A–Z a–z 0–9 _ -`, 1–32 | `SIP-Extension ungueltig` |
| `priority` | Zahl 0–10000 | `priority muss 0-10000 sein` |
| `valid_until` | `YYYY-MM-DD` (optional Uhrzeit) | `valid_until muss ein Datum sein (YYYY-MM-DD)` |
| SIP-Telefon `ext` | 2–8 Ziffern | `Extension muss numerisch sein` |
| SIP-Telefon `name` | höchstens 60 Zeichen, kein `[ ] < > ; " \` | `name ungueltig (…)` |
| SIP-Telefon `secret` | 8–64 Zeichen aus `A–Z a–z 0–9 . _ ~ -` (leer = wird erzeugt) | `secret: 8-64 Zeichen …` |
| SIP-Telefon `context` | nur `internal` | `context nicht erlaubt` |

Ältere Einträge, die diese Regeln verletzen, schreibt die API nicht mehr in
`pjsip_phones.conf` und meldet im Journal von `pbx-api`:
`SIP-Extension … nicht in pjsip_phones.conf geschrieben (ungueltige Extension/Secret/Kontext)`.
Das betroffene Telefon kann sich dann nicht anmelden – Eintrag in der
Oberfläche korrigieren. Die AGI-Skripte bereinigen Namen und Nummern zusätzlich
(`agi_sauber`), die Haupt-API weist AMI-Felder mit Steuerzeichen ab.

**Weitere Regeln:**

- AGI ↔ PBX-API: Header `X-PBX-Secret` = `PBX_SHARED_SECRET`, zeitkonstant
  verglichen.
- Provisionierungs-Token (QR) wird atomar verbraucht: Zwei gleichzeitige Abrufe
  bekommen nicht beide das SIP-Passwort.
- Der Anmelde-Proxy der PBX-API reicht nur `/api/auth…` und `/api/me…` (mit
  Segmentgrenze, ohne `..`, `%`, `\`) an die Haupt-API weiter, sonst 404.

## Dateien und Konfiguration

| Repo | Ziel in CT 220 | Zweck |
|---|---|---|
| `asterisk-config/*.conf` | `/etc/asterisk/` | Trunk (`pjsip.conf`), Dialplan (`extensions.conf`), Konferenz, AMI (`manager.conf`, Platzhalter!) |
| `agi/*.py` | `/var/lib/asterisk/agi-bin/` | Ring-Group, Geschäftszeiten, Anrufliste, Konferenz-Einladung, CNAM, Voicemail-Upload |
| `api/app.py`, `db.py`, `ami.py`, `voicemail.py` | `/opt/pbx-api/` | PBX-API |
| `api/pbx-api.service` | `/etc/systemd/system/` | Dienst als Benutzer `asterisk` |
| `api/pbx-api.env.example` | Vorlage für `/etc/default/pbx-api` (0600) | Pfade, Hosts, Voicemail-KI, Provisionierung |
| `web/pbx-admin.html` | `/opt/pbx-api/web/` | Oberfläche |
| – | `/etc/default/asterisk-env` (0600) | Trunk-Zugang und `PBX_SHARED_SECRET`, gelesen von AGI und `pbx-api` |
| – | `/var/lib/pbx-api/pbx.sqlite` | Daten der PBX-API |

Variablen in `/etc/default/asterisk-env` (Werte nur dort bzw. im Passwortmanager):
`PJSIP_USER`, `PJSIP_PASS`, `PJSIP_SERVER`, `EXTERNAL_IP`, `TECHNIK_NUMBERS`,
`PBX_SHARED_SECRET`, `API_BASE`.

Variablen in `/etc/default/pbx-api`: `MAIN_API_BASE`, `PBX_PUBLIC_HOST`,
`PBX_API_PORT`, `PBX_DB_PATH`, `ASTERISK_PHONES_CONF`, `PBX_WEB_DIR`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `VOICEMAIL_MODEL`, `GATEWAY_SEND_URL`,
`GATEWAY_API_KEY`, `VOICEMAIL_WA_TARGET`, `FORWARD_VOICEMAIL_URL`,
`FORWARD_VOICEMAIL_SECRET`, `PBX_SIP_HOST`, `PBX_SIP_TRANSPORT`,
`PBX_SIP_REG_EXPIRES`, `PBX_PROV_TTL_MIN`, `PBX_CARDDAV_*`.

In der Haupt-API (CT 128): `PBX_HOST` (Standard `100.64.2.55`), `PBX_AMI_USER`
(`rosenweg`), `PBX_AMI_SECRET`, `PBX_SHARED_SECRET`.

## Ausrollen (Änderungen aus dem Repo)

Kurzform; ausführlich in [DEPLOY-PBX-API.md](DEPLOY-PBX-API.md):

```bash
PVE=root@100.64.2.22   # pve3
# AGI-Skripte
tar -C pbx/agi -cf - --exclude=__pycache__ . | ssh $PVE 'pct exec 220 -- tar -C /var/lib/asterisk/agi-bin -xf -'
ssh $PVE 'pct exec 220 -- sh -c "chmod +x /var/lib/asterisk/agi-bin/*.py && chown -R asterisk:asterisk /var/lib/asterisk/agi-bin"'
# PBX-API
tar -C pbx/api -cf - app.py db.py ami.py voicemail.py | ssh $PVE 'pct exec 220 -- tar -C /opt/pbx-api -xf -'
tar -C pbx/web -cf - pbx-admin.html | ssh $PVE 'pct exec 220 -- tar -C /opt/pbx-api/web -xf -'
ssh $PVE 'pct exec 220 -- sh -c "chown -R asterisk:asterisk /opt/pbx-api && systemctl restart pbx-api"'
# AMI-ACL: nur permit/deny von Hand in /etc/asterisk/manager.conf übertragen (Secret bleibt!), dann:
ssh $PVE 'pct exec 220 -- asterisk -rx "manager reload"'
```

## Prüfen

```bash
ssh root@100.64.2.22 'pct exec 220 -- sh -c "
  systemctl is-active asterisk pbx-api
  curl -s localhost:8095/health
  asterisk -rx \"pjsip show registrations\"
  asterisk -rx \"manager show user rosenweg\""'
```

- `pjsip show registrations` muss den peoplefone-Trunk als `Registered` zeigen.
- `manager show user rosenweg` zeigt die ACL; es dürfen nur `127.0.0.1` und
  `100.64.2.52` als `permit` erscheinen.
- In `pbx-admin` (Haupt-API-Weg) muss der Trunk-Status **● Registriert** zeigen –
  das beweist, dass die Haupt-API das AMI erreicht.
- Von einem anderen Host: `nc -vz -w 3 100.64.2.55 5038` darf zwar verbinden, ein
  Login muss aber scheitern.
- `journalctl -u pbx-api | grep "nicht in pjsip_phones.conf"` – leer, sonst
  Einträge korrigieren.

## Zurückbauen

- PBX-API und AGI: die beim Rollout am 17.11.2026 ersetzten Dateien liegen als
  `<datei>.vor-sicherheit-2026-11-17` daneben; zurückkopieren,
  `systemctl restart pbx-api`.
- AMI-ACL: in `/etc/asterisk/manager.conf` die alte Zeile
  `permit = 100.64.0.0/255.252.0.0` wieder einsetzen, `manager reload`. Damit
  dürfte wieder jeder Host im ganzen Hausnetz einen AMI-Login versuchen.

## Neuaufbau (nur falls CT 220 verloren ist)

1. LXC auf pve3 anlegen: Debian 13, Hostname `asterisk-pbx`, IP `100.64.2.55/24`,
   Gateway `100.64.2.1`, 2 Kerne, 1 GB RAM, `nesting=1`. Netzwerk-Bridge wie bei
   den anderen Diensten im Netz `100.64.2.0/24` (aus `pct config` eines
   Nachbar-Containers übernehmen).
2. Asterisk aus dem Sangoma-Repo installieren:

   ```bash
   apt update && apt install -y curl gnupg ca-certificates lsb-release
   curl -fsSL https://packages.asterisk.org/asterisk-org-pub.gpg | gpg --dearmor -o /usr/share/keyrings/asterisk.gpg
   echo "deb [signed-by=/usr/share/keyrings/asterisk.gpg] https://packages.asterisk.org/debian trixie main" > /etc/apt/sources.list.d/asterisk.list
   apt update && apt install -y asterisk asterisk-config python3 python3-requests python3-venv
   ```

3. `/etc/default/asterisk-env` anlegen (Modus 0600), Werte aus dem
   Passwortmanager:

   ```bash
   install -m 0600 /dev/null /etc/default/asterisk-env
   cat >> /etc/default/asterisk-env <<'EOF'
   PJSIP_USER=<peoplefone-Benutzer>
   PJSIP_PASS=<im Passwortmanager>
   PJSIP_SERVER=sip.peoplefone.ch
   EXTERNAL_IP=<öffentliche IP>
   TECHNIK_NUMBERS=<+41…&+41…>
   PBX_SHARED_SECRET=<im Passwortmanager, gleicher Wert wie in der Haupt-API>
   API_BASE=http://100.64.2.52:3000
   EOF
   ```

4. Configs, AGI und PBX-API wie in [DEPLOY-PBX-API.md](DEPLOY-PBX-API.md) ausrollen;
   `manager.conf` mit echtem Secret.
5. Portweiterleitung `udp/5060` an der UDM nur für `95.128.80.0/25` (siehe unten).
6. Zertifikat für `sip.rosenweg4303.ch` (siehe unten), Daten aus dem letzten
   Proxmox-Backup oder `migrate_from_postgres.py`.

## SIP-Transporte (Stand 2026-09-09)

Asterisk lauscht auf drei Transporten:

| Transport | Bind | Von aussen erreichbar | Wofuer |
|---|---|---|---|
| `transport-udp` | `0.0.0.0:5060` | **ja** (UDM-Forward udp/5060) | peoplefone-Trunk |
| `transport-tcp` | `0.0.0.0:5060` | nein | WLAN-Telefone im LAN/VPN |
| `transport-tls` | `0.0.0.0:5061` | nein | WLAN-Telefone, verschluesselt |

**Warum TCP/TLS.** Ein WLAN-Smartphone verliert seine UDP-/NAT-Bindung, sobald es
in Doze geht — die Registrierung sieht aus Asterisks Sicht noch gueltig aus, aber
das eingehende INVITE kommt nicht mehr an. Eine offene TCP-Verbindung ueberlebt
das. Deshalb bei Softphones (Linphone) **TCP** statt UDP waehlen, plus Ausnahme
von der Akku-Optimierung und ein kurzes Register-Expiry (60-180 s).

Die Endpoints in `pjsip_phones.conf` setzen **kein** `transport=` — Asterisk
antwortet auf dem Transport, ueber den sich das Telefon registriert hat. Es muss
also nichts pro Nebenstelle umgestellt werden.

**Zertifikat.** Let's Encrypt fuer `sip.rosenweg4303.ch`, per certbot mit
DNS-01 ueber Cloudflare direkt in CT 220 (`/root/.cloudflare.ini`, Modus 0600;
der Cloudflare-Token stammt aus CT 245 und muss beim Rotieren des
Cloudflare-Tokens hier mitgeaendert werden, siehe `docs/sicherheit.md`
Abschnitt 7.1). Der Deploy-Hook
`/etc/letsencrypt/renewal-hooks/deploy/asterisk.sh` kopiert das erneuerte
Zertifikat nach `/etc/asterisk/keys/sip.{crt,key}` — noetig, weil
`/etc/letsencrypt/archive` `0700 root` ist und Asterisk als `asterisk` laeuft —
und macht `module reload res_pjsip`. Renewal uebernimmt `certbot.timer`.

`sip.rosenweg4303.ch` existiert **nur im internen Split-Horizon** (UniFi
static-dns → `100.64.2.55`), nicht in der oeffentlichen Zone. DNS-01 braucht
keinen A-Record, also bleibt die interne IP privat.

**Seit 12.09.2026 eingeschraenkt.** Die Portweiterleitung `udp/5060` stand auf
`src: any`. Die Scanner, die dort anklopften, liessen die Asterisk- und
fail2ban-Logs auf 4.4 GB wachsen, bis die Wurzel des Containers voll war. Die
Regel heisst jetzt `Asterisk-SIP peoplefone (udp/5060)` und hat
`src = 95.128.80.0/25`, `src_limiting_enabled = true`.

Warum genau dieses Netz: RIPE fuehrt `95.128.80.0 - 95.128.80.127` als
`netname: PEOPLEFONE`. Und vor allem — **Asterisk akzeptiert ueber
`pjsip identify` ohnehin nur 95.128.80.3/.5/.7**. Die Firewall-Regel ist damit
*weiter* als die Pruefung, die auf der Anwendungsebene schon greift: sie kann
keinen Anruf verhindern, der vorher durchkam. Ein /25 statt drei /32 gewaehlt,
damit ein zusaetzlicher peoplefone-Server nicht stillschweigend ausgesperrt wird.

Nach der Aenderung: Trunk weiter `Registered`, Gegenstelle `Avail` mit 2.9 ms.

**Noch offen:** `tcp/5061` ist von aussen nicht freigegeben. Telefone koennen
sich daher nur im WLAN/VPN registrieren, nicht von unterwegs.

## Linphone-Provisionierung (QR bei den Nebenstellen)

Im pbx-Admin-UI hat jede Nebenstelle einen Knopf **📱 QR**. Dahinter:

1. `POST /api/pbx/sip-extensions/<ext>/provisioning` (Technik/Praesident) legt ein
   **Einmal-Token** mit 15 Minuten Frist an und liefert ein serverseitig
   gerendertes SVG (`segno`) — kein Fremd-Skript im UI.
2. Der QR enthaelt nur `https://pbx.rosenweg4303.ch/prov/<token>`.
3. Am Telefon: Linphone → Assistent → **„Fetch Remote Configuration"** → scannen.
4. `GET /prov/<token>` liefert die linphonerc-XML und **verbrennt das Token**.
   Unbekannt, abgelaufen und verbraucht geben dieselbe 404 — der Zustand eines
   Links soll sich nicht abfragen lassen.

Die XML setzt Konto, `transport=tcp`, `reg_expires=120` und schaltet Video ab.
Steuerung ueber `/etc/default/pbx-api` (`PBX_SIP_HOST`, `PBX_SIP_TRANSPORT`,
`PBX_SIP_REG_EXPIRES`, `PBX_PROV_TTL_MIN`); die Vorgaben im Code passen bereits
zur Anlage, es muss nichts gesetzt werden.

**Warum Einmal-Token.** In der XML steht das SIP-Passwort im Klartext — anders
geht Provisionierung nicht. Also ist die URL selbst das Geheimnis, und sie darf
nur einen einzigen Abruf ueberleben. Ein ausgedruckter oder weitergeleiteter QR
ist danach wertlos.

### Zentrales Telefonbuch (CardDAV)

`contacts-sync` haelt in Nextcloud das komplette Verzeichnis unter
`addressbooks/users/kontakte/rosenweg/` (Stand 2026-09-09: 171 Eintraege).
Linphone fragt das als *Remote Contact Directory* direkt ab — kein DAVx5, keine
Systemkontakte. Der Abschnitt wandert automatisch in jede Provisioning-XML.

Konfiguriert in `/etc/default/pbx-api`:

```
PBX_CARDDAV_URL=https://nextcloud.rosenweg4303.ch/remote.php/dav/addressbooks/users/kontakte/rosenweg/
PBX_CARDDAV_USER=kontakte
PBX_CARDDAV_PASS=<occ user:add-app-password kontakte>
PBX_CARDDAV_REALM="Nextcloud des Rosenweg Kaiseraugst"
```

**Warum genau diese Schluessel.** Feature-Wiki und SDK-Doku widersprechen sich,
also entscheidet der Quellcode: `Core::reloadRemoteContactDirectories()` sucht
Sektionen mit Praefix **`carddav_`**, und `CardDavParams::readFromConfigFile()`
liest `server_url`, `results_limit`, `min_characters`, `timeout`,
`fields_for_user_input`, `fields_for_domain`, `use_exact_match_policy` — mehr
nicht. `enabled`, `type` und `uri` gibt es dort **nicht**.

**Warum ein zweiter auth_info-Block.** Der CardDAV-Client ruft nie
`setAuthInfo()`; beim 401 sucht liblinphone eine passende `LinphoneAuthInfo`
ueber **Realm und Host**. Darum `auth_info_1` mit `realm` = dem Realm aus dem
`WWW-Authenticate`-Header und `domain` = dem Nextcloud-Host.

**Der Hostname ist nicht beliebig.** `contacts-sync` spricht intern per HTTP mit
`Host: nextcloud.rosenweg9.ch` — dieser Name hat am Edge **keinen Traefik-Router**
und liefert nach aussen das TRAEFIK-DEFAULT-CERT. Fuer die Telefone gilt darum
`nextcloud.rosenweg4303.ch`, der ein gueltiges Zertifikat hat.

**Es gibt zwei CardDAV-Funktionen, und nur eine ist provisionierbar.**

| | `[carddav_0]` (provisioniert) | CardDAV-Adressbuch in den App-Einstellungen |
|---|---|---|
| liblinphone-Begriff | RemoteContactDirectory | FriendList vom Typ CardDAV |
| gespeichert in | `linphonerc` | `friends.db` (SQLite) |
| per QR lieferbar | **ja** | **nein** |
| Anzeige | Treffer beim Suchen ab 3 Zeichen | vollstaendige Liste, offline verfuegbar |

Das erklaert den Eindruck „Linphone hat CardDAV nicht eingerichtet": unter
Einstellungen → Kontakte listet die App ihre **FriendLists** auf, und dort steht
nichts, weil `carddav_0` eine andere Sache ist. Ob die Provisionierung
funktioniert hat, sieht man nur, indem man im Kontakte-Tab **drei Zeichen
tippt** — dann fragt `MagicSearch.Source.RemoteCardDAV` den Server ab
(`ContactsListViewModel.kt`), und im Apache-Log von CT 104 taucht ein REPORT auf.

Die FriendList laesst sich nicht mitliefern, weil sie nie in die Konfigurations-
datei geschrieben wird (`friend-list.cpp` kennt kein `writeToConfigFile`). Darum
zeigt das QR-Fenster die fuenf Werte zum Kopieren an — einmal pro Geraet unter
Einstellungen → Kontakte → *CardDAV-Adressbuch hinzufuegen* eintragen.

**Berechtigung.** Das App-Passwort gehoert dem Konto `kontakte` und kann damit
auch schreiben — Nextcloud kann App-Passwoerter nicht auf lesend einschraenken.
Fuer eigene, dedizierte Geraete vertretbar; es haengt unter dem Namen
„SIP-Telefone (Linphone)" in den Nextcloud-Sicherheitseinstellungen und ist dort
mit einem Klick widerrufbar.

## Seite /apps und App-Releases (Stand 26.11.2026)

`www.rosenweg4303.ch/apps` (`apps.html`) liest `https://pbx.rosenweg4303.ch/api/apps/index.json`
(öffentlich, CORS für www) – **nicht** `www…/api/apps/…` (das ist die Haupt-API und liefert 404).

- `apps`: alle öffentlichen Android-APKs aus dem App-Katalog der geteilten Telefone
  (`telefon_apps`, ohne Rosenweg Gerät) – dieselbe Liste nutzt der Updater der Apps.
- `karten`: Apps aus `APPS_REGISTER` in `api/app.py` (Rosenweg Virtuelle Computer, Rosenweg Salz,
  vorbereitet Rosenweg Profil) mit Logo, Text und je Plattform einem Download
  (Android, Linux-.deb, macOS-.dmg, Windows). Erscheint erst mit der ersten Datei.

**Neue Versionen kommen automatisch:** Die CI eines App-Repos schickt beim Release-Tag die Dateien an
`POST /api/apps/release` (Action `.github/actions/apps-release` bzw. wiederverwendbarer Workflow
`.github/workflows/apps-release.yml` in diesem Repo). Anmeldung mit dem OIDC-Token von GitHub
Actions – kein gespeichertes Geheimnis. Die Anlage lässt nur die eingetragenen Repos zu
(`APPS_REGISTER`, `APPS_KATALOG_REPOS`), nur für einen Tag `v1.2.3`/`1.2.3`, und prüft Prüfsumme,
Dateityp, Version = Tag und bei APKs Rosenweg-Signatur und Paketnamen. Katalog-Apps müssen auf
/smartphones angelegt sein (Gruppen, „aktiv“ bleiben Sache der Technik); ihre APK wird ersetzt.
Je App und Plattform bleiben `APPS_BEHALTEN` = 3 Fassungen in `apps_versionen`
(Dateien unter `/var/lib/pbx-api/apps/dateien/`).

Release von Hand (lokal signiert): `gh release create v1.2.3 app.apk --notes "…"` – der Workflow
`apps.yml` des Repos schickt sie weiter. Erneut senden: `gh workflow run apps.yml --ref v1.2.3`.
Technik ohne GitHub: `POST /api/pbx/apps-versionen/<app|paket>/<plattform>` (multipart `datei`,
`version`, `notiz`; Bearer-Token der Technik), Liste `GET /api/pbx/apps-versionen`, Fassung
zurückziehen `DELETE /api/pbx/apps-versionen/<id>`.

Neue App: Eintrag in `APPS_REGISTER` (oder `APPS_KATALOG_REPOS`), Logo nach `img/apps/<app>.png`
(Turm + Weg + Rose), Release-Schritt im Repo.

## Anpassung

| Was | Wo |
|---|---|
| Geschaeftszeiten | `extensions.conf` → `HOURS_OPEN_FROM` / `HOURS_OPEN_TO` |
| Ring-Group-Nummern | `extensions.conf` → `TECHNIK_NUMBERS` (Format `+41xxx&+41yyy`) |
| Max Voicemail-Dauer | `extensions.conf` → `Record(...,180)` |
| Whisper/Analyse-Modell | `pbx/api/voicemail.py`, Variable `VOICEMAIL_MODEL` in `/etc/default/pbx-api` |
| Ziel der WhatsApp-Meldung | `VOICEMAIL_WA_TARGET` (Standard „Rosenweg Technik“) |
| Mitglieder, Zeitsperren | Oberfläche `pbx.rosenweg4303.ch` (nicht mehr `extensions.conf`) |

## Backup

LXC-Snapshot taeglich via Proxmox (PVE GUI → CT 220 → Backup). Voicemail-Recordings unter `/var/spool/asterisk/voicemail/recordings/`.

**Löschfrist Voicemail (25.11.2026): 90 Tage.** `voicemail_aufraeumen.py` (Timer `pbx-voicemail-aufraeumen.timer`, täglich 03:30) löscht ältere Aufnahmen in `recordings/` und `personen/` und leert Pfad, Abschrift und Zusammenfassung in der Anrufliste; der Anruf bleibt. `VOICEMAIL_TAGE` in `/etc/default/pbx-api` ändert die Frist. Die nächtlichen Sicherungen auf PBS-Rosenweg (keep-all) behalten alte Stände.

**Ring-Group mit persönlichen Nummern (25.11.2026):** Mitglieds-Typ **Person** mit der Nummer 3HHWWP. Gewählt über `Local/<nummer>@ring-person/n`: klingelt auf allen Geräten, an denen die Person angemeldet ist (Rosenweg Telefon, geteilte Telefone); ihre Weiterleitung aufs Handy gilt („immer“ sofort, „nicht erreichbar“ nach der eingestellten Zeit oder wenn kein Gerät da ist), ihre **persönliche Voicemail nicht** – sonst nähme sie den Anruf an und die übrigen Mitglieder klingelten nicht mehr. Gilt auch für die Technik-Konferenz (*100). Die Direktwahl einzelner Mitglieder (1XXX) gibt es nicht mehr (doppelt zu 3HHWWP/21XX).

**Interne Nummern Technik (25.11.2026, Nummernplan: 1XXX Gruppen, 2000–2099 Dienste, 2100–2199 Geräte):**
- **1000 = Ring-Group Technik:** klingelt bei allen Mitgliedern, ohne Geschäftszeiten, ohne Voicemail.
- **2000 = Dienst Technik:** wie die Amtsnummer – Geschäftszeiten, Ring-Group, sonst gemeinsame Voicemail (Abschrift, WhatsApp an Technik, Auto-Reklamation).

## Phase 2 (Roadmap)

- Asterisk-AudioSocket-Modul → bidirektionaler PCM-Stream zur API
- API als Streaming-Gateway:
  - Eingehendes Audio (PCM 16k) → Whisper Streaming
  - Text → Claude mit STWEG-Kontext (FAQ, aktuelle Reklamationen, Verwaltung, Notfaelle)
  - Claude-Response → ElevenLabs TTS → zurueck zu Asterisk
- Eskalation: AI sagt "Ich verbinde dich" → ATXFER an Technik-Mobile (mit Briefing-SMS vorab)
- DSGVO: Anrufer-Hinweis ("Dieses Gespraech wird KI-gestuetzt bearbeitet")
- Knowledge-Base: STWEG-Daten via Tool-Calls
