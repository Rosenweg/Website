// Strompreise der ElCom (Standardprodukt des Netzbetreibers je Gemeinde) aus
// LINDAS, dem Linked-Data-Dienst des Bundes. Nur zum VERGLEICH in den Apps
// (Rosenweg ZEV: „Netzstrom wäre X Rp./kWh“, Rosenweg Energie), nie in Tarife
// schreiben (Entscheid Stefan 28.11.2026). Die Apps fragen nie selbst bei der
// ElCom an, sondern GET /api/strompreis/elcom.
//
// Datensatz: https://energy.ld.admin.ch/elcom/electricityprice (Cube),
// SPARQL: https://lindas.admin.ch/query. Werte in Rp./kWh:
//   total = energy + gridusage + charge (Abgaben Gemeinde) + aidfee (Netzzuschlag/KEV)
//           + meteringrate (Messtarif, seit 2026 separat)
// Die ElCom veroeffentlicht die Tarife des Folgejahres Ende August; danach
// aendern sie sich kaum. Zwischenspeicher je (Gemeinde, Jahr, Kategorie) einen
// Tag, bei Fehlern gilt der letzte gute Wert weiter.

const LINDAS = 'https://lindas.admin.ch/query';
const CUBE = 'https://energy.ld.admin.ch/elcom/electricityprice';
const KAISERAUGST = 4252;
const TAG_MS = 24 * 3600 * 1000;

// Verbrauchsprofile der ElCom: H1–H8 Haushalt, C1–C7 Gewerbe. H4 = 5-Zimmer-
// Wohnung, 4500 kWh/Jahr – der uebliche Vergleichswert.
const KATEGORIE_RE = /^[HC][1-8]$/;

// Prueft und vereinheitlicht die Anfrage. Liefert { bfs, jahr, kategorie } oder { fehler }.
function elcomParameter(q = {}, heute = new Date()) {
  const bfs = q.gemeinde == null || q.gemeinde === '' ? KAISERAUGST : Number(q.gemeinde);
  if (!Number.isInteger(bfs) || bfs < 1 || bfs > 9999) return { fehler: 'gemeinde: BFS-Nummer (z. B. 4252 für Kaiseraugst)' };
  const jahr = q.jahr == null || q.jahr === '' ? heute.getFullYear() : Number(q.jahr);
  if (!Number.isInteger(jahr) || jahr < 2009 || jahr > heute.getFullYear() + 1) return { fehler: `jahr: 2009 bis ${heute.getFullYear() + 1}` };
  const kategorie = String(q.kategorie || 'H4').toUpperCase();
  if (!KATEGORIE_RE.test(kategorie)) return { fehler: 'kategorie: H1–H8 oder C1–C7' };
  return { bfs, jahr, kategorie };
}

// SPARQL fuer genau ein Profil. Nur geprüfte Zahlen/Kategorien werden eingesetzt.
function elcomAbfrage({ bfs, jahr, kategorie }) {
  if (!Number.isInteger(bfs) || !Number.isInteger(jahr) || !KATEGORIE_RE.test(kategorie)) throw new Error('ungültige Parameter');
  return `PREFIX cube: <https://cube.link/>
PREFIX schema: <http://schema.org/>
PREFIX d: <${CUBE}/dimension/>
SELECT ?operator ?opname ?gemeinde ?total ?energy ?gridusage ?charge ?aidfee ?meteringrate WHERE {
  <${CUBE}> cube:observationSet/cube:observation ?obs .
  ?obs d:municipality <https://ld.admin.ch/municipality/${bfs}> ;
       d:period ?period ;
       d:category <${CUBE}/category/${kategorie}> ;
       d:product <${CUBE}/product/standard> ;
       d:operator ?operator ; d:total ?total ;
       d:energy ?energy ; d:gridusage ?gridusage ; d:charge ?charge ; d:aidfee ?aidfee .
  OPTIONAL { ?obs d:meteringrate ?meteringrate }
  OPTIONAL { ?operator schema:name ?opname }
  OPTIONAL { <https://ld.admin.ch/municipality/${bfs}> schema:name ?gemeinde }
  FILTER(STR(?period) = "${jahr}")
}`;
}

