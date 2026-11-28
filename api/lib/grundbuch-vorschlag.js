// Vorschlag Parzelle -> STWEG für das Grundbuch (Entscheid Stefan 28.11.2026).
//
// Nur ein Vorschlag: nichts wird geschrieben. Technik/Präsident sieht ihn auf
// grundbuch.html und übernimmt ihn bewusst (PUT /api/grundbuch/parzellen/:p/stweg).
// Ausgabe nur Parzellennummern, STWEG und Zahlen – keine Namen, keine Adressen.
//
// Hinweise je Parzelle und STWEG:
//   wertquoten  Anteile der Parzelle (anteil_z/anteil_n), die als Wertquote
//               (wertquote_zaehler/_nenner) einer Wohnung der STWEG vorkommen;
//               jede Wohnung zählt höchstens einmal (Mengen-Vergleich).
//   anzahl      die Zahl der Anteile entspricht der Zahl der Wohnungen der STWEG
//   adressen    erfasste Wohnadressen „Rosenweg <Nr>“ eines Hauses der STWEG
//               (lib/haeuser.js); zählt nur, wo der Auszug schon erfasst ist
// Punkte: Wertquoten-Treffer je 1, gleiche Anzahl +2, Adress-Treffer je 1.
// Sicherheit: hoch (>= 80 % der Anteile als Wertquote gefunden und deutlich
// vor der zweitbesten STWEG), mittel (Vorsprung, aber weniger Treffer),
// unklar (kein oder kein eindeutiger Vorsprung -> kein Vorschlag).
const { stwegVonHaus } = require('./haeuser');

const schluessel = (z, n) => (Number.isFinite(Number(z)) && Number(z) > 0 ? `${Number(z)}/${Number(n) || ''}` : null);
const nurZaehler = (k) => k && k.split('/')[0];

function haeuserAusAdressen(adressen) {
  const out = [];
  for (const a of Array.isArray(adressen) ? adressen : []) {
    const m = String(a || '').match(/Rosenweg\s+(\d{1,3})\b/i);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// Mengen-Treffer: wie viele Werte aus a kommen in b vor (jedes b-Element einmal)
function treffer(a, b) {
  const rest = new Map();
  for (const x of b) rest.set(x, (rest.get(x) || 0) + 1);
  let n = 0;
  for (const x of a) { const c = rest.get(x) || 0; if (c > 0) { n++; rest.set(x, c - 1); } }
  return n;
}

/**
 * anteile:  [{ parzelle, anteil_z, anteil_n, wohnadressen, stweg }]
 * wohnungen: [{ stweg, wertquote_zaehler, wertquote_nenner }]
 * -> [{ parzelle, anteile, aktuell, vorschlag, sicherheit, punkte, gruende }]
 */
function parzellenVorschlag(anteile, wohnungen) {
  const jeStweg = new Map();
  for (const w of wohnungen || []) {
    const s = Number(w.stweg);
    if (!Number.isInteger(s)) continue;
    if (!jeStweg.has(s)) jeStweg.set(s, { voll: [], zaehler: [], anzahl: 0 });
    const e = jeStweg.get(s);
    e.anzahl++;
    const k = schluessel(w.wertquote_zaehler, w.wertquote_nenner);
    if (k) { e.voll.push(k); e.zaehler.push(nurZaehler(k)); }
  }
  const jeParzelle = new Map();
  for (const a of anteile || []) {
    const p = Number(a.parzelle);
    if (!Number.isFinite(p)) continue;
    if (!jeParzelle.has(p)) jeParzelle.set(p, { liste: [], haeuser: [], aktuell: new Set() });
    const e = jeParzelle.get(p);
    e.liste.push(schluessel(a.anteil_z, a.anteil_n));
    e.haeuser.push(...haeuserAusAdressen(a.wohnadressen));
    if (a.stweg != null) e.aktuell.add(Number(a.stweg));
  }
  const ergebnis = [];
  for (const [parzelle, e] of [...jeParzelle].sort((x, y) => x[0] - y[0])) {
    const werte = e.liste.filter(Boolean);
    const kandidaten = [];
    for (const [s, w] of jeStweg) {
      // Nenner gleich (z. B. /1000) zählt voll; nur Zähler gleich zählt, wenn der
      // Nenner im Grundbuch fehlt
      const tVoll = treffer(werte, w.voll);
      const tZ = tVoll || treffer(werte.filter(k => k.endsWith('/')).map(nurZaehler), w.zaehler);
      const wq = Math.max(tVoll, tZ);
      const anzahlGleich = e.liste.length > 0 && e.liste.length === w.anzahl;
      const adr = e.haeuser.filter(h => stwegVonHaus(h) === s).length;
      const punkte = wq + (anzahlGleich ? 2 : 0) + adr;
      if (punkte > 0) kandidaten.push({ stweg: s, punkte, wertquoten: wq, anzahl_gleich: anzahlGleich, adressen: adr });
    }
    kandidaten.sort((x, y) => y.punkte - x.punkte || x.stweg - y.stweg);
    const [erst, zweit] = kandidaten;
    let sicherheit = 'unklar';
    let vorschlag = null;
    if (erst && (!zweit || erst.punkte > zweit.punkte)) {
      vorschlag = erst.stweg;
      const anteilQuote = werte.length ? erst.wertquoten / werte.length : 0;
      const vorsprung = !zweit || erst.punkte >= 2 * zweit.punkte;
      sicherheit = anteilQuote >= 0.8 && vorsprung ? 'hoch' : 'mittel';
    }
    const aktuell = e.aktuell.size === 1 ? [...e.aktuell][0] : (e.aktuell.size > 1 ? 'gemischt' : null);
    ergebnis.push({
      parzelle, anteile: e.liste.length, aktuell, vorschlag, sicherheit,
      punkte: erst ? erst.punkte : 0,
      gruende: erst ? { wertquoten: erst.wertquoten, anzahl_gleich: erst.anzahl_gleich, adressen: erst.adressen,
        zweitbeste: zweit ? { stweg: zweit.stweg, punkte: zweit.punkte } : null } : null,
    });
  }
  return ergebnis;
}

module.exports = { parzellenVorschlag, haeuserAusAdressen };
