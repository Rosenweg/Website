// Ablage mitgelieferter Dokumente in «Dokumente» (DOCS_PATH).
// Die Beispielmappe für die Verwaltung (docs/beispielmappe/Beispielmappe-Rosenweg.pdf,
// erzeugt mit scripts/beispielmappe/build.py) kommt mit dem API-Image mit und wird
// beim Start nach allgemein/verwaltung2026/ kopiert, wenn sie sich geändert hat.
// So landet jede neu erzeugte und gemergte Fassung nach dem Ausrollen in der Ablage.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const DATEIEN = [
  { quelle: path.join(__dirname, '..', 'ablage', 'Beispielmappe-Rosenweg.pdf'),
    ziel: 'allgemein/verwaltung2026/Beispielmappe-Rosenweg.pdf' },
];

const hash = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function ablageAbgleichen() {
  for (const d of DATEIEN) {
    try {
      const neu = await fs.readFile(d.quelle);
      const ziel = path.join(DOCS_PATH, d.ziel);
      let alt = null;
      try { alt = await fs.readFile(ziel); } catch {}
      if (alt && hash(alt) === hash(neu)) continue;
      await fs.mkdir(path.dirname(ziel), { recursive: true });
      await fs.writeFile(ziel, neu);
      console.log(`[Ablage] ${d.ziel} ${alt ? 'aktualisiert' : 'neu abgelegt'} (${neu.length} B)`);
    } catch (e) {
      if (e.code !== 'ENOENT' || !String(e.path || '').startsWith(path.join(__dirname, '..', 'ablage'))) {
        console.error(`[Ablage] ${d.ziel}:`, e.message);
      }
    }
  }
}

module.exports = { ablageAbgleichen };
