// ═══════════════════════════════════════════════════════════════════
// SICHERUNGEN — reine Logik ohne Netz und Datenbank (routes/sicherungen.js)
//
// Zwei Dinge, die die Seite sicherungen.html zeigt:
//   1. was auf dem Proxmox Backup Server liegt (je Gruppe: letzte Sicherung,
//      Alter, Grösse, Prüfung) und ob etwas älter ist als erwartet;
//   2. den Stand eines PCs im Sicherungs-System (Rosenweg/os-stationen,
//      sicherung/), gelesen aus `rosenweg-status --json` bzw.
//      /run/sichern/status.
//
// Alles hier ist ohne Seiteneffekt und wird von api/test/sicherungen.test.js
// geprüft.
// ═══════════════════════════════════════════════════════════════════

const STUNDE = 60 * 60 * 1000;

// ─── MAC-Adressen ──────────────────────────────────────────────────

/**
 * MAC in die Schreibweise der Vormerkung: klein, mit Bindestrichen
 * (aa-bb-cc-dd-ee-ff) — so heisst die Datei auf CT 135
 * (/srv/pxe/sicherung/vorgemerkt/<mac>.ipxe, iPXE ${net0/mac:hexhyp}).
 * Nimmt auch Doppelpunkte, Punkte (Cisco) und nackte 12 Hexzeichen.
 * Gibt null zurück, wenn es keine MAC ist.
 */
function macNorm(roh) {
  if (roh == null) return null;
  const hex = String(roh).trim().toLowerCase().replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  // Multicast-Bit gesetzt oder alles Null: keine Netzkarte, sondern ein Tippfehler.
  if (hex === '000000000000' || (parseInt(hex.slice(0, 2), 16) & 1)) return null;
  return hex.match(/../g).join('-');
}

/** aa-bb-… -> aa:bb:… (so meldet UniFi die Clients). */
function macDoppelpunkt(mac) {
  const m = macNorm(mac);
  return m ? m.replace(/-/g, ':') : null;
}

// ─── Kennung und VM-Nummer ─────────────────────────────────────────

/**
 * Kennung für `sichern --id` aus dem Rechnernamen: klein, nur das, was PBS
 * in einer Backup-ID erlaubt (sichern prüft ^[A-Za-z0-9_][A-Za-z0-9._-]*$).
 * „R9-PC1“ -> „r9-pc1“.
 */
function sicherungsId(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9_]+/, '').replace(/-+$/, '')
    .slice(0, 48);
  return /^[a-z0-9_][a-z0-9._-]*$/.test(s) ? s : null;
}

const VMID_AB = 9001;
const VMID_BIS = 9999;

/**
 * Die kleinste VM-Nummer ab 9001, die weder im Cluster noch als PC-Sicherung
 * noch als Zuordnung eines anderen PCs vergeben ist. Feste hohe Nummern je
 * PC (sicherung/README.md): gäbe es die Nummer als VM, stünde die Sicherung
 * in deren Reiter „Backup“.
 */
function naechsteVmid(belegt, ab = VMID_AB, bis = VMID_BIS) {
  const b = new Set([...belegt].map(Number));
  for (let n = ab; n <= bis; n++) if (!b.has(n)) return n;
  return null;
}

// ─── Status des Sicherungs-Systems ─────────────────────────────────

const ZUSTAENDE = ['wartet', 'laeuft', 'erfolg', 'nicht_in_ordnung', 'fehler'];
const ENDZUSTAENDE = ['erfolg', 'nicht_in_ordnung', 'fehler'];

/** /run/sichern/status (key=value je Zeile) -> Objekt. */
function statusKvParsen(text) {
  const o = {};
  for (const zeile of String(text || '').split('\n')) {
    const i = zeile.indexOf('=');
    if (i <= 0) continue;
    const k = zeile.slice(0, i).trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(k)) continue;
    o[k] = zeile.slice(i + 1).trim();
  }
  return o;
}

const zahl = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (v, max = 300) => (v == null ? '' : String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max));

/**
 * Antwort der Statusabfrage über SSH vereinheitlichen. Die Abfrage gibt
 * entweder das JSON von `rosenweg-status --json` aus oder — auf einem älteren
 * Abbild ohne rosenweg-status — eine Zeile „#kv“ und danach den Inhalt von
 * /run/sichern/status. Fehlt die Datei, wartet das System auf den Start.
 *
 * Ergebnis (alles, was die Seite braucht, und nichts sonst):
 *   { zustand, rechner, ipv4[], platten[{name,groesse,modell,nur_gelesen}],
 *     id, snapshot, grund, schritt:{nr,zahl,name}, promille, rest_s, stand }
 */
