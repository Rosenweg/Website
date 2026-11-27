// NOC-Sicht auf die Server (Abschnitt „Server" in js/noc-cockpit.js):
// Proxmox-Cluster (Knoten, Quorum, HA, Ceph, SSD-Abnutzung, Gäste) und PBS
// (Belegung, Jobs, letzte Sicherung je Gast, fehlgeschlagene Aufgaben).
//
// Hier steht nur die Auswertung — reine Funktionen über den Antworten der
// PVE- und PBS-API, damit sie ohne Cluster prüfbar sind (api/test/
// nocserver.test.js). Das Holen steht in routes/nocserver.js.
//
// Ampel überall: 'gruen' | 'gelb' | 'rot' | 'grau' (nicht eingerichtet /
// keine Daten). Jede gelbe oder rote Stelle bringt einen Grund mit, der im
// NOC steht — eine Lampe ohne Grund schickt jemanden suchen.

const RANG = { grau: 0, gruen: 1, gelb: 2, rot: 3 };
const schlimmer = (...a) => a.reduce((x, y) => (RANG[y] > RANG[x] ? y : x), 'gruen');
const zahl = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const prozent = (teil, ganz) => (zahl(teil) !== null && zahl(ganz) ? Math.round((teil / ganz) * 1000) / 10 : null);
const kurz = (v, n = 120) => (v == null ? null : String(v).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n));

// Schwellen, über die Umgebung verstellbar (routes/nocserver.js reicht sie durch).
const STANDARD = {
  cpuGelb: 90,          // % CPU eines Knotens
  ramGelb: 90,          // % RAM eines Knotens
  ssdGelb: 80,          // % „Percentage Used" (SMART) einer SSD
  ssdRot: 90,
  speicherGelb: 80,     // % Belegung Datastore / Ceph
  speicherRot: 90,
  vollTageGelb: 60,     // PBS schätzt „voll in n Tagen"
  sicherungStunden: 36, // letzte Sicherung eines Gasts älter -> gelb
};

// ─── Proxmox VE ────────────────────────────────────────────────────

/**
 * Proxmox meldet bei SSDs `wearout` als RESTLEBEN in Prozent (100 = neu);
 * die GUI zeigt 100 - wearout. SMART „Percentage Used" 94 % kommt hier also
 * als wearout 6 an (geprüft an pve1, Samsung 980, 27.11.2026).
 */
function ssdVerbraucht(disk) {
  const w = zahl(disk?.wearout);
  return w === null ? null : Math.max(0, Math.min(100, 100 - w));
}

function istOsd(d) {
  if (zahl(d?.osdid) !== null && Number(d.osdid) >= 0) return true;
  return Array.isArray(d?.['osdid-list']) && d['osdid-list'].length > 0;
}

/**
 * @param {object} roh
 *   status      GET /cluster/status
 *   knoten      GET /cluster/resources?type=node
 *   knotenInfo  { pve1: GET /nodes/pve1/status, … }
 *   ha          GET /cluster/ha/status/current
 *   ceph        GET /cluster/ceph/status (oder null)
 *   disks       { pve1: GET /nodes/pve1/disks/list, … }
 *   gaeste      GET /cluster/resources?type=vm
 *   onboot      { vmid: true|false } — nur für nicht laufende Gäste gelesen
 */
