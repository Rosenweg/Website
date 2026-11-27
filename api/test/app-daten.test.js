// node --test api/test/app-daten.test.js — persoenliche App-Daten (lib/app-daten.js,
// routes/app-daten.js) ohne Postgres: die Abfragen tragen eine Marke (/* app-daten:... */),
// die Attrappe unten fuehrt sie auf einer Map aus.
const test = require('node:test');
const assert = require('node:assert/strict');
const ad = require('../lib/app-daten');
const { holen, abgleichen } = require('../routes/app-daten');

const UHR = 'ch.rosenweg4303.clock';

function attrappe() {
  const zeilen = new Map(); // user|app|art|schluessel -> Zeile
  const k = (u, a, art, s) => `${u}|${a}|${art}|${s}`;
  const von = (u, a) => [...zeilen.values()].filter(z => z.user_id === u && z.app === a);
  const query = async (sql, p = []) => {
    const marke = (sql.match(/\/\* app-daten:(\w+) \*\//) || [])[1];
    if (/CREATE TABLE/.test(sql) || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    switch (marke) {
      case 'sperre':
      case 'aufraeumen':
        return { rows: [] };
      case 'stand': {
        const z = von(p[0], p[1]);
        return { rows: [{ version: z.reduce((m, x) => Math.max(m, x.version), 0), anzahl: z.length }] };
      }
      case 'seit':
        return { rows: von(p[0], p[1]).filter(z => z.version > p[2]).sort((a, b) => a.version - b.version) };
      case 'lesen':
        return { rows: p[2].map((art, i) => zeilen.get(k(p[0], p[1], art, p[3][i]))).filter(Boolean) };
      case 'schreiben': {
        const [u, a, version, geraet, arten, ids, daten, geloescht, geaendert] = p;
        arten.forEach((art, i) => zeilen.set(k(u, a, art, ids[i]), {
          user_id: u, app: a, art, schluessel: ids[i], daten: daten[i] === null ? null : JSON.parse(daten[i]),
          geloescht: geloescht[i], geaendert: String(geaendert[i]), version, geraet,
        }));
        return { rows: [] };
      }
      default:
        throw new Error('unbekannte Abfrage: ' + sql.slice(0, 60));
    }
  };
  return { zeilen, query, connect: async () => ({ query, release() {} }) };
}

const wecker = (id, geaendert, daten = { zeit: 420 }) => ({ art: 'wecker', id, geaendert, daten });

test('App-Name: nur ch.rosenweg4303.<name>', () => {
  for (const a of [UHR, 'ch.rosenweg4303.salz', 'ch.rosenweg4303.a.b_c']) assert.equal(ad.appGueltig(a), true, a);
  for (const a of ['org.fossify.clock', 'ch.rosenweg4303.', 'ch.rosenweg4303.Clock', 'ch.rosenweg4303.x/y', '', null]) {
    assert.equal(ad.appGueltig(a), false, String(a));
  }
});

test('Zugriff: nur die Person; Karte und Anlage nur fuer ihre eigene App', () => {
  assert.equal(ad.zugriffVerweigert({ user: { id: 7 } }, UHR), null);
  assert.match(ad.zugriffVerweigert({ user: {} }, UHR), /Konto/);
  assert.equal(ad.zugriffVerweigert({ user: { id: 7 }, anlage: { paket: UHR } }, UHR), null);
  assert.match(ad.zugriffVerweigert({ user: { id: 7 }, anlage: { paket: 'ch.rosenweg4303.notes' } }, UHR), /eigenen/);
  assert.equal(ad.zugriffVerweigert({ user: { id: 7 }, appKarte: { app: UHR } }, UHR), null);
  assert.match(ad.zugriffVerweigert({ user: { id: 7 }, appKarte: { app: 'ch.rosenweg4303.notes' } }, UHR), /andere App/);
});

test('Pruefen: Felder, Doppelte, Groesse, Zukunft wird gekuerzt', () => {
  const jetzt = 1_800_000_000_000;
  assert.match(ad.eintraegePruefen('x').fehler, /Liste/);
  assert.match(ad.eintraegePruefen([{ art: 'Wecker', id: 'a', geaendert: 1, daten: {} }]).fehler, /art/);
  assert.match(ad.eintraegePruefen([{ art: 'wecker', id: 'a/b', geaendert: 1, daten: {} }]).fehler, /id/);
  assert.match(ad.eintraegePruefen([{ art: 'wecker', id: 'a', geaendert: 0, daten: {} }]).fehler, /geaendert/);
  assert.match(ad.eintraegePruefen([{ art: 'wecker', id: 'a', geaendert: 1 }]).fehler, /daten fehlt/);
  assert.match(ad.eintraegePruefen([wecker('a', 1), wecker('a', 2)]).fehler, /doppelt/);
  assert.match(ad.eintraegePruefen([wecker('a', 1, { x: 'y'.repeat(17000) })]).fehler, /zu gross/);
  assert.match(ad.eintraegePruefen(Array.from({ length: 501 }, (_, i) => wecker('w' + i, 1))).fehler, /500/);
  const ok = ad.eintraegePruefen([wecker('a', jetzt + 3600_000), { art: 'wecker', id: 'b', geaendert: 5, geloescht: true, daten: { x: 1 } }], jetzt);
  assert.equal(ok.eintraege[0].geaendert, jetzt + ad.GRENZEN.zukunftMs);
  assert.deepEqual(ok.eintraege[1], { art: 'wecker', id: 'b', geaendert: 5, geloescht: true, daten: null });
});

test('Konflikt: letzte Aenderung gewinnt, bei Gleichstand das Loeschen', () => {
  assert.equal(ad.gewinnt({ geaendert: 5 }, undefined), true);
  assert.equal(ad.gewinnt({ geaendert: 6 }, { geaendert: '5' }), true);
  assert.equal(ad.gewinnt({ geaendert: 4 }, { geaendert: '5' }), false);
  assert.equal(ad.gewinnt({ geaendert: 5, geloescht: false }, { geaendert: '5', geloescht: false }), false);
  assert.equal(ad.gewinnt({ geaendert: 5, geloescht: true }, { geaendert: '5', geloescht: false }), true);
  assert.equal(ad.gewinnt({ geaendert: 5, geloescht: false }, { geaendert: '5', geloescht: true }), false);
});

test('Abgleich: zwei Geraete, Versionen, Grabstein, abgelehnte Aenderung kommt zurueck', async () => {
  const pool = attrappe();
  // Handy A legt zwei Wecker an
  let a = await abgleichen({ pool, userId: 7, app: UHR, body: { seit: 0, eintraege: [wecker('w1', 100), wecker('w2', 100)], geraet: 'Handy A' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.version, 1);
  assert.equal(a.json.uebernommen, 2);
  assert.deepEqual(a.json.eintraege.map(e => e.id), ['w1', 'w2']);
  assert.deepEqual(a.json.person, { id: 7, name: null });

  // Handy B holt alles
  const b = await holen({ pool, userId: 7, app: UHR, seit: 0 });
  assert.equal(b.version, 1);
  assert.equal(b.eintraege.length, 2);
  // nichts Neues seit 1
  assert.equal((await holen({ pool, userId: 7, app: UHR, seit: 1 })).eintraege.length, 0);

  // B loescht w1 (spaeter), A aendert w1 frueher -> Loeschen gewinnt, A bekommt den Grabstein
  const g = await abgleichen({ pool, userId: 7, app: UHR, body: { seit: 1, eintraege: [{ art: 'wecker', id: 'w1', geaendert: 300, geloescht: true }] } });
  assert.equal(g.json.version, 2);
  a = await abgleichen({ pool, userId: 7, app: UHR, body: { seit: 1, eintraege: [wecker('w1', 200, { zeit: 480 })] } });
  assert.equal(a.json.abgelehnt, 1);
  assert.equal(a.json.uebernommen, 0);
  assert.equal(a.json.version, 2);
  assert.deepEqual(a.json.eintraege.map(e => [e.id, e.geloescht, e.daten]), [['w1', true, null]]);

  // Andere Person sieht nichts
  assert.equal((await holen({ pool, userId: 8, app: UHR, seit: 0 })).eintraege.length, 0);
  // Andere App derselben Person auch nicht
  assert.equal((await holen({ pool, userId: 7, app: 'ch.rosenweg4303.notes', seit: 0 })).eintraege.length, 0);
});

test('Abgleich: alter Stand ohne neue Aenderung, nur abgelehnte Eintraege; Fehler 400', async () => {
  const pool = attrappe();
  await abgleichen({ pool, userId: 7, app: UHR, body: { eintraege: [wecker('w1', 500)] } });
  // Geraet mit seit=1 schickt einen aelteren Stand: nichts geschrieben, Serverstand kommt zurueck
  const r = await abgleichen({ pool, userId: 7, app: UHR, body: { seit: 1, eintraege: [wecker('w1', 400, { zeit: 1 })] } });
  assert.equal(r.json.version, 1);
  assert.deepEqual(r.json.eintraege.map(e => [e.id, e.daten.zeit, e.version]), [['w1', 420, 1]]);
  // leerer Abgleich = holen
  const leer = await abgleichen({ pool, userId: 7, app: UHR, body: { seit: 0 } });
  assert.equal(leer.json.eintraege.length, 1);
  assert.equal((await abgleichen({ pool, userId: 7, app: UHR, body: { eintraege: [{ art: 'x' }] } })).status, 400);
});

test('Abgleich: Obergrenze je App', async () => {
  const pool = attrappe();
  const alt = ad.GRENZEN.eintraegeJeApp;
  ad.GRENZEN.eintraegeJeApp = 3;
  try {
    assert.equal((await abgleichen({ pool, userId: 7, app: UHR, body: { eintraege: [wecker('a', 1), wecker('b', 1), wecker('c', 1)] } })).status, 200);
    assert.equal((await abgleichen({ pool, userId: 7, app: UHR, body: { eintraege: [wecker('d', 1)] } })).status, 413);
    // Aendern bestehender Eintraege geht weiter
    assert.equal((await abgleichen({ pool, userId: 7, app: UHR, body: { eintraege: [wecker('a', 2)] } })).status, 200);
  } finally {
    ad.GRENZEN.eintraegeJeApp = alt;
  }
});
