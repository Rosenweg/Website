# Scanner-Konten und Freigabe `scans`

Jeder allgemeine Rosenweg-Scanner, der selbst auf eine Freigabe scannt, hat
ein **eigenes AD-Konto** `scan-<name>` mit eigenem Passwort (Entscheid Stefan
27.11.2026). Das Passwort gibt es nur auf Papier: Im Portal unter
**Betrieb & Admin → Scanner** (`scanner.html`, Technik/Präsident) druckt
«Neues Passwort drucken» einen Zettel auf **DruckerR9** und setzt das Passwort
im AD. Es wird nie im Browser angezeigt, nie gespeichert und nie geloggt.

Das frühere gemeinsame Konto `scanner` (Passwort stand in einer
Bewohner-Anleitung) ist seit 27.11.2026 deaktiviert. Bewohner scannen mit
ihrem eigenen Konto an den Stationen.

## Geräte (Stand 27.11.2026)

| Gerät | Modell | Adresse | Scannt auf Freigabe? | Konto |
|---|---|---|---|---|
| DruckerR13 (Rosenweg 13) | Brother MFC-J6510DW | 100.64.139.4 | ja, «Scan to FTP/Network» | `scan-r13` |
| DruckerR9 (Rosenweg 9) | Brother DCP-1612W | 100.64.99.4 | nein, nur an einen Rechner (WSD, Stationen) | – |

Gemessen an den UniFi-Clients (nur diese zwei Brother-Geräte), den
Web-Oberflächen der Geräte und CUPS auf CT 111. Der MFC-J6510DW hatte bisher
Profil 1 «Rosenweg» per **FTP** auf `100.64.2.28` mit dem lokalen Konto
`scanner` (vsftpd auf CT 106). Dessen `local_root=/srv/documents/Scans` gibt
es seit dem Umzug auf CephFS nicht mehr; der letzte FTP-Eintrag ist vom Juni
2026. Scan-to-FTP lief also schon nicht mehr.

Die Liste steht in `api/lib/scanner.js` (`SCANNER`). Neues Gerät: dort
eintragen und die Schritte unten für sein Konto wiederholen.

## Entscheid: eine Freigabe, je Konto ein eigener Ordner

```ini
[scans]
	path = /mnt/cephfs-stage/Scans/%u
	valid users = @scanner-geraete
```

Warum so (statt `valid users = @scanner-geraete` auf dem gemeinsamen Ordner
oder einer Freigabe je Gerät):

- **Am Gerät am einfachsten:** Freigabe `scans`, kein Unterordner. Samba setzt
  `%u` selbst ein, das Gerät landet in `Scans/scan-r13`. Ein Tippfehler im
  Pfad ist nicht möglich, weil es keinen gibt.
- **Ein Gerät sieht die Scans der anderen nicht.** Mit dem gemeinsamen Ordner
  könnte jedes Scanner-Konto alle Scans lesen und löschen; die Zugangsdaten
  stehen aber auf Zetteln und in Geräten, die im Treppenhaus stehen.
- **Kein smb.conf-Eingriff je neuem Gerät:** nur Konto, Gruppe, Ordner.
- In «Dokumente» bleibt alles unter `Scans/` sichtbar wie bisher (lesen alle,
  `tabelle.txt`); die Unterordner heissen wie die Konten.

## Einrichten (Stefan, einmalig) — nichts davon ist schon gemacht

### 1. AD auf dc1 (CT 108, pve3)

```bash
ssh root@100.64.2.22
pct exec 108 -- bash
samba-tool ou add OU=Scanner --description="Konten der allgemeinen Scanner"
samba-tool group add scanner-geraete --groupou=OU=Scanner \
    --description="Allgemeine Scanner (Freigabe scans, je Geraet ein Konto)"
samba-tool user create scan-r13 --random-password --userou=OU=Scanner \
    --description="Scanner DruckerR13, Brother MFC-J6510DW, Rosenweg 13"
samba-tool group addmembers scanner-geraete scan-r13
samba-tool user setexpiry scan-r13 --noexpiry
```

- `--random-password`: Das echte Passwort setzt erst der Knopf im Portal.
- Kein Profil, kein Home, keine Unix-Attribute, nicht in `rosenweg`: das Konto
  ist kein Mensch. `ad-sync` fasst es nicht an (es kennt nur Konten aus
  Authentik).
- **Anmeldung an PCs sperren (empfohlen, nach dem ersten Testscan):** Mit
  `userWorkstations` darf sich das Konto nur noch vom Gerät selbst anmelden
  (NTLM schickt dessen NetBIOS-Namen mit, beim MFC-J6510DW
  `BRN001BA9B553E7`). Ein PC weist die Anmeldung dann ab.

  ```bash
  cat > /root/scan-r13-ws.ldif <<'EOF'
  dn: CN=scan-r13,OU=Scanner,DC=ad,DC=rosenweg4303,DC=ch
  changetype: modify
  replace: userWorkstations
  userWorkstations: BRN001BA9B553E7
  EOF
  ldbmodify -H /var/lib/samba/private/sam.ldb /root/scan-r13-ws.ldif && rm /root/scan-r13-ws.ldif
  ```

  Danach nochmals scannen. Geht es nicht mehr, sendet das Gerät einen anderen
  Namen (`/var/log/samba/log.*` auf dem Fileserver) — den eintragen oder die
  Zeile mit `delete: userWorkstations` wieder entfernen.

### 2. Ordner und Rechte (einmal, CT 106 oder CT 206 — gleiches CephFS)