function pveAuswerten(roh, opts = {}) {
  const o = { ...STANDARD, ...opts };
  const status = Array.isArray(roh.status) ? roh.status : [];
  const cluster = status.find((s) => s.type === 'cluster') || null;
  const nodes = Array.isArray(roh.knoten) ? roh.knoten : [];
  const info = roh.knotenInfo || {};
  const haListe = Array.isArray(roh.ha) ? roh.ha : [];
  const gaeste = (Array.isArray(roh.gaeste) ? roh.gaeste : []).filter((g) => !g.template);

  // Knoten: aus /cluster/status (online) und /cluster/resources (Last).
  const namen = new Set([
    ...status.filter((s) => s.type === 'node').map((s) => s.name),
    ...nodes.map((n) => n.node),
  ].filter(Boolean));
  const knoten = [...namen].sort().map((name) => {
    const st = status.find((s) => s.type === 'node' && s.name === name) || {};
    const r = nodes.find((n) => n.node === name) || {};
    const ni = info[name] || {};
    const online = st.online !== undefined ? Number(st.online) === 1 : r.status === 'online';
    const cpu = zahl(r.cpu) !== null ? Math.round(r.cpu * 1000) / 10 : null;
    const ram = prozent(r.mem, r.maxmem);
    const last = Array.isArray(ni.loadavg) ? zahl(ni.loadavg[0]) : null;
    const lrm = haListe.find((h) => h.type === 'lrm' && h.node === name);
    const lrmText = lrm ? String(lrm.status || '').replace(/^\S+\s*\(/, '').split(',')[0].replace(/\)$/, '') : null;
    const g = gaeste.filter((x) => x.node === name);
    const gruende = [];
    let ampel = 'gruen';
    if (!online) { ampel = 'rot'; gruende.push('offline'); }
    else {
      if (cpu !== null && cpu >= o.cpuGelb) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`CPU ${cpu} %`); }
      if (ram !== null && ram >= o.ramGelb) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`RAM ${ram} %`); }
      if (last !== null && r.maxcpu && last > r.maxcpu) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`Last ${last}`); }
      if (lrmText && !/^(active|idle)/.test(lrmText)) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`HA-LRM ${lrmText}`); }
    }
    return {
      name: kurz(name, 40), online, ampel, gruende,
      cpu, ram, last, kerne: zahl(r.maxcpu),
      ram_gesamt: zahl(r.maxmem), uptime_s: online ? zahl(r.uptime ?? ni.uptime) : null,
      ha_lrm: lrmText ? kurz(lrmText, 40) : null,
      gaeste_laufend: g.filter((x) => x.status === 'running').length,
      gaeste_gesamt: g.length,
    };
  });

  // Quorum
  const quorate = cluster ? Number(cluster.quorate) === 1 : null;
  const quorum = {
    quorate, knoten: zahl(cluster?.nodes), online: knoten.filter((k) => k.online).length,
    ampel: quorate === null ? 'grau' : quorate ? 'gruen' : 'rot',
  };

  // HA: Master, LRMs, Ressourcen
  const master = haListe.find((h) => h.type === 'master');
  const dienste = haListe.filter((h) => h.type === 'service');
  const zaehl = (z) => dienste.filter((d) => d.state === z).length;
  const ha = {
    master: master ? kurz(master.node, 40) : null,
    master_text: master ? kurz(String(master.status || '').split(' - ')[0], 80) : null,
    dienste: dienste.length,
    started: zaehl('started'),
    stopped: zaehl('stopped'),
    fehler: dienste.filter((d) => ['error', 'fence', 'recovery'].includes(d.state))
      .map((d) => ({ sid: kurz(d.sid, 20), zustand: d.state, knoten: kurz(d.node, 40) })),
    wandernd: dienste.filter((d) => ['migrate', 'relocate', 'freeze'].includes(d.state)).length,
  };
  ha.ampel = !haListe.length ? 'grau' : ha.fehler.length ? 'rot' : (dienste.length && !master) ? 'gelb' : 'gruen';
  ha.gruende = [
    ...ha.fehler.map((f) => `${f.sid} ${f.zustand}`),
    ...(dienste.length && !master ? ['kein HA-Master'] : []),
  ];

  // Ceph
  let ceph = { ampel: 'grau', status: null, pruefungen: [] };
  if (roh.ceph && roh.ceph.health) {
    const h = roh.ceph.health;
    const pruefungen = Object.entries(h.checks || {}).map(([name, c]) => ({
      name: kurz(name, 60),
      stufe: c.severity === 'HEALTH_ERR' ? 'rot' : 'gelb',
      text: kurz(c.summary?.message, 160),
      stumm: Boolean(c.muted),
    })).sort((a, b) => RANG[b.stufe] - RANG[a.stufe] || a.name.localeCompare(b.name));
    const pg = roh.ceph.pgmap || {};
    const om = roh.ceph.osdmap || {};
    const belegt = prozent(pg.bytes_used, pg.bytes_total);
    ceph = {
      status: kurz(h.status, 20),
      ampel: h.status === 'HEALTH_OK' ? 'gruen' : h.status === 'HEALTH_ERR' ? 'rot' : 'gelb',
      pruefungen,
      osd: { gesamt: zahl(om.num_osds), up: zahl(om.num_up_osds), in: zahl(om.num_in_osds) },
      belegt_prozent: belegt,
      belegt_bytes: zahl(pg.bytes_used),
      gesamt_bytes: zahl(pg.bytes_total),
    };
    if (ceph.osd.gesamt && ceph.osd.up !== null && ceph.osd.up < ceph.osd.gesamt) ceph.ampel = schlimmer(ceph.ampel, 'gelb');
    if (belegt !== null && belegt >= o.speicherRot) ceph.ampel = 'rot';
    else if (belegt !== null && belegt >= o.speicherGelb) ceph.ampel = schlimmer(ceph.ampel, 'gelb');
  }

  // SSD-Abnutzung: alle Platten mit wearout, OSDs zuerst.
  const ssd = [];
  for (const [kn, liste] of Object.entries(roh.disks || {})) {
    for (const d of Array.isArray(liste) ? liste : []) {
      const verbraucht = ssdVerbraucht(d);
      const gesund = d.health ? /^(PASSED|OK)$/i.test(String(d.health)) : null;
      if (verbraucht === null && gesund !== false) continue;
      let ampel = 'gruen';
      const gruende = [];
      if (gesund === false) { ampel = 'rot'; gruende.push('SMART ' + kurz(d.health, 20)); }
      if (verbraucht !== null && verbraucht >= o.ssdRot) { ampel = 'rot'; gruende.push(`${verbraucht} % verbraucht`); }
      else if (verbraucht !== null && verbraucht >= o.ssdGelb) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`${verbraucht} % verbraucht`); }
      ssd.push({
        knoten: kurz(kn, 40), geraet: kurz(String(d.devpath || '').replace(/^\/dev\//, ''), 30),
        modell: kurz(d.model, 40), typ: kurz(d.type, 10), osd: istOsd(d),
        osd_id: istOsd(d) ? zahl(d.osdid) : null, verbraucht, gesund, ampel, gruende,
      });
    }
  }
  ssd.sort((a, b) => (b.osd - a.osd) || ((b.verbraucht ?? -1) - (a.verbraucht ?? -1)) || a.knoten.localeCompare(b.knoten));

  // Gäste: laufend/gestoppt; onboot=1 und nicht laufend = Warnung.
  const onboot = roh.onboot || {};
  const sollLaufen = gaeste
    .filter((g) => g.status !== 'running' && onboot[g.vmid] === true)
    .map((g) => ({ vmid: zahl(g.vmid), name: kurz(g.name, 40), typ: g.type === 'lxc' ? 'ct' : 'vm', knoten: kurz(g.node, 40), status: kurz(g.status, 20) }))
    .sort((a, b) => a.vmid - b.vmid);
  const gast = {
    gesamt: gaeste.length,
    laufend: gaeste.filter((g) => g.status === 'running').length,
    gestoppt: gaeste.filter((g) => g.status === 'stopped').length,
    soll_laufen: sollLaufen,
    ampel: sollLaufen.length ? 'gelb' : gaeste.length ? 'gruen' : 'grau',
  };

  const ssdAmpel = ssd.length ? ssd.reduce((a, s) => schlimmer(a, s.ampel), 'gruen') : 'grau';
  const ampel = schlimmer(
    ...knoten.map((k) => k.ampel), quorum.ampel === 'grau' ? 'gruen' : quorum.ampel,
    ha.ampel === 'grau' ? 'gruen' : ha.ampel, ceph.ampel === 'grau' ? 'gruen' : ceph.ampel,
    ssdAmpel === 'grau' ? 'gruen' : ssdAmpel, gast.ampel === 'grau' ? 'gruen' : gast.ampel,
  );
  return { ampel, knoten, quorum, ha, ceph, ssd, ssd_ampel: ssdAmpel, gaeste: gast };
}

