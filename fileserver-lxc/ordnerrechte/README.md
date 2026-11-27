# Ordnerrechte der Freigabe `dokumente`

Auf den Linux-Stationen (`~/dokumente`) und unter Windows (Laufwerk D:) soll
jede Person nur die Ordner sehen und öffnen, die ihr auch die Website zeigt.
Bis jetzt war das nicht so: Die ganze Ablage steht auf `775`/`664` mit Gruppe
`rosenweg`, und `valid users = @rosenweg` lässt jede angemeldete Person alles
lesen — die Belege der Auslagen, die Brief-Fotos mit Adressen, die Ordner der
anderen STWEGs. Die Website prüft das sorgfältig, die Freigabe gar nicht.

## Woher die Regeln kommen

Nicht neu erfunden, sondern aus der Website abgeschrieben:

- `api/server.js`: `isDocPathAllowed`, `canWriteDocPath`, `DOC_SPERR_ORDNER`,
  `DOC_AUSSCHUSS_ORDNER`
- `api/lib/groups.js`: `STWEG_GROUPS` — STWEG 3 = `r9-*`, STWEG 6 = `r1-*`,
  STWEG 8 = `meg-*` (Ordner `meg`, übergangsweise auch `stweg8`)

| Ordner | lesen | schreiben |
|---|---|---|
| Wurzel und Dateien darin | alle (`rosenweg`) | nur Technik/Präsident |
| `allgemein`, `Scans` | alle | jeder Ausschuss bzw. der Scanner |
| `stwegN`, `meg` | Bewohner, Eigentümer, Ausschuss und Hausverwaltung (`stwegN-verwaltung`, `meg-verwaltung`) der STWEG | Ausschuss der STWEG |
| `projekte` (gibt es noch nicht) | alle Eigentümer | jeder Ausschuss |
| Sperrordner (`auslagen`, `anzeigen`, `reklamationen`, `unterschriftenlisten`, `grundbuch-bilder`, `druckauftraege`) auf Ebene 1 oder 2 | nur Technik/Präsident | dito |
| `fotos_von_versendeten_briefen` | Ausschuss | Ausschuss |
| alle anderen Ordner der obersten Ebene | nur Technik/Präsident | dito |

Technik, Präsident und das Dienstkonto `api-svc` haben überall lesen und
schreiben. Die genaue Fassung steht in [`tabelle.txt`](tabelle.txt) — **ändert
sich eine der Funktionen oben, muss die Tabelle mit**.

Bewusste Vereinfachungen gegenüber der Website:

- Brief-Fotos: Die Website verlangt „irgendein Ausschuss **und** Zugriff auf
  den Elternordner“. Eine ACL kann keine Schnittmenge; den Elternordner deckt
  aber schon das Durchgangsrecht ab. Schreiben darf hier jeder Ausschuss, der
  hineinkommt, nicht nur der eigene.
- Neue Ordner in der Wurzel erben „alle lesen“ (wie Dateien der Wurzel auf der
  Website). Ein neuer Ordner der obersten Ebene, der geschützt sein soll, muss
  in die Tabelle und das Skript neu laufen.

## Warum so gebaut

- **POSIX-ACLs auf dem CephFS**, nicht Samba-eigene Rechte: Sie gelten für jeden
  Weg aufs CephFS gleich — beide Fileserver, und auch die API (CT 128 hängt
  das CephFS direkt ein). Default-ACLs sorgen dafür, dass neue Dateien und
  Ordner die Rechte des Elternordners bekommen, egal wer sie anlegt.
- **Numerische IDs** statt Namen: Auf CT 106 gibt es eine lokale Gruppe
  `rosenweg` (gid 1000) und ein lokales Konto `scanner` (uid 999, FTP), die
  vor winbind gefunden werden. `anwenden.sh` löst jeden Namen über `wbinfo`
  auf; wer nicht auflösbar ist, wird weggelassen und gemeldet (gibt weniger
  Rechte, nie mehr).
- **`g::---` und `o::---`**: Die besitzende Gruppe ist überall `rosenweg`,
  also alle. Sie darf deshalb über die Grundrechte nichts mehr; Zugriff gibt
  es nur noch über die benannten Einträge.
- **`.git`, `.github`, `.claude`, `.recycle`** fasst das Skript nie an. Die
  ersten drei stehen schon auf `700`.

Samba braucht dazu in [dokumente]:

```ini
   hide unreadable = yes     # was man nicht lesen darf, sieht man nicht
   map acl inherit = yes
   recycle:directory_mode = 0700
```

**Ohne `inherit acls`** (Entscheid 22.11.2026): Damit baut Samba die ACL neuer
Dateien über NT-Vererbung selbst und schreibt jede Gruppe zusätzlich als
`user:`-Eintrag (idmap `rid` bildet jede SID auf uid und gid ab), dazu das
x-Bit auf Dateien. Ohne die Option übernimmt der Kernel die Default-ACL des
Ordners — sauber, und gleich wie bei der API und bei root.

