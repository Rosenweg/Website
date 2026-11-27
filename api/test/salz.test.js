// node --test api/test/salz.test.js — Reichweite und Meldeentscheid (lib/salz.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { verbrauchProWoche, lagerStand, meldeEntscheid, meldungsText } = require('../lib/salz');

const TAG = 24 * 60 * 60 * 1000;
const jetzt = new Date('2026-11-26T10:00:00Z');
const vor = tage => new Date(jetzt.getTime() - tage * TAG);

test('zu wenig Einfuellungen -> kein Verbrauch', () => {
  const v = verbrauchProWoche([{ am: vor(20), kg: 25 }, { am: vor(5), kg: 25 }], jetzt);
  assert.equal(v.kgProWoche, null);
  assert.equal(v.einfuellungen, 2);
});

test('Einfuellungen zu dicht beieinander -> kein Verbrauch', () => {
  const v = verbrauchProWoche([{ am: vor(3), kg: 25 }, { am: vor(2), kg: 25 }, { am: vor(1), kg: 25 }], jetzt);
  assert.equal(v.kgProWoche, null);
});

test('ein Sack pro Woche = 25 kg/Woche; letzter Sack zaehlt nicht', () => {
  const ein = [0, 7, 14, 21, 28].map(t => ({ am: vor(t), kg: 25 }));
  const v = verbrauchProWoche(ein, jetzt);
  assert.equal(v.einfuellungen, 5);
  assert.ok(Math.abs(v.kgProWoche - 25) < 1e-9);
});

test('Reihenfolge egal, aelter als das Fenster faellt weg', () => {
  const ein = [{ am: vor(400), kg: 1000 }, { am: vor(0), kg: 25 }, { am: vor(28), kg: 25 }, { am: vor(14), kg: 25 }];
  const v = verbrauchProWoche(ein, jetzt);
  assert.equal(v.einfuellungen, 3);
  assert.ok(Math.abs(v.kgProWoche - 12.5) < 1e-9); // 2 Saecke (50 kg) in 4 Wochen
});

test('Reichweite: 4 Saecke a 25 kg bei 25 kg/Woche = 4 Wochen, Schwelle 4 -> nicht knapp', () => {
  const s = lagerStand({ bestandSaecke: 4, bestandKg: 100, kgProWoche: 25, schwelleWochen: 4, mindestSaecke: 2 });
  assert.deepEqual(s, { modus: 'reichweite', reichweiteWochen: 4, knapp: false });
  const k = lagerStand({ bestandSaecke: 3, bestandKg: 75, kgProWoche: 25, schwelleWochen: 4, mindestSaecke: 2 });
  assert.equal(k.knapp, true);
  assert.equal(k.reichweiteWochen, 3);
});

test('ohne Verbrauch: Mindestbestand (<=)', () => {
  assert.equal(lagerStand({ bestandSaecke: 5, bestandKg: 125, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4 }).knapp, false);
  const s = lagerStand({ bestandSaecke: 4, bestandKg: 100, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4 });
  assert.equal(s.modus, 'mindestbestand');
  assert.equal(s.knapp, true);
});

test('leeres Lager ist immer knapp', () => {
  assert.equal(lagerStand({ bestandSaecke: 0, bestandKg: 0, kgProWoche: 1, schwelleWochen: 0, mindestSaecke: 0 }).knapp, true);
});

test('Meldung einmal, Erinnerung nach 7 Tagen, Anlieferung schiebt sie', () => {
  const basis = { knapp: true, wiederholungTage: 7, jetzt };
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: null }), 'melden');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(3), meldungZuletzt: vor(3) }), 'nichts');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(8), meldungZuletzt: vor(8) }), 'erinnern');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(8), meldungZuletzt: vor(8), letzteAnlieferung: vor(2) }), 'nichts');
  assert.equal(meldeEntscheid({ ...basis, wiederholungTage: 0, meldungSeit: vor(30), meldungZuletzt: vor(30) }), 'nichts');
});

test('wieder genug -> entwarnen, sonst nichts', () => {
  assert.equal(meldeEntscheid({ knapp: false, meldungSeit: vor(1), jetzt }), 'entwarnen');
  assert.equal(meldeEntscheid({ knapp: false, meldungSeit: null, jetzt }), 'nichts');
});