function liveStatus(roh) {
  const s = String(roh || '').trim();
  let j = null;
  if (s.startsWith('{')) {
    try { j = JSON.parse(s); } catch { j = null; }
  }
  if (j && typeof j === 'object') {
    const zustand = ZUSTAENDE.includes(j.zustand) ? j.zustand : 'wartet';
    return {
      zustand,
      rechner: text(j.rechner, 80),
      ipv4: Array.isArray(j.ipv4) ? j.ipv4.slice(0, 4).map((x) => text(x, 64)) : [],
      platten: Array.isArray(j.platten) ? j.platten.slice(0, 16).map((p) => ({
        name: text(p.name, 40), groesse: zahl(p.groesse), modell: text(p.modell, 80), nur_gelesen: p.nur_gelesen === true,
      })) : [],
      id: text(j.id, 80),
      snapshot: text(j.snapshot, 120),
      grund: text(j.grund, 500),
      schritt: {
        nr: zahl(j.schritt?.nr), zahl: zahl(j.schritt?.zahl), name: text(j.schritt?.name, 120),
      },
      promille: zahl(j.gesamt?.promille),
      rest_s: zahl(j.gesamt?.rest),
      stand: zahl(j.stand),
    };
  }
  const kv = statusKvParsen(s.replace(/^#kv\s*\n?/, ''));
  const zustand = ZUSTAENDE.includes(kv.zustand) ? kv.zustand : 'wartet';
  const nr = zahl(kv.schritt_nr);
  const anz = zahl(kv.schritt_zahl);
  // Ohne rosenweg-status gibt es keinen Lesezähler; gezählt werden dann nur
  // die abgeschlossenen Schritte.
  let promille = null;
  if (zustand === 'erfolg') promille = 1000;
  else if (nr && anz) promille = Math.round(((nr - 1) / anz) * 1000);
  return {
    zustand,
    rechner: '',
    ipv4: [],
    platten: (kv.platten || '').split(/\s+/).filter(Boolean).slice(0, 16)
      .map((n) => ({ name: text(n, 40), groesse: null, modell: '', nur_gelesen: null })),
    id: text(kv.id, 80),
    snapshot: text(kv.snapshot, 120),
    grund: text(kv.grund, 500),
    schritt: { nr, zahl: anz, name: text(kv.schritt_name, 120) },
    promille,
    rest_s: null,
    stand: zahl(kv.stand),
  };
}

// ─── PBS: Erwartungen und Gruppen ──────────────────────────────────

/**
 * „Rosenweg9/pc=0,*=36“ -> [{ns:'Rosenweg9/pc', stunden:0}, {ns:'*', stunden:36}].
 * 0 heisst: keine Altersgrenze (PC-Abbilder entstehen einmalig).
 */
function erwartungenParsen(roh) {
  const liste = [];
  for (const teil of String(roh || '').split(',')) {
    const i = teil.indexOf('=');
    if (i <= 0) continue;
    const ns = teil.slice(0, i).trim();
    const stunden = Number(teil.slice(i + 1).trim());
    if (!ns || !Number.isFinite(stunden) || stunden < 0) continue;
    liste.push({ ns, stunden });
  }
  return liste;
}

/** Stunden für einen Namespace: genauer Eintrag vor „*“; ohne Eintrag null. */
function erwartungFuer(ns, liste) {
  const genau = liste.find((e) => e.ns === ns);
  if (genau) return genau.stunden;
  const stern = liste.find((e) => e.ns === '*');
  return stern ? stern.stunden : null;
}

/**
 * Startzeit aus einer PBS-UPID. Die Prüfung (verification.upid) sagt so, wann
 * zuletzt geprüft wurde.
 * UPID:<node>:<pid>:<pstart>:<task_id>:<starttime hex>:<typ>:<id>:<user>:
 */
function upidZeit(upid) {
  const t = String(upid || '').split(':');
  if (t[0] !== 'UPID' || t.length < 7 || !/^[0-9A-Fa-f]{8}$/.test(t[5])) return null;
  return new Date(parseInt(t[5], 16) * 1000);
}

/**
 * Snapshots eines Namespaces (GET /admin/datastore/<ds>/snapshots?ns=…) zu
 * Gruppen zusammenfassen: je backup-type/backup-id die neueste Sicherung.
 *
 * cluster: Map vmid -> {name, type, status} aus /cluster/resources; für vm-
 * und ct-Gruppen gibt es den Namen dazu, und eine Gruppe, deren VM es nicht
 * mehr gibt, bekommt keine Altersmeldung (sie wird nie wieder neu).
 */
function gruppenAusSnapshots(snapshots, { ns = '', stunden = null, cluster = null, jetzt = new Date() } = {}) {
  const gruppen = new Map();
  for (const s of snapshots || []) {
    const typ = s['backup-type'];
    const id = String(s['backup-id'] ?? '');
    const zeit = Number(s['backup-time']);
    if (!typ || !id || !Number.isFinite(zeit)) continue;
    const key = `${typ}/${id}`;
    let g = gruppen.get(key);
    if (!g) {
      g = { typ, id, anzahl: 0, letzte: null };
      gruppen.set(key, g);
    }
    g.anzahl++;
    if (!g.letzte || zeit > g.letzte['backup-time']) g.letzte = s;
  }

  const raus = [];
  for (const g of gruppen.values()) {
    const s = g.letzte;
    const zeit = new Date(s['backup-time'] * 1000);
    const alterStunden = (jetzt - zeit) / STUNDE;
    const ver = s.verification || null;
    const pruefung = ver?.state === 'ok' ? 'ok' : ver?.state === 'failed' ? 'fehler' : 'offen';
    const geprueftAm = ver ? upidZeit(ver.upid) : null;
    const vm = (g.typ === 'vm' || g.typ === 'ct') && cluster ? cluster.get(Number(g.id)) : null;
    const imCluster = (g.typ === 'vm' || g.typ === 'ct') && cluster ? Boolean(vm) : null;

    let warnung = null;
    if (pruefung === 'fehler') warnung = 'Prüfung fehlgeschlagen';
    else if (stunden && alterStunden > stunden && imCluster !== false) {
      warnung = `älter als ${stunden} h`;
    }
    raus.push({
      ns,
      typ: g.typ,
      id: g.id,
      name: vm?.name || null,
      im_cluster: imCluster,
      anzahl: g.anzahl,
      letzte: zeit.toISOString(),
      alter_stunden: Math.round(alterStunden * 10) / 10,
      groesse: Number.isFinite(Number(s.size)) ? Number(s.size) : null,
      pruefung,
      geprueft_am: geprueftAm ? geprueftAm.toISOString() : null,
      notiz: s.comment ? text(s.comment, 200) : null,
      geschuetzt: Boolean(s.protected),
      warnung,
    });
  }
  // Warnungen zuerst, dann nach Typ und Nummer/Name.
  raus.sort((a, b) => (Boolean(b.warnung) - Boolean(a.warnung))
    || a.typ.localeCompare(b.typ)
    || (Number(a.id) - Number(b.id)) || a.id.localeCompare(b.id));
  return raus;
}

/**
 * VMs und CTs des Clusters, die in keinem Namespace eine Sicherung haben.
 * Vorlagen zählen nicht; sie ändern sich nicht und werden oft bewusst nicht
 * gesichert.
 */
function ohneSicherung(cluster, gruppen) {
  const gesichert = new Set(gruppen.filter((g) => g.typ === 'vm' || g.typ === 'ct').map((g) => Number(g.id)));
  const raus = [];
  for (const [vmid, r] of cluster || []) {
    if (r.template) continue;
    if (!gesichert.has(vmid)) raus.push({ vmid, name: r.name || null, typ: r.type === 'lxc' ? 'ct' : 'vm', status: r.status || null });
  }
  return raus.sort((a, b) => a.vmid - b.vmid);
}

// ─── Shell ─────────────────────────────────────────────────────────

/** Ein Wort für die Gegenseite einer SSH-Verbindung (POSIX-sh). */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  macNorm, macDoppelpunkt, sicherungsId, naechsteVmid, VMID_AB, VMID_BIS,
  ZUSTAENDE, ENDZUSTAENDE, statusKvParsen, liveStatus,
  erwartungenParsen, erwartungFuer, upidZeit, gruppenAusSnapshots, ohneSicherung,
  shQuote,
};
