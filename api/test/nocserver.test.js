// node --test api/test/nocserver.test.js — NOC-Sicht auf Proxmox und PBS (lib/nocserver.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/nocserver');

// Antworten wie vom echten Cluster (27.11.2026), gekürzt.
const status = [
  { id: 'cluster', name: 'Rosenweg4303', nodes: 3, quorate: 1, type: 'cluster' },
  { id: 'node/pve1', name: 'pve1', online: 1, type: 'node' },
  { id: 'node/pve2', name: 'pve2', online: 1, type: 'node' },
  { id: 'node/pve3', name: 'pve3', online: 1, type: 'node' },
];
const knoten = [
  { node: 'pve1', status: 'online', cpu: 0.15, maxcpu: 12, mem: 23e9, maxmem: 67e9, uptime: 5506 },
  { node: 'pve2', status: 'online', cpu: 0.26, maxcpu: 12, mem: 32e9, maxmem: 67e9, uptime: 912508 },
  { node: 'pve3', status: 'online', cpu: 0.43, maxcpu: 12, mem: 23e9, maxmem: 67e9, uptime: 912500 },
];
const ha = [
  { id: 'quorum', type: 'quorum', node: 'pve1', status: 'OK' },
  { id: 'master', type: 'master', node: 'pve3', status: 'pve3 (active, Fri Nov 27 16:39:22 2026) - dynamic load CRS' },
  { id: 'lrm:pve1', type: 'lrm', node: 'pve1', status: 'pve1 (active, watchdog active, Fri Nov 27 16:39:29 2026)' },
  { id: 'lrm:pve2', type: 'lrm', node: 'pve2', status: 'pve2 (active, watchdog active, Fri Nov 27 16:39:20 2026)' },
  { id: 'lrm:pve3', type: 'lrm', node: 'pve3', status: 'pve3 (idle, Fri Nov 27 16:39:23 2026)' },
  { id: 'service:ct:100', type: 'service', sid: 'ct:100', node: 'pve1', state: 'started' },
  { id: 'service:ct:101', type: 'service', sid: 'ct:101', node: 'pve1', state: 'started' },
];
const ceph = {
  health: { status: 'HEALTH_WARN', checks: {
    BLUESTORE_SLOW_OP_ALERT: { severity: 'HEALTH_WARN', summary: { message: '3 OSD(s) experiencing slow operations in BlueStore' }, muted: false },
  } },
  pgmap: { bytes_used: 1948453494784, bytes_total: 3000609275904 },
  osdmap: { num_osds: 3, num_up_osds: 3, num_in_osds: 3 },
};
const disk = (wearout, osdid = 0, extra = {}) => ({ devpath: '/dev/nvme0n1', type: 'nvme', model: 'Samsung SSD 980 1TB', wearout, health: 'PASSED', osdid, 'osdid-list': osdid >= 0 ? [String(osdid)] : null, ...extra });
const disks = {
  pve1: [disk(6, 0), { devpath: '/dev/sda', type: 'ssd', model: 'TS240', wearout: 100, health: 'PASSED', osdid: -1 }],
  pve2: [disk(10, 1)],
  pve3: [disk(25, 2)],
};
const gaeste = [
  { vmid: 104, name: 'nextcloud', node: 'pve1', status: 'running', type: 'lxc' },
  { vmid: 128, name: 'rosenweg-core', node: 'pve2', status: 'running', type: 'lxc' },
  { vmid: 135, name: 'pxe', node: 'pve3', status: 'stopped', type: 'lxc' },
  { vmid: 200, name: 'test', node: 'pve3', status: 'stopped', type: 'qemu' },
  { vmid: 9000, name: 'vorlage', node: 'pve3', status: 'stopped', type: 'qemu', template: 1 },
];
const roh = { status, knoten, knotenInfo: { pve2: { loadavg: ['7.11', '9.02', '9.52'] } }, ha, ceph, disks, gaeste, onboot: { 135: true, 200: false } };