test('Mailtext nennt Lager, Bestand, Reichweite', () => {
  const t = meldungsText({ lager: 'Rosenweg 9', stand: { modus: 'reichweite', reichweiteWochen: 2.5 },
    bestandSaecke: 2, bestandKg: 50, kgProWoche: 20, schwelleWochen: 4, mindestSaecke: 4, erinnerung: false });
  assert.match(t, /Rosenweg 9/);
  assert.match(t, /2 Säcke \(50 kg\)/);
  assert.match(t, /Reicht noch: etwa 2\.5 Wochen/);
});

test('Mailtext nennt den Ort, wenn es einen gibt', () => {
  const t = meldungsText({ lager: 'Rosenweg Kooperation', ort: 'Lager im Rosenweg 10', stand: { modus: 'mindestbestand' },
    bestandSaecke: 1, bestandKg: 25, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4, erinnerung: false });
  assert.match(t, /Rosenweg Kooperation/);
  assert.match(t, /Ort: Lager im Rosenweg 10/);
  assert.match(t, /1 Säcke|1 Sack/);
});

test('Reichweite unter einer Woche heisst nicht "0 Wochen"', () => {
  const { reichtText } = require('../lib/salz');
  assert.equal(reichtText(0.3), 'weniger als 1 Woche');
  assert.equal(reichtText(1), 'etwa 1 Woche');
  assert.equal(reichtText(3.5), 'etwa 3.5 Wochen');
});

// ── Nächster Sack ──
const { naechsterSack, einfuellErinnern, einfuellText, zuerichTag } = require('../lib/salz');

test('naechster Sack: letzte Einfuellung + ein Sack / kg pro Woche, auf den Tag', () => {
  // 25 kg bei 14.8 kg/Woche = 11.8 Tage nach dem 1.12. 10:00 Zuerich -> 13.12.
  assert.equal(naechsterSack({ letzteAm: '2026-12-01T09:00:00Z', sackKg: 25, kgProWoche: 14.8 }), '2026-12-13');
  assert.equal(naechsterSack({ letzteAm: '2026-12-01T09:00:00Z', sackKg: 25, kgProWoche: null }), null);
  assert.equal(naechsterSack({ letzteAm: null, sackKg: 25, kgProWoche: 10 }), null);
});

test('nach 10 Saecken auf einmal ist nach EINEM Sack Verbrauch wieder Platz; Inhalt reicht laenger', () => {
  const { inhaltReichtBis } = require('../lib/salz');
  // 25 kg pro Woche: ein Sack = 7 Tage, 250 kg = 70 Tage
  assert.equal(naechsterSack({ letzteAm: '2026-12-01T09:00:00Z', sackKg: 25, kgProWoche: 25 }), '2026-12-08');
  assert.equal(inhaltReichtBis({ letzteAm: '2026-12-01T09:00:00Z', letzteKg: 250, kgProWoche: 25 }), '2027-02-09');
});

test('Tag in Zuerich, nicht UTC', () => {
  assert.equal(zuerichTag('2026-12-01T23:30:00Z'), '2026-12-02');
});

test('Hinweis ohne Termin: klar sagen, was fehlt', () => {
  const { prognoseHinweis } = require('../lib/salz');
  assert.match(prognoseHinweis({ letzte: null, kgProWoche: null }), /Noch keine Einfüllung/);
  assert.match(prognoseHinweis({ letzte: { t: 1, kg: 25 }, kgProWoche: null }), /zu wenig Daten.*3 Einfüllungen.*2 Wochen/);
  assert.equal(prognoseHinweis({ letzte: { t: 1, kg: 25 }, kgProWoche: 15 }), null);
});

