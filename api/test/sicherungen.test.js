// node --test api/test/sicherungen.test.js — PBS-Gruppen und Stand des Sicherungs-Systems (lib/sicherungen.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sicherungen');

const jetzt = new Date('2026-11-26T12:00:00Z');
const sek = (d) => Math.floor(d.getTime() / 1000);
const vorStunden = (h) => sek(new Date(jetzt.getTime() - h * 3600 * 1000));

test('MAC: Schreibweisen und Unsinn', () => {
  assert.equal(S.macNorm('AA:BB:CC:DD:EE:FF'.replace('AA', 'A8')), 'a8-bb-cc-dd-ee-ff');
  assert.equal(S.macNorm('a8-bb-cc-dd-ee-ff'), 'a8-bb-cc-dd-ee-ff');
  assert.equal(S.macNorm('a8bb.ccdd.eeff'), 'a8-bb-cc-dd-ee-ff');
  assert.equal(S.macNorm('00:00:00:00:00:00'), null);
  assert.equal(S.macNorm('01:00:5e:00:00:01'), null); // Multicast
  assert.equal(S.macNorm('a8:bb:cc:dd:ee'), null);
  assert.equal(S.macNorm('a8:bb:cc:dd:ee:ff; rm -rf /'), null);
  assert.equal(S.macDoppelpunkt('a8-bb-cc-dd-ee-ff'), 'a8:bb:cc:dd:ee:ff');
});

test('Kennung aus dem Rechnernamen', () => {
  assert.equal(S.sicherungsId('R9-PC1'), 'r9-pc1');
  assert.equal(S.sicherungsId('Büro PC'), 'buero-pc');
  assert.equal(S.sicherungsId('---'), null);
  assert.equal(S.sicherungsId("a'b"), 'a-b');
});

test('nächste freie VM-Nummer ab 9001', () => {
  assert.equal(S.naechsteVmid(new Set([100, 101])), 9001);
  assert.equal(S.naechsteVmid(new Set([9001, 9002, 9004])), 9003);
  assert.equal(S.naechsteVmid(new Set([9001]), 9001, 9001), null);
});

test('Status aus rosenweg-status --json', () => {
  const st = S.liveStatus(JSON.stringify({
    stand: 1, zustand: 'laeuft', rechner: 'sicherung-a1b2c3', ipv4: ['100.64.9.90'],
    platten: [{ name: 'nvme0n1', groesse: 512e9, modell: 'Samsung', nur_gelesen: true }],
    id: 'r9-pc1 (VM 9001)', schritt: { nr: 4, zahl: 7, name: 'Sicherung auf den PBS' },
    gesamt: { promille: 412, rest: 3600 },
  }));
  assert.equal(st.zustand, 'laeuft');
  assert.equal(st.schritt.name, 'Sicherung auf den PBS');
  assert.equal(st.promille, 412);
  assert.equal(st.platten[0].nur_gelesen, true);
});

test('Status aus /run/sichern/status (älteres Abbild)', () => {
  const st = S.liveStatus('#kv\nzustand=laeuft\nschritt_nr=3\nschritt_zahl=5\nschritt_name=Prüfsummen vorher\nplatten=/dev/sda /dev/sdb\n');
  assert.equal(st.zustand, 'laeuft');
  assert.equal(st.promille, 400);
  assert.deepEqual(st.platten.map((p) => p.name), ['/dev/sda', '/dev/sdb']);
  assert.equal(S.liveStatus('#kv\n').zustand, 'wartet');
  assert.equal(S.liveStatus('#kv\nzustand=erfolg\n').promille, 1000);
  assert.equal(S.liveStatus('#kv\nzustand=boese\n').zustand, 'wartet');
});

test('Erwartungen je Namespace', () => {
  const e = S.erwartungenParsen('Rosenweg9/pc=0, *=36 ,kaputt,x=-1');
  assert.equal(S.erwartungFuer('Rosenweg9/pc', e), 0);
  assert.equal(S.erwartungFuer('Rosenweg9', e), 36);
  assert.equal(S.erwartungFuer('x', e), 36);
  assert.equal(S.erwartungFuer('a', []), null);
});

test('UPID -> Zeit der Prüfung', () => {
  const t = sek(jetzt).toString(16).toUpperCase().padStart(8, '0');
  assert.equal(S.upidZeit(`UPID:pbs:0000ABCD:00000001:00000002:${t}:verify:storage:root@pam:`).toISOString(), jetzt.toISOString());
  assert.equal(S.upidZeit('quatsch'), null);
});

test('Gruppen: neueste je Gruppe, Alter, Prüfung, Cluster', () => {
  const cluster = new Map([[101, { name: 'web', type: 'lxc' }], [102, { name: 'db', type: 'qemu' }]]);
  const snaps = [
    { 'backup-type': 'ct', 'backup-id': '101', 'backup-time': vorStunden(30), size: 10 },
    { 'backup-type': 'ct', 'backup-id': '101', 'backup-time': vorStunden(6), size: 20, verification: { state: 'ok', upid: 'x' } },
    { 'backup-type': 'vm', 'backup-id': '102', 'backup-time': vorStunden(50), size: 5 },
    { 'backup-type': 'vm', 'backup-id': '999', 'backup-time': vorStunden(500), size: 5 },
    { 'backup-type': 'vm', 'backup-id': '103', 'backup-time': vorStunden(1), verification: { state: 'failed' } },
  ];
  const g = S.gruppenAusSnapshots(snaps, { ns: 'Rosenweg9', stunden: 36, cluster, jetzt });
  const nach = Object.fromEntries(g.map((x) => [`${x.typ}/${x.id}`, x]));
  assert.equal(nach['ct/101'].anzahl, 2);
  assert.equal(nach['ct/101'].groesse, 20);
  assert.equal(nach['ct/101'].pruefung, 'ok');
  assert.equal(nach['ct/101'].warnung, null);
  assert.equal(nach['ct/101'].name, 'web');
  assert.equal(nach['vm/102'].warnung, 'älter als 36 h');
  assert.equal(nach['vm/999'].im_cluster, false);
  assert.equal(nach['vm/999'].warnung, null); // VM weg -> keine Altersmeldung
  assert.equal(nach['vm/103'].warnung, 'Prüfung fehlgeschlagen');
  assert.ok(g[0].warnung && g[1].warnung, 'Warnungen stehen oben');

  const ohne = S.ohneSicherung(new Map([...cluster, [104, { name: 'neu', type: 'qemu' }], [105, { template: true }]]), g);
  assert.deepEqual(ohne.map((o) => o.vmid), [104]);
});

test('PC-Namespace ohne Altersgrenze', () => {
  const g = S.gruppenAusSnapshots([{ 'backup-type': 'vm', 'backup-id': '9001', 'backup-time': vorStunden(2000), comment: 'r9-pc1 – PC-Abbild' }],
    { ns: 'Rosenweg9/pc', stunden: 0, jetzt });
  assert.equal(g[0].warnung, null);
  assert.equal(g[0].notiz, 'r9-pc1 – PC-Abbild');
});

test('shQuote', () => {
  assert.equal(S.shQuote("sicherung@pbs!pc@1.2.3.4:storage"), "'sicherung@pbs!pc@1.2.3.4:storage'");
  assert.equal(S.shQuote("a'b"), "'a'\\''b'");
});
