// node --test api/test/mieter-eigentuemer-unterlagen.test.js — Datenschutz
// (Entscheid Stefan 28.11.2026): Mieter bzw. reine Bewohner sehen im Ordner
// ihrer STWEG nur stwegN/bewohner/. Abrechnungen, Protokolle, Kontaktdaten und
// alles andere sehen nur Eigentuemer, Ausschuss und Verwaltung der STWEG.
// Gleiche Regel in tabelle.txt (Samba) und raum-qr (Schilder in bewohner/).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../lib/dok-stweg-sicht');

const lies = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const MIETER3 = ['r9-bewohner', 'bewohner'];
const MIETER5 = ['stweg5-bewohner', 'bewohner'];
const SELBST3 = ['r9-bewohner', 'r9-eigentuemer', 'bewohner', 'eigentuemer'];
const EIG5 = ['stweg5-eigentuemer', 'eigentuemer'];
const AUSSCHUSS3 = ['stweg3-ausschuss'];
const VERW3 = ['stweg3-verwaltung'];
const MIETER_MEG = ['meg-bewohner'];

test('Zugang je Rolle', () => {
  assert.equal(d.stwegDokZugang(MIETER3, 3), 'bewohner');
  assert.equal(d.stwegDokZugang(MIETER5, 5), 'bewohner');
  assert.equal(d.stwegDokZugang(SELBST3, 3), 'voll');
  assert.equal(d.stwegDokZugang(EIG5, 5), 'voll');
  assert.equal(d.stwegDokZugang(AUSSCHUSS3, 3), 'voll');
  assert.equal(d.stwegDokZugang(VERW3, 3), 'voll');
  assert.equal(d.stwegDokZugang(['Verwaltung'], 6), 'voll'); // Übergang
  assert.equal(d.stwegDokZugang(MIETER_MEG, 8), 'bewohner');
  // fremde STWEG: nichts
  assert.equal(d.stwegDokZugang(MIETER3, 5), null);
  assert.equal(d.stwegDokZugang(EIG5, 3), null);
  assert.equal(d.stwegDokZugang(VERW3, 5), null);
  // Eigentuemer einer anderen STWEG macht den Mieter hier nicht zum Eigentuemer
  assert.equal(d.stwegDokZugang([...MIETER3, ...EIG5], 3), 'bewohner');
  // Gross/Klein egal
  assert.equal(d.stwegDokZugang(['R9-Eigentuemer'], 3), 'voll');
});

test('Mieter: nur stwegN/bewohner/, keine Eigentuemer-Unterlagen', () => {
  for (const p of ['stweg3/bewohner/hausordnung-stweg3.pdf', 'stweg3/bewohner/schilder/heizung.pdf', 'stweg3/bewohner/x/y/z.pdf']) {
    assert.equal(d.stwegDokErlaubt(p, MIETER3, 3), true, p);
  }
  for (const p of ['stweg3/05-abrechnungen/a.pdf', 'stweg3/06-protokolle/p.pdf', 'stweg3/99-kontaktdaten/k.xlsx',
    'stweg3/kontaktdaten/k.pdf', 'stweg3/01-stammdaten/s.pdf', 'stweg3/jahresrechnung.pdf', 'stweg3/neuer-ordner/n.pdf',
    'stweg3/Bewohner/falsch-geschrieben.pdf', 'stweg3/bewohner-alt/x.pdf', 'stweg3/x/bewohner/y.pdf']) {
    assert.equal(d.stwegDokErlaubt(p, MIETER3, 3), false, p);
  }
  assert.equal(d.stwegDokErlaubt('stweg5/bewohner/hausordnung-stweg5.pdf', MIETER5, 5), true);
  assert.equal(d.stwegDokErlaubt('stweg5/2049 Verwaltungsvertrag.pdf', MIETER5, 5), false);
  assert.equal(d.stwegDokErlaubt('meg/bewohner/schilder/t.pdf', MIETER_MEG, 8), true);
  assert.equal(d.stwegDokErlaubt('meg/jahresrechnung.pdf', MIETER_MEG, 8), false);
});