const zahl = (b, k) => {
  const v = b?.[k]?.value;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r3 = n => n == null ? null : Math.round(n * 1000) / 1000;

// SPARQL-JSON -> Antwort. Mehrere Netzbetreiber in einer Gemeinde: der guenstigste
// (stabil, damit der Vergleich nicht springt); alle stehen in `netzbetreiber_alle`.
function elcomAuswerten(json, { bfs, jahr, kategorie }, stand = new Date()) {
  const zeilen = (json?.results?.bindings || [])
    .map(b => ({
      netzbetreiber: b.opname?.value || null,
      gemeinde: b.gemeinde?.value || null,
      total: zahl(b, 'total'), energie: zahl(b, 'energy'), netz: zahl(b, 'gridusage'),
      abgaben: zahl(b, 'charge'), kev: zahl(b, 'aidfee'), messung: zahl(b, 'meteringrate'),
    }))
    .filter(z => z.total != null)
    .sort((a, b) => a.total - b.total || String(a.netzbetreiber).localeCompare(String(b.netzbetreiber)));
  if (!zeilen.length) return null;
  const z = zeilen[0];
  return {
    quelle: 'elcom',
    gemeinde: z.gemeinde,
    bfs, jahr, kategorie,
    netzbetreiber: z.netzbetreiber,
    rp_kwh: { total: r3(z.total), energie: r3(z.energie), netz: r3(z.netz), abgaben: r3(z.abgaben), kev: r3(z.kev), messung: r3(z.messung) },
    chf_kwh: Math.round(z.total * 1000) / 100000,
    netzbetreiber_alle: zeilen.length > 1 ? [...new Set(zeilen.map(x => x.netzbetreiber))] : undefined,
    stand: stand.toISOString(),
  };
}

// Zwischenspeicher: Schluessel "bfs|jahr|kategorie" -> { wert, geholt }
function elcomDienst({ holen = globalThis.fetch, jetzt = () => Date.now(), ttl = TAG_MS } = {}) {
  const speicher = new Map();
  const laufend = new Map();

  async function abfragen(p) {
    const res = await holen(LINDAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: new URLSearchParams({ query: elcomAbfrage(p) }).toString(),
      signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
    });
    if (!res.ok) throw new Error(`LINDAS HTTP ${res.status}`);
    return elcomAuswerten(await res.json(), p, new Date(jetzt()));
  }

  // elcomPreis(gemeinde, jahr, kategorie) -> Antwort oder null (keine Daten).
  // Wirft nur, wenn LINDAS nicht antwortet UND nichts zwischengespeichert ist.
  async function elcomPreis(gemeinde, jahr, kategorie) {
    const p = elcomParameter({ gemeinde, jahr, kategorie });
    if (p.fehler) throw Object.assign(new Error(p.fehler), { status: 400 });
    const key = `${p.bfs}|${p.jahr}|${p.kategorie}`;
    const alt = speicher.get(key);
    if (alt && jetzt() - alt.geholt < ttl) return alt.wert;
    if (laufend.has(key)) return laufend.get(key);
    const auftrag = (async () => {
      try {
        const wert = await abfragen(p);
        speicher.set(key, { wert, geholt: jetzt() });
        return wert;
      } catch (e) {
        if (alt) return { ...alt.wert, veraltet: true };
        throw e;
      } finally { laufend.delete(key); }
    })();
    laufend.set(key, auftrag);
    return auftrag;
  }
  return { elcomPreis, _speicher: speicher };
}

const standard = elcomDienst();

module.exports = {
  elcomPreis: (...a) => standard.elcomPreis(...a),
  elcomDienst, elcomParameter, elcomAbfrage, elcomAuswerten,
  KAISERAUGST,
};