test('SSD: wearout ist Restleben, verbraucht = 100 - wearout', () => {
  assert.equal(N.ssdVerbraucht({ wearout: 6 }), 94);
  assert.equal(N.ssdVerbraucht({ wearout: 100 }), 0);
  assert.equal(N.ssdVerbraucht({ wearout: 'N/A' }), null);
});

test('PVE: Knoten, Quorum, HA, Last', () => {
  const p = N.pveAuswerten(roh);
  assert.deepEqual(p.knoten.map((k) => k.name), ['pve1', 'pve2', 'pve3']);
  assert.ok(p.knoten.every((k) => k.online && k.ampel === 'gruen'));
  assert.equal(p.knoten[1].last, 7.11);
  assert.equal(p.knoten[0].ha_lrm, 'active');
  assert.equal(p.knoten[2].ha_lrm, 'idle');
  assert.equal(p.quorum.ampel, 'gruen');
  assert.equal(p.ha.master, 'pve3');
  assert.equal(p.ha.started, 2);
  assert.equal(p.ha.ampel, 'gruen');
});

test('PVE: Knoten offline und kein Quorum -> rot', () => {
  const st = status.map((s) => (s.name === 'pve2' ? { ...s, online: 0 } : s.type === 'cluster' ? { ...s, quorate: 0 } : s));
  const p = N.pveAuswerten({ ...roh, status: st });
  assert.equal(p.knoten[1].ampel, 'rot');
  assert.equal(p.knoten[1].uptime_s, null);
  assert.equal(p.quorum.ampel, 'rot');
  assert.equal(p.ampel, 'rot');
});

test('PVE: HA-Ressource error/fence -> rot', () => {
  const p = N.pveAuswerten({ ...roh, ha: [...ha, { type: 'service', sid: 'vm:200', node: 'pve2', state: 'error' }] });
  assert.equal(p.ha.ampel, 'rot');
  assert.deepEqual(p.ha.gruende, ['vm:200 error']);
});

test('PVE: Ceph WARN mit Grund, ERR rot', () => {
  const p = N.pveAuswerten(roh);
  assert.equal(p.ceph.ampel, 'gelb');
  assert.equal(p.ceph.pruefungen[0].name, 'BLUESTORE_SLOW_OP_ALERT');
  assert.match(p.ceph.pruefungen[0].text, /slow operations/);
  assert.equal(p.ceph.belegt_prozent, 64.9);
  const e = N.pveAuswerten({ ...roh, ceph: { ...ceph, health: { status: 'HEALTH_ERR', checks: {} } } });
  assert.equal(e.ceph.ampel, 'rot');
});

test('PVE: SSD-Abnutzung 94 % rot, 75 % grün, OSDs zuerst', () => {
  const p = N.pveAuswerten(roh);
  const osd = p.ssd.filter((s) => s.osd);
  assert.equal(osd.length, 3);
  assert.equal(p.ssd[0].verbraucht, 94);
  assert.equal(p.ssd[0].ampel, 'rot');
  assert.equal(osd.find((s) => s.knoten === 'pve3').ampel, 'gruen');
  assert.equal(p.ssd.at(-1).osd, false);
  assert.equal(p.ssd_ampel, 'rot');
  // Schwellen verstellbar
  const q = N.pveAuswerten(roh, { ssdGelb: 90, ssdRot: 96 });
  assert.equal(q.ssd[0].ampel, 'gelb');
  // SMART nicht bestanden -> rot, auch ohne wearout
  const r = N.pveAuswerten({ ...roh, disks: { pve1: [{ devpath: '/dev/sdb', type: 'hdd', health: 'FAILED', osdid: -1 }] } });
  assert.equal(r.ssd[0].ampel, 'rot');
});