// ─── Proxmox Backup Server ─────────────────────────────────────────

const JOB_ARTEN = { backup: 'Sicherung', verificationjob: 'Prüfung', verify: 'Prüfung', prunejob: 'Aufräumen', prune: 'Aufräumen',
  garbage_collection: 'GC', syncjob: 'Sync', 'tape-backup-job': 'Band' };

/** „ct/406" aus worker_id „storage:ct/406" bzw. „storage:vm-100" (UPID-kodiert). */
function aufgabeZiel(t) {
  const w = String(t.worker_id || '');
  const m = w.match(/(?:^|:)(vm|ct|host)[/-](\d+)\b/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * @param {object} roh
 *   usage    GET /status/datastore-usage
 *   gc       GET /admin/gc
 *   verify   GET /admin/verify
 *   prune    GET /admin/prune
 *   sync     GET /admin/sync (darf fehlen)
 *   tasks    GET /nodes/localhost/tasks?errors=1&since=… (nur Fehler)
 *   gruppen  Gruppen aus lib/sicherungen.gruppenAusSnapshots (alle Namespaces)
 *   ohne     VMs/CTs ohne Sicherung (lib/sicherungen.ohneSicherung)
 *   namespaces  welche Namespaces das NOC zeigt (Präfixe; Standard Rosenweg9)
 *   jetzt    ms
 */
function pbsAuswerten(roh, opts = {}) {
  const o = { ...STANDARD, ...opts };
  const jetzt = roh.jetzt ?? Date.now();
  const nsErlaubt = (ns) => (roh.namespaces || ['Rosenweg9'])
    .some((p) => p === '*' || ns === p || String(ns || '').startsWith(p + '/'));

  const datastores = (Array.isArray(roh.usage) ? roh.usage : []).map((d) => {
    const belegt = prozent(d.used, d.total);
    const voll = zahl(d['estimated-full-date']);
    const tageBisVoll = voll && voll > 0 ? Math.round((voll * 1000 - jetzt) / 86400000) : null;
    const gruende = [];
    let ampel = d.error ? 'rot' : 'gruen';
    if (d.error) gruende.push(kurz(d.error, 120));
    if (belegt !== null && belegt >= o.speicherRot) { ampel = 'rot'; gruende.push(`${belegt} % belegt`); }
    else if (belegt !== null && belegt >= o.speicherGelb) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`${belegt} % belegt`); }
    if (tageBisVoll !== null && tageBisVoll >= 0 && tageBisVoll < o.vollTageGelb) { ampel = schlimmer(ampel, 'gelb'); gruende.push(`voll in ~${tageBisVoll} Tagen`); }
    return { name: kurz(d.store, 40), belegt_prozent: belegt, belegt_bytes: zahl(d.used), gesamt_bytes: zahl(d.total), tage_bis_voll: tageBisVoll, ampel, gruende };
  });

  // Jobs: GC je Datastore, Prüf-/Aufräum-/Sync-Jobs. Namespace nur nennen,
  // wenn er gezeigt werden darf (es gibt private Namespaces mit Familiennamen).
  const jobs = [];
  const job = (art, j) => {
    const ns = j.ns ?? null;
    const zeigen = ns === null || ns === '' || nsErlaubt(ns);
    const zustand = j['last-run-state'] ? String(j['last-run-state']) : null;
    const ok = zustand === null ? null : zustand === 'OK' || /^WARNINGS/.test(zustand);
    jobs.push({
      art, store: kurz(j.store, 40), ns: zeigen ? kurz(ns || '(Wurzel)', 60) : 'privat',
      zuletzt: zahl(j['last-run-endtime']) ? new Date(j['last-run-endtime'] * 1000).toISOString() : null,
      naechste: zahl(j['next-run']) ? new Date(j['next-run'] * 1000).toISOString() : null,
      zustand: zustand ? kurz(zustand, 80) : 'noch nie',
      ampel: ok === null ? 'grau' : ok ? (/^WARNINGS/.test(zustand) ? 'gelb' : 'gruen') : 'rot',
    });
  };
  for (const j of roh.gc || []) job('GC', j);
  for (const j of roh.verify || []) job('Prüfung', j);
  for (const j of roh.prune || []) job('Aufräumen', j);
  for (const j of roh.sync || []) job('Sync', j);

  // Fehlgeschlagene Aufgaben (24 h) der Arten, die zählen — „reader" (Dateien
  // ansehen, Wiederherstellen) und apt nicht.
  const fehlgeschlagen = (Array.isArray(roh.tasks) ? roh.tasks : [])
    .filter((t) => JOB_ARTEN[t.worker_type] && t.status && t.status !== 'OK' && !/^WARNINGS/.test(t.status))
    .map((t) => ({
      art: JOB_ARTEN[t.worker_type], ziel: aufgabeZiel(t),
      zeit: zahl(t.endtime || t.starttime) ? new Date((t.endtime || t.starttime) * 1000).toISOString() : null,
      text: kurz(t.status, 120),
    }))
    .sort((a, b) => String(b.zeit).localeCompare(String(a.zeit)));

  // Sicherungen je Gast: nur VMs/CTs aus gezeigten Namespaces, die es im
  // Cluster gibt — mit Namen aus dem Cluster, nie mit Host-/PC-Kennungen.
  const gruppen = (roh.gruppen || []).filter((g) => (g.typ === 'vm' || g.typ === 'ct') && nsErlaubt(g.ns) && g.im_cluster === true);
  const jeGast = new Map();
  for (const g of gruppen) {
    const k = `${g.typ}/${g.id}`;
    const alt = jeGast.get(k);
    if (!alt || g.alter_stunden < alt.alter_stunden) jeGast.set(k, g);
  }
  const zuAlt = [...jeGast.values()]
    .filter((g) => g.alter_stunden > o.sicherungStunden || g.pruefung === 'fehler')
    .map((g) => ({ gast: `${g.typ}/${g.id}`, name: kurz(g.name, 40), alter_stunden: g.alter_stunden,
      grund: g.pruefung === 'fehler' ? 'Prüfung fehlgeschlagen' : `${Math.round(g.alter_stunden)} h alt` }))
    .sort((a, b) => b.alter_stunden - a.alter_stunden);
  const juengste = [...jeGast.values()].reduce((m, g) => (m === null || g.alter_stunden < m ? g.alter_stunden : m), null);
  const sicherungen = {
    gaeste: jeGast.size,
    zu_alt: zuAlt,
    ohne: (roh.ohne || []).map((v) => ({ gast: `${v.typ}/${v.vmid}`, name: kurz(v.name, 40) })),
    juengste_stunden: juengste,
    andere_gruppen: (roh.gruppen || []).length - gruppen.length,
    ampel: zuAlt.length ? 'gelb' : jeGast.size ? 'gruen' : 'grau',
  };

  const ampel = schlimmer(
    ...datastores.map((d) => d.ampel),
    ...jobs.map((j) => (j.ampel === 'grau' ? 'gruen' : j.ampel)),
    fehlgeschlagen.length ? 'gelb' : 'gruen',
    sicherungen.ampel === 'grau' ? 'gruen' : sicherungen.ampel,
  );
  return { ampel, datastores, jobs, fehlgeschlagen, sicherungen };
}

