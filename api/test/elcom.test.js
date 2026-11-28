// node --test api/test/elcom.test.js — Strompreis der ElCom (lib/elcom.js):
// Parameter, SPARQL nur mit geprüften Werten, Auswertung, Zwischenspeicher,
// alter Wert bei Ausfall, Endpunkt nur für Angemeldete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const e = require('../lib/elcom');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Antwort von LINDAS für Kaiseraugst 2026, H4 (Stand 28.11.2026)
const KAISERAUGST_2026 = {
  results: { bindings: [{
    operator: { value: 'https://energy.ld.admin.ch/elcom/electricityprice/operator/5' },
    opname: { value: 'AEW Energie AG' }, gemeinde: { value: 'Kaiseraugst' },
    total: { value: '27.892' }, energy: { value: '11.400' }, gridusage: { value: '12.230' },
    charge: { value: '0.762' }, aidfee: { value: '2.300' }, meteringrate: { value: '1.2' },
  }] },
};

test('Parameter: Vorgaben Kaiseraugst, laufendes Jahr, H4', () => {
  const heute = new Date('2026-11-28T12:00:00Z');
  assert.deepEqual(e.elcomParameter({}, heute), { bfs: 4252, jahr: 2026, kategorie: 'H4' });
  assert.deepEqual(e.elcomParameter({ gemeinde: '4252', jahr: '2027', kategorie: 'h3' }, heute), { bfs: 4252, jahr: 2027, kategorie: 'H3' });
  assert.ok(e.elcomParameter({ jahr: '2028' }, heute).fehler, 'nur bis Folgejahr');
  assert.ok(e.elcomParameter({ gemeinde: 'Kaiseraugst' }, heute).fehler);
  assert.ok(e.elcomParameter({ kategorie: 'X1' }, heute).fehler);
  assert.ok(e.elcomParameter({ kategorie: 'H4> } ; DROP' }, heute).fehler);
});

test('SPARQL: Gemeinde, Jahr, Kategorie, Standardprodukt', () => {
  const q = e.elcomAbfrage({ bfs: 4252, jahr: 2026, kategorie: 'H4' });
  assert.match(q, /municipality\/4252>/);
  assert.match(q, /category\/H4>/);
  assert.match(q, /product\/standard>/);
  assert.match(q, /STR\(\?period\) = "2026"/);
  assert.throws(() => e.elcomAbfrage({ bfs: '4252 }', jahr: 2026, kategorie: 'H4' }));
});

test('Auswertung: Rp./kWh mit Bestandteilen, CHF/kWh', () => {
  const a = e.elcomAuswerten(KAISERAUGST_2026, { bfs: 4252, jahr: 2026, kategorie: 'H4' }, new Date('2026-11-28T00:00:00Z'));
  assert.equal(a.quelle, 'elcom');
  assert.equal(a.gemeinde, 'Kaiseraugst');
  assert.equal(a.netzbetreiber, 'AEW Energie AG');
  assert.deepEqual(a.rp_kwh, { total: 27.892, energie: 11.4, netz: 12.23, abgaben: 0.762, kev: 2.3, messung: 1.2 });
  assert.equal(a.chf_kwh, 0.27892);
  assert.equal(a.stand, '2026-11-28T00:00:00.000Z');
  assert.equal(e.elcomAuswerten({ results: { bindings: [] } }, { bfs: 1, jahr: 2026, kategorie: 'H4' }), null);
});

test('Mehrere Netzbetreiber: der günstigste, alle genannt', () => {
  const j = { results: { bindings: [
    { opname: { value: 'B' }, total: { value: '30' }, energy: { value: '1' }, gridusage: { value: '1' }, charge: { value: '0' }, aidfee: { value: '2.3' } },
    { opname: { value: 'A' }, total: { value: '25' }, energy: { value: '1' }, gridusage: { value: '1' }, charge: { value: '0' }, aidfee: { value: '2.3' } },
  ] } };
  const a = e.elcomAuswerten(j, { bfs: 1, jahr: 2026, kategorie: 'H4' });
  assert.equal(a.netzbetreiber, 'A');
  assert.deepEqual(a.netzbetreiber_alle, ['A', 'B']);
});

test('Zwischenspeicher: ein Abruf am Tag, bei Ausfall der alte Wert', async () => {
  let t = 0, aufrufe = 0, kaputt = false;
  const holen = async (url, opt) => {
    aufrufe++;
    assert.equal(url, 'https://lindas.admin.ch/query');
    assert.match(decodeURIComponent(opt.body), /municipality\/4252/);
    if (kaputt) throw new Error('weg');
    return { ok: true, json: async () => KAISERAUGST_2026 };
  };
  const d = e.elcomDienst({ holen, jetzt: () => t });
  const a = await d.elcomPreis(4252, 2026, 'H4');
  assert.equal(a.rp_kwh.total, 27.892);
  await d.elcomPreis(4252, 2026, 'H4');
  assert.equal(aufrufe, 1, 'zweiter Aufruf aus dem Speicher');
  t += 25 * 3600 * 1000; kaputt = true;
  const b = await d.elcomPreis(4252, 2026, 'H4');
  assert.equal(aufrufe, 2);
  assert.equal(b.veraltet, true);
  assert.equal(b.rp_kwh.total, 27.892);
  await assert.rejects(d.elcomPreis(4252, 2025, 'H4'), /weg/, 'ohne alten Wert: Fehler');
  await assert.rejects(d.elcomPreis(4252, 2026, 'Z9'), /kategorie/);
});

test('Endpunkt: nur angemeldet, Antwort aus lib/elcom', () => {
  assert.match(SERVER, /app\.get\('\/api\/strompreis\/elcom', authMiddleware,/);
  assert.match(SERVER, /elcom\.elcomPreis\(p\.bfs, p\.jahr, p\.kategorie\)/);
});