test('Eigentuemer, Ausschuss, Verwaltung: ganzer Ordner der STWEG', () => {
  for (const g of [SELBST3, AUSSCHUSS3, VERW3]) {
    assert.equal(d.stwegDokErlaubt('stweg3/05-abrechnungen/a.pdf', g, 3), true);
    assert.equal(d.stwegDokErlaubt('stweg3/bewohner/hausordnung-stweg3.pdf', g, 3), true);
  }
  assert.equal(d.stwegDokErlaubt('stweg5/99-kontaktdaten/k.xlsx', EIG5, 5), true);
});

test('server.js: isDocPathAllowed nutzt die Regel nach der STWEG-Pruefung', () => {
  const s = lies('api/server.js');
  assert.match(s, /const \{ stwegDokErlaubt \} = require\('\.\/lib\/dok-stweg-sicht'\);/);
  const i = s.indexOf('function isDocPathAllowed');
  const f = s.slice(i, s.indexOf('\n}\n', i));
  assert.match(f, /if \(nr === null \|\| !stwegs\.has\(nr\)\) return false;/);
  assert.match(f, /return stwegDokErlaubt\(filePath, groups, nr\);/);
  // Technik/Praesident vorher, Sperrordner gelten weiter
  assert.ok(f.indexOf('isTechnik(groups) || isPraesident(groups)') < f.indexOf('stwegDokErlaubt'));
  assert.ok(f.indexOf("sperre === 'gesperrt'") < f.indexOf('stwegDokErlaubt'));
});

test('tabelle.txt: STWEG-Ordner ohne Bewohner, bewohner/ mit Bewohnern', () => {
  const tab = lies('fileserver-lxc/ordnerrechte/tabelle.txt').split('\n').filter(z => z.trim() && !z.startsWith('#'));
  const zeile = pfad => tab.find(z => z.split('|')[0].trim() === pfad);
  const ordner = { stweg1: 'stweg1', stweg2: 'stweg2', stweg3: 'r9', stweg4: 'stweg4', stweg5: 'stweg5', stweg6: 'r1', stweg7: 'stweg7', meg: 'meg', stweg8: 'meg' };
  for (const [o, pre] of Object.entries(ordner)) {
    const z = zeile(o);
    assert.ok(z, `${o} fehlt`);
    assert.doesNotMatch(z.split('|')[1], /bewohner/, `${o}: Bewohner duerfen den ganzen Ordner nicht lesen`);
    assert.match(z.split('|')[1], new RegExp(`${pre}-eigentuemer`), `${o}: Eigentuemer fehlen`);
    if (o === 'stweg8') continue; // nur Alias, kein bewohner/
    const b = zeile(`${o}/bewohner`);
    assert.ok(b, `${o}/bewohner fehlt`);
    assert.match(b.split('|')[1], new RegExp(`${pre}-bewohner`));
    assert.match(b.split('|')[1], new RegExp(`${pre}-eigentuemer`));
    assert.equal(b.split('|')[2].trim(), z.split('|')[2].trim(), `${o}/bewohner: gleiche Schreiber wie ${o}`);
  }
});

test('anwenden.sh kennt Unterpfad-Zeilen mit Durchgang auf dem Elternordner', () => {
  const s = lies('fileserver-lxc/ordnerrechte/anwenden.sh');
  assert.match(s, /Unterpfad/);
  assert.match(s, /durchgang/i);
});

test('raum-qr: Schilder einer STWEG/MEG landen in bewohner/schilder', () => {
  const s = lies('api/routes/raum-qr.js');
  const i = s.indexOf('function ablageOrdner');
  const f = s.slice(i, s.indexOf('\n}\n', i));
  assert.match(f, /return `stweg\$\{m\[1\]\}\/bewohner`;/);
  assert.match(f, /return 'meg\/bewohner';/);
  assert.match(f, /return 'allgemein';/);
  assert.match(s, /`\$\{ablageOrdner\(kopfName\)\}\/schilder\//);
  // und dort darf ein Mieter sie lesen
  assert.equal(d.stwegDokErlaubt('stweg3/bewohner/schilder/w-r9-a4.pdf', MIETER3, 3), true);
});