test('Einfuell-Erinnerung: ab dem Vortag 8 Uhr, nur tagsueber, einmal je Einfuellung, abschaltbar', () => {
  const letzte = '2026-12-01T09:00:00Z';
  const basis = { faellig: '2026-12-13', gemeldetAm: null, letzteEinfuellung: letzte, eingeschaltet: true, inBetrieb: true };
  // zwei Tage vorher nicht, am Vortag 07:30 Zuerich nicht, 08:05 schon
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-11T10:00:00Z') }), false);
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-12T06:30:00Z') }), false);
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-12T07:05:00Z') }), true);
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-13T10:00:00Z') }), true);
  // nachts nicht (21:30 Zuerich)
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-13T20:30:00Z') }), false);
  // seit der letzten Einfuellung schon erinnert -> nicht nochmals, auch wenn der Tag sich verschiebt
  const gemeldet = { ...basis, gemeldetAm: '2026-12-12T07:05:00Z' };
  assert.equal(einfuellErinnern({ ...gemeldet, jetzt: new Date('2026-12-13T10:00:00Z') }), false);
  assert.equal(einfuellErinnern({ ...gemeldet, faellig: '2026-12-14', jetzt: new Date('2026-12-14T10:00:00Z') }), false);
  // neue Einfuellung danach -> neue Faelligkeit
  assert.equal(einfuellErinnern({ ...gemeldet, letzteEinfuellung: '2026-12-13T15:00:00Z', faellig: '2026-12-25',
    jetzt: new Date('2026-12-24T10:00:00Z') }), true);
  // nachholen bis 2 Tage, danach nicht mehr (z. B. importierte alte Listen)
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-15T09:00:00Z') }), true);
  assert.equal(einfuellErinnern({ ...basis, jetzt: new Date('2026-12-16T10:00:00Z') }), false);
  assert.equal(einfuellErinnern({ ...basis, eingeschaltet: false, jetzt: new Date('2026-12-13T10:00:00Z') }), false);
  assert.equal(einfuellErinnern({ ...basis, inBetrieb: false, jetzt: new Date('2026-12-13T10:00:00Z') }), false);
  assert.equal(einfuellErinnern({ ...basis, faellig: null, jetzt: new Date('2026-12-13T10:00:00Z') }), false);
});

test('Einfuell-Text nennt Lager, Ort, geschaetzten Tag und Verbrauch', () => {
  const t = einfuellText({ lager: 'Rosenweg Kooperation', ort: 'Lager im Rosenweg 10', faellig: '2026-12-13',
    bestandSaecke: 4, kgProWoche: 14.83, sackKg: 25, portalUrl: 'https://x', jetzt: new Date('2026-12-12T08:00:00Z') });
  assert.match(t, /Rosenweg Kooperation/);
  assert.match(t, /etwa morgen \(Sonntag, 13\. Dezember\)/);
  assert.match(t, /Platz für einen Sack/);
  assert.match(t, /Ort: Lager im Rosenweg 10/);
  assert.match(t, /14\.8 kg pro Woche, ein Sack reicht rund 12 Tage/);
  assert.match(t, /4 Säcke/);
  assert.doesNotMatch(t, /ß/);
  const heute = einfuellText({ lager: 'L', faellig: '2026-12-13', bestandSaecke: 1, kgProWoche: 10, sackKg: 25,
    jetzt: new Date('2026-12-13T08:00:00Z') });
  assert.match(heute, /etwa heute/);
});

// ── Zusammenfassen und Datenluecken (Befund 27.11.2026, Muster wie im Lager Rosenweg 9) ──
const { einfuellungenZusammenfassen, inAbschnitte } = require('../lib/salz');
const sack = (am, n = 1) => ({ am, kg: 25 * n, saecke: n, kg_je_sack: 25 });

test('10 Saecke einzeln gescannt innert Minuten = EINE Einfuellung mit 250 kg', () => {
  const t0 = new Date('2026-11-26T19:50:00Z').getTime();
  const zehn = Array.from({ length: 10 }, (_, i) => sack(new Date(t0 + i * 15000)));
  const g = einfuellungenZusammenfassen(zehn, jetzt2());
  assert.equal(g.length, 1);
  assert.equal(g[0].kg, 250);
  assert.equal(g[0].saecke, 10);
  assert.equal(g[0].kgJeSack, 25);
  assert.equal(g[0].t, t0);
});

function jetzt2() { return new Date('2026-11-27T10:00:00Z'); }

test('zusammenfassen: bis 6 Stunden Abstand gehoert dazu, mehr nicht', () => {
  const g = einfuellungenZusammenfassen([
    sack('2026-11-01T08:00:00Z'), sack('2026-11-01T13:00:00Z'), // 5 h -> zusammen
    sack('2026-11-01T20:00:00Z'), // 7 h nach der vorherigen -> neu
  ], jetzt);
  assert.deepEqual(g.map(x => x.kg), [50, 25]);
});

// Ein Sack alle 12 Tage (~14.6 kg/Woche) ueber gut ein Jahr, dann knapp 3 Jahre
// keine Buchung, dann 10 Saecke auf einmal.
const alt = Array.from({ length: 40 }, (_, i) => sack(new Date(Date.parse('2022-08-20T11:00:00Z') + i * 12 * TAG)));
const zehnHeute = Array.from({ length: 10 }, (_, i) => sack(new Date(Date.parse('2026-11-26T19:50:00Z') + i * 15000)));