test('PVE: Gäste mit onboot=1, die nicht laufen -> gelb; Vorlagen zählen nicht', () => {
  const p = N.pveAuswerten(roh);
  assert.equal(p.gaeste.gesamt, 4);
  assert.equal(p.gaeste.laufend, 2);
  assert.deepEqual(p.gaeste.soll_laufen.map((g) => g.vmid), [135]);
  assert.equal(p.gaeste.ampel, 'gelb');
});

const JETZT = Date.parse('2026-11-27T16:00:00Z');
const s = (t) => Math.floor((JETZT - t * 3600000) / 1000);
const pbsRoh = {
  jetzt: JETZT,
  usage: [{ store: 'storage', total: 5.8e12, used: 2.67e12, avail: 3.1e12, 'estimated-full-date': s(-24 * 400) }],
  gc: [{ store: 'storage', 'last-run-state': 'OK', 'last-run-endtime': s(10), 'next-run': s(-14) }],
  verify: [
    { id: 'v1', store: 'storage', ns: 'Rosenweg9', 'last-run-state': 'OK', 'last-run-endtime': s(1) },
    { id: 'v2', store: 'storage', ns: 'Mueller', 'last-run-state': 'OK', 'last-run-endtime': s(1) },
  ],
  prune: [{ id: 'p1', store: 'storage', ns: 'Rosenweg9', 'last-run-state': 'OK', 'last-run-endtime': s(1) }],
  tasks: [
    { worker_type: 'backup', worker_id: 'storage:ct/406', status: 'connection error: connection reset', endtime: s(5) },
    { worker_type: 'reader', worker_id: 'storage:vm-9001-6B08', status: 'connection error: connection reset', endtime: s(4) },
    { worker_type: 'aptupdate', status: 'WARNINGS: 1', endtime: s(3) },
  ],
  gruppen: [
    { ns: 'Rosenweg9', typ: 'ct', id: '104', name: 'nextcloud', im_cluster: true, alter_stunden: 2, pruefung: 'ok' },
    { ns: 'Rosenweg9', typ: 'ct', id: '406', name: 'alt', im_cluster: true, alter_stunden: 50, pruefung: 'ok' },
    { ns: 'Rosenweg9', typ: 'vm', id: '300', name: 'weg', im_cluster: false, alter_stunden: 900, pruefung: 'ok' },
    { ns: 'Rosenweg9/pc', typ: 'vm', id: '9001', name: null, im_cluster: null, alter_stunden: 200, pruefung: 'ok' },
    { ns: 'Mueller', typ: 'host', id: 'privat-nas', name: null, im_cluster: null, alter_stunden: 1, pruefung: 'ok' },
  ],
  ohne: [{ vmid: 999, name: 'neu', typ: 'ct' }],
};

test('PBS: Belegung, Jobs, Fehler, Sicherungen je Gast', () => {
  const p = N.pbsAuswerten(pbsRoh);
  assert.equal(p.datastores[0].belegt_prozent, 46);
  assert.equal(p.datastores[0].ampel, 'gruen');
  assert.equal(p.jobs.length, 4);
  assert.ok(p.jobs.every((j) => j.ampel === 'gruen'));
  // privater Namespace wird nicht genannt
  assert.ok(!JSON.stringify(p).includes('Mueller'));
  assert.ok(!JSON.stringify(p).includes('privat-nas'));
  // nur die Sicherung zählt, nicht reader und apt
  assert.deepEqual(p.fehlgeschlagen.map((f) => [f.art, f.ziel]), [['Sicherung', 'ct/406']]);
  // PC-Abbild (9001) ist keine Gastsicherung, verschwundene VM 300 zählt nicht
  assert.equal(p.sicherungen.gaeste, 2);
  assert.deepEqual(p.sicherungen.zu_alt.map((g) => g.gast), ['ct/406']);
  assert.equal(p.sicherungen.ohne[0].gast, 'ct/999');
  assert.equal(p.ampel, 'gelb');
});