`tabelle.txt` ist in diesem PR schon ergänzt (`g:scanner-geraete` auf `/`
und `Scans` für den Durchgang, `~scan-r13` mit Schreibrecht nur für
`u:scan-r13`). Dann wie in [`../ordnerrechte/README.md`](../ordnerrechte/README.md):

```bash
mkdir -p /mnt/cephfs-stage/Scans/scan-r13
cd /root/ordnerrechte          # aktuelle Fassung hinkopieren
./sichern.sh  --wurzel /mnt/cephfs-stage
./anwenden.sh --tabelle tabelle.txt --wurzel /mnt/cephfs-stage --nur Scans,/ --trocken
./anwenden.sh --tabelle tabelle.txt --wurzel /mnt/cephfs-stage --nur Scans,/
```

Vorher `wbinfo -i scan-r13` und `wbinfo --group-info=scanner-geraete` — beide
müssen eine Zeile liefern, sonst lässt `anwenden.sh` den Eintrag weg.

### 3. smb.conf auf CT 106 **und** CT 206

Den Abschnitt `[scans]` durch [`smb-scans.conf`](smb-scans.conf) ersetzen,
vorher sichern:

```bash
cp /etc/samba/smb.conf /etc/samba/smb.conf.vor-scanner-konten-$(date +%F)
# [scans] ersetzen, dann
testparm -s 2>/dev/null | sed -n '/^\[scans\]/,/^\[/p'
smbcontrol smbd reload-config
```

`server min protocol = NT1` muss bleiben: der MFC-J6510DW (2011) spricht nur SMB1.

### 4. Portal (API)

Braucht `AD_PASSWORD_API_SECRET` und `PRINT_API_SECRET` in
`/opt/rosenweg-core/.env` (beide gibt es schon). Fehlt eins, zeigt
`scanner.html` es an und der Knopf ist gesperrt. Optional:
`SCANNER_ZETTEL_DRUCKER` (Standard `DruckerR9`), `SCANNER_SMB_SERVER`
(Standard `100.64.2.29`).

### 5. Gerät einstellen

Im Portal «Neues Passwort drucken» → Zettel aus DruckerR9 holen → in der
Web-Oberfläche des MFC-J6510DW (`http://100.64.139.4/` → Scan → Scan to
FTP/Network Profile → Profil 1) Typ **Network** wählen und die Werte vom
Zettel eintragen (Host Address `100.64.2.29`, Store Directory `scans`,
Username `scan-r13`, Passwort, Auth. Method NTLMv2). Testscan, prüfen, dass er
in `Dokumente/Scans/scan-r13` liegt, Zettel vernichten.

**Netz:** Der Scan geht vom Hausnetz Rosenweg 13 an `100.64.2.29:445`. Bisher
ging das Gerät per FTP an `100.64.2.28:21`; ob die UniFi-Regeln 445 aus dem
Hausnetz erlauben, ist nicht geprüft.

**Gerät absichern:** Die Web-Oberfläche des MFC-J6510DW hat kein
Administratorpasswort («Please configure the password»). Wer im Netz ist,
kann dort die Scan-Ziele umstellen. Beim Einstellen gleich ein
Administratorpasswort setzen.

### 6. Aufräumen, wenn alles läuft

- Konto `scanner` im AD löschen (`samba-tool user delete scanner`), `u:scanner`
  aus `tabelle.txt` streichen und `anwenden.sh --nur Scans,/` erneut.
- vsftpd auf CT 106 abschalten (lokale Konten `scanner`, `scanner-ftp`,
  `scanner-local`, `local_root` zeigt ins Leere), Port 21 aus `docs/netzwerk.md`.
- `docs/active-directory.md` (Abschnitt Fileserver) ist in diesem PR schon
  angepasst.

## Wie der Knopf arbeitet

`POST /api/scanner/:id/passwort-drucken` (`api/routes/scanner.js`,
`api/lib/scanner.js`):

1. Passwort erzeugen: 16 Zeichen aus `ACDEFGHJKLMNPQRTUVWXY abdefghjmnqrt
   346789` — keine verwechselbaren Zeichen (0/O, 1/l/I, 2/Z, 5/S, 8/B) und
   keine Kleinbuchstaben, die gross gleich aussehen; immer Gross, Klein und
   Ziffer (AD-Komplexität). Rund 85 Bit.
2. Zettel als PDF (Gotenberg, `doc-converter`).
3. Drucken auf DruckerR9 über die Druck-API auf CT 111 (`lib/druckapi.js`,
   derselbe Weg wie «Druck per Mail»). Scheitert das: nichts geändert.
4. Im AD setzen über die Passwort-API auf dc1 (`lib/adpasswort.js`, derselbe
   Weg wie der Passwortwechsel). Scheitert das: der Zettel ist ungültig, das
   alte Passwort gilt weiter, die Seite sagt es.
5. Protokoll `scanner_passwort_protokoll`: Scanner, Konto, wer, wie
   angemeldet (Website/Karte …), Ergebnis, Zeit — nie das Passwort.

Wo das Passwort trotzdem kurz liegt: im Speicher der API, in Gotenberg
(Temp-Datei während der Umwandlung), in der Druck-API (Temp-Datei bis `lp`
sie übernommen hat), im CUPS-Spool auf CT 111 bis gedruckt ist (am 27.11.2026
lagen dort keine aufbewahrten Druckdaten, nur Auftragsköpfe), auf dc1 einen
Augenblick in der Befehlszeile von `samba-tool` (`--newpassword=…`). Beide
internen Wege sind HTTP ohne TLS im Servernetz.