**Papierkorb:** `/mnt/cephfs-stage/.recycle` vorher von Hand anlegen,
`root:rosenweg`, Modus `1733`, ohne ACL (`setfacl -b`). Sonst kann ihn nach
dem Ausrollen niemand mehr anlegen (Wurzel nur lesen). Jeder legt darin seinen
Ordner an (0700), fremde sieht man nicht; `.recycle` ist unsichtbar, der eigene
Ordner direkt erreichbar (`\\files…\dokumente\.recycle\<konto>`). **CT 106 und CT 206 müssen
die gleiche smb.conf haben** (bis auf `server string`), sonst sieht man je nach
Server, der gerade die Clusteradresse hält, etwas anderes.

## Ablauf

Auf dem Fileserver als root (CT 106 auf pve2 oder CT 206 auf pve1 — gleiches
CephFS, einmal reicht):

```bash
# Skripte hinbringen
tar c ordnerrechte | ssh stefan.mueller@100.64.2.21 "sudo pct exec 106 -- tar x -C /root"

cd /root/ordnerrechte
./sichern.sh  --wurzel /mnt/cephfs-stage                 # getfacl, Rechte 600, lokal
./anwenden.sh --tabelle tabelle.txt --wurzel /mnt/cephfs-stage --trocken
./anwenden.sh --tabelle tabelle.txt --wurzel /mnt/cephfs-stage
# oder schrittweise, z. B. --nur dump,template,archiv,vorlagen
# dann --nur stweg1,…,stweg8,meg, dann --nur allgemein,Scans, zuletzt --nur /
# Rueckweg:
./zurueck.sh /root/ordnerrechte-sicherung/acl-cephfs-stage-….txt [--trocken]
```

Die Sicherung liegt in `/root/ordnerrechte-sicherung/` im Container, nicht im
CephFS (sonst wäre sie über die Freigabe sichtbar). Danach auf den anderen
Fileserver kopieren.

## Probelauf 22.11.2026

Erster Durchgang noch mit `inherit acls`, zweiter ohne (siehe unten).
Auf `/mnt/cephfs-stage/_acltest/` mit `alle`, `stweg5`, `gesperrt` und
[`tabelle-probelauf.txt`](tabelle-probelauf.txt); smb.conf auf 106 und 206
geändert (Sicherung `smb.conf.vor-ordnerrechte-2026-11-22`). Testkonto
`acltest`, nur im AD, in `rosenweg` und `stweg5-bewohner`. Der
Authentik-Sync (`/opt/ad-sync/sync.py` auf dc1) geht nur die Authentik-Konten
durch und legt an/sperrt/entsperrt; reine AD-Konten fasst er nicht an.

| Prüfung | CT 106 | CT 206 | win11-1 |
|---|---|---|---|
| Bewohner sieht `alle`, `stweg5`, liest die Dateien | ja | ja | ja |
| Bewohner sieht `gesperrt` nicht, Datei direkt holen verweigert | ja | ja | ja (nicht gefunden) |
| Bewohner kann in `stweg5`, `alle`, Wurzel nicht schreiben | ja | ja | ja |
| `.git` in der Wurzel unsichtbar | ja | ja | – |
| Ausschuss (vorübergehend) schreibt in `stweg5`/`alle`, nicht in `gesperrt` | ja | – | – |
| `api-svc` liest und schreibt überall (POSIX, `runuser`) | ja | gleiches CephFS | – |
| Neue Dateien/Ordner erben die ACL (Samba, api-svc, root mit umask 022) | ja | gleiches CephFS | – |

Zweiter Durchgang ohne `inherit acls` (CT 106 und CT 206): Dateien und
Ordner, die über Samba, als `api-svc` und als root (umask 022) entstehen,
haben alle dieselbe saubere ACL wie der Elternordner, Dateien `rw-rw----`,
Ordner mit Default-ACL. Papierkorb: als Ausschuss gelöscht, Datei unter
`.recycle/acltest/_acltest/stweg5/` wiedergefunden und zurückgeholt,
`.recycle` selbst nicht auflistbar und in der Wurzel unsichtbar.

Aufgefallen:

- `meg-bewohner` gibt es im AD nicht; die Zeile wirkt erst, wenn die Gruppe
  existiert. Sie muss in Authentik entstehen (der Sync bringt sie ins AD);
  danach `anwenden.sh --nur meg,stweg8` noch einmal.
- Neue Sperrordner, die die API später anlegt (z. B. `stweg5/reklamationen`),
  erben die Rechte der STWEG und sind nicht gesperrt, bis das Skript wieder
  läuft.
- `api-svc` mit Samba-Passwort ist nicht getestet: Die API hängt das CephFS
  seit August direkt ein und läuft als root (ACLs gelten für root nicht), die
  Freigabe `[api]` hat zurzeit keine Verbindungen.