// Anonyme Wandbild-Sicht (NOC_PUBLIC_OPEN ohne Token): Zustände und Zahlen,
// keine Gast-Namen, keine Modelle, keine Fehlertexte mit Zielen.
function serverOeffentlich(out) {
  const o = JSON.parse(JSON.stringify(out || {}));
  if (o.pve) {
    if (o.pve.gaeste) o.pve.gaeste.soll_laufen = o.pve.gaeste.soll_laufen.map((g, i) => ({ vmid: null, name: 'Gast ' + (i + 1), typ: g.typ }));
    if (o.pve.ha) o.pve.ha.fehler = o.pve.ha.fehler.map((f) => ({ sid: null, zustand: f.zustand, knoten: f.knoten }));
    for (const s of o.pve.ssd || []) s.modell = null;
  }
  if (o.pbs) {
    if (o.pbs.sicherungen) {
      o.pbs.sicherungen.zu_alt = o.pbs.sicherungen.zu_alt.map((g, i) => ({ gast: 'Gast ' + (i + 1), name: null, alter_stunden: g.alter_stunden, grund: g.grund }));
      o.pbs.sicherungen.ohne = o.pbs.sicherungen.ohne.map((_, i) => ({ gast: 'Gast ' + (i + 1), name: null }));
    }
    o.pbs.fehlgeschlagen = (o.pbs.fehlgeschlagen || []).map((f) => ({ art: f.art, ziel: null, zeit: f.zeit, text: null }));
    for (const j of o.pbs.jobs || []) j.ns = null;
  }
  return o;
}

module.exports = { pveAuswerten, pbsAuswerten, serverOeffentlich, ssdVerbraucht, aufgabeZiel, STANDARD };