test('Datenluecke von fast 3 Jahren zaehlt nicht; nach der Luecke zu wenig -> letzter guter Abschnitt davor', () => {
  const v = verbrauchProWoche([...alt, ...zehnHeute], jetzt2());
  assert.equal(v.luecken, 1);
  assert.equal(v.aktuell, false);
  assert.equal(v.einfuellungen, 40);
  assert.ok(Math.abs(v.kgProWoche - 25 / 12 * 7) < 1e-9); // 14.58 kg/Woche
  assert.equal(v.letzte.kg, 250);
  // naechster Sack 12 Tage nach dem 26.11. (ein Sack), nicht erst nach 10 Saecken
  assert.equal(naechsterSack({ letzteAm: new Date(v.letzte.t), sackKg: v.letzte.kgJeSack, kgProWoche: v.kgProWoche }), '2026-12-08');
});

test('Gegenprobe: ueber die Luecke gerechnet waere der Verbrauch viel zu tief', () => {
  const tage = (Date.parse('2026-11-26T19:50:00Z') - Date.parse('2022-08-20T11:00:00Z')) / TAG;
  assert.ok((40 * 25) / (tage / 7) < 5);
  assert.ok(verbrauchProWoche([...alt, ...zehnHeute], jetzt2()).kgProWoche > 14);
});

test('grosse Einfuellung ist keine Luecke: 10 Saecke halten zu Recht laenger', () => {
  const t0 = Date.parse('2026-01-01T09:00:00Z');
  const ein = [
    ...Array.from({ length: 6 }, (_, i) => sack(new Date(t0 + i * 10 * TAG))), // 1 Sack alle 10 Tage
    sack(new Date(t0 + 60 * TAG), 10), // 10 auf einmal ...
    sack(new Date(t0 + 160 * TAG)), // ... reichen 100 Tage
    sack(new Date(t0 + 170 * TAG)),
  ];
  const { abschnitte, luecken } = inAbschnitte(einfuellungenZusammenfassen(ein, new Date(t0 + 171 * TAG)));
  assert.equal(luecken, 0);
  assert.equal(abschnitte[0].length, 9);
});

test('Luecke: mehr als das Dreifache des Ueblichen', () => {
  const t0 = Date.parse('2026-01-01T09:00:00Z');
  const tage = [0, 10, 20, 30, 40, 85, 95, 105]; // 45 Tage fuer einen Sack: mehr als 3 x 10
  const g = einfuellungenZusammenfassen(tage.map(t => sack(new Date(t0 + t * TAG))), new Date(t0 + 200 * TAG));
  const { abschnitte, luecken } = inAbschnitte(g);
  assert.equal(luecken, 1);
  assert.deepEqual(abschnitte.map(a => a.length), [5, 3]);
});

test('Luecke ohne genug Abstaende fuer den Median: ueber 90 Tage je Sack', () => {
  const g = einfuellungenZusammenfassen([sack('2026-01-01T09:00:00Z'), sack('2026-04-15T09:00:00Z')], jetzt);
  assert.equal(inAbschnitte(g).luecken, 1);
  const g2 = einfuellungenZusammenfassen([sack('2026-01-01T09:00:00Z'), sack('2026-03-15T09:00:00Z')], jetzt);
  assert.equal(inAbschnitte(g2).luecken, 0);
});

test('nach der Luecke genug neue Daten -> der juengste Abschnitt zaehlt', () => {
  const neu = [0, 7, 14, 21].map(t => sack(new Date(Date.parse('2026-10-30T09:00:00Z') + t * TAG))); // 25 kg/Woche
  const v = verbrauchProWoche([...alt, ...neu], jetzt2());
  assert.equal(v.aktuell, true);
  assert.equal(v.einfuellungen, 4);
  assert.ok(Math.abs(v.kgProWoche - 25) < 1e-9);
});

test('mehrere Saecke einer Einfuellung zaehlen fuer den Verbrauch zusammen', () => {
  // je 2 Saecke einzeln gescannt alle 14 Tage = 50 kg in 2 Wochen = 25 kg/Woche
  const ein = [];
  for (const t of [42, 28, 14, 0]) ein.push(sack(vor(t)), sack(new Date(vor(t).getTime() - 60000)));
  const v = verbrauchProWoche(ein, jetzt);
  assert.equal(v.einfuellungen, 4);
  assert.ok(Math.abs(v.kgProWoche - 25) < 1e-6);
});