test('PBS: Job fehlgeschlagen -> rot, Datastore fast voll -> rot', () => {
  const p = N.pbsAuswerten({ ...pbsRoh, gc: [{ store: 'storage', 'last-run-state': 'TASK ERROR: kaputt' }], usage: [{ store: 'storage', total: 100, used: 95 }] });
  assert.equal(p.jobs[0].ampel, 'rot');
  assert.equal(p.datastores[0].ampel, 'rot');
  assert.equal(p.ampel, 'rot');
});

test('Aufgabenziel aus worker_id', () => {
  assert.equal(N.aufgabeZiel({ worker_id: 'storage:ct/406' }), 'ct/406');
  assert.equal(N.aufgabeZiel({ worker_id: 'storage:vm-100' }), 'vm/100');
  assert.equal(N.aufgabeZiel({ worker_id: null }), null);
});

test('öffentliche Sicht: keine Gastnamen, keine Fehlertexte', () => {
  const o = N.serverOeffentlich({ pve: N.pveAuswerten(roh), pbs: N.pbsAuswerten(pbsRoh) });
  const t = JSON.stringify(o);
  for (const w of ['pxe', 'Samsung', 'ct/406', 'connection reset', '"name":"alt"', 'nextcloud']) assert.ok(!t.includes(w), w);
  assert.equal(o.pve.gaeste.soll_laufen.length, 1);
  assert.equal(o.pbs.sicherungen.zu_alt.length, 1);
});

test('Ceph: stumme Altlast färbt die Ampel nicht', () => {
  const c = { ...ceph, health: { status: 'HEALTH_ERR', checks: {
    AUTH_INSECURE_SERVICE_TICKETS: { severity: 'HEALTH_ERR', summary: { message: 'insecure tickets' } },
    BLUESTORE_SLOW_OP_ALERT: ceph.health.checks.BLUESTORE_SLOW_OP_ALERT,
  } } };
  assert.equal(N.pveAuswerten({ ...roh, ceph: c }).ceph.ampel, 'rot');
  const p = N.pveAuswerten({ ...roh, ceph: c }, { cephStumm: ['AUTH_INSECURE_'] });
  assert.equal(p.ceph.ampel, 'gelb');
  assert.ok(p.ceph.pruefungen.find((x) => x.name.startsWith('AUTH')).stumm);
});

test('Ergebnisform für die Prüfmodule (infra.*, backup.*)', () => {
  const r = N.alsErgebnisse({ pve: { eingerichtet: true, ...N.pveAuswerten(roh) }, pbs: { eingerichtet: true, ...N.pbsAuswerten(pbsRoh) } });
  const nach = Object.fromEntries(r.map((x) => [x.id, x]));
  for (const x of r) {
    assert.ok(['ok', 'warn', 'crit', 'aus', 'unbekannt'].includes(x.status), x.id);
    assert.ok(x.bereich && x.titel && typeof x.text === 'string', x.id);
  }
  assert.equal(nach['infra.knoten'].status, 'ok');
  assert.equal(nach['infra.ceph'].status, 'warn');
  assert.match(nach['infra.ceph'].text, /slow operations/);
  assert.equal(nach['infra.ssd'].status, 'crit');
  assert.match(nach['infra.ssd'].text, /pve1 nvme0n1 \(osd\.0\): 94 % verbraucht/);
  assert.equal(nach['infra.autostart'].status, 'warn');
  assert.equal(nach['backup.alter'].status, 'warn');
  assert.equal(nach['backup.fehlgeschlagen'].status, 'warn');
  assert.equal(nach['backup.datastore.storage'].status, 'ok');
  // nicht eingerichtet = unbekannt, nie ok
  const leer = N.alsErgebnisse({ pve: { eingerichtet: false, fehlt: ['PVE_AUDIT_TOKEN'] }, pbs: { eingerichtet: false, fehlt: ['PBS_AUDIT_TOKEN'] } });
  assert.deepEqual(leer.map((x) => x.status), ['unbekannt', 'unbekannt']);
});
