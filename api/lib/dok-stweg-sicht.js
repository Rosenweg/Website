// Eigentuemer-Unterlagen und Bewohner-Material im Ordner einer STWEG
// (Entscheid Stefan 28.11.2026, Datenschutz):
//
//   stwegN/bewohner/**   Bewohner-Material (Hausordnung, Schilder, Hinweise):
//                        Bewohner, Eigentuemer, Ausschuss, Verwaltung der STWEG
//   alles andere in stwegN/ (Wurzeldateien, jeder andere Unterordner, auch
//                        kuenftige): Eigentuemer-Unterlagen, nur Eigentuemer,
//                        Ausschuss und Verwaltung der STWEG
//
// Technik/Praesident sehen alles (prueft der Aufrufer vorher). Ein reiner
// Bewohner (Mieter, Mitbewohner) steht nur in der Bewohnergruppe der STWEG,
// nicht in deren Eigentuemer-/Ausschuss-/Verwaltungsgruppe. Wer selbst
// bewohnt, ist auch Eigentuemer; Wohnungs-Verwalter (Vertreter eines
// Eigentuemers) liegen in der Eigentuemergruppe und zaehlen als Eigentuemer.
//
// Gleiche Regel fuer Samba: fileserver-lxc/ordnerrechte/tabelle.txt (Zeilen
// stwegN und stwegN/bewohner) und die Nextcloud-Einbindungen
// (nextcloud-lxc/einbindungen-ablage.md). Alle drei zusammen aendern.
const { STWEG_GROUPS, isVerwaltungFor } = require('./groups');

const BEWOHNER_ORDNER = 'bewohner';

/** Zugang zum Ordner der STWEG nr: 'voll' | 'bewohner' | null */
function stwegDokZugang(groups, nr) {
  groups = groups || [];
  const n = Number(nr);
  const m = STWEG_GROUPS[n];
  if (!m) return null;
  if (isVerwaltungFor(groups, n)) return 'voll';
  const lower = new Set(groups.map(g => String(g).toLowerCase()));
  const hat = rolle => !!m[rolle] && lower.has(m[rolle].toLowerCase());
  if (hat('ausschuss') || hat('eigentuemer')) return 'voll';
  if (hat('bewohner')) return 'bewohner';
  return null;
}

/** Liegt der Pfad (stwegN/...) im Bewohner-Ordner? Genau "bewohner", wie auf dem Fileserver. */
function istBewohnerPfad(filePath) {
  const seg = String(filePath || '').split('/').filter(x => x && x !== '.');
  return seg.length >= 2 && seg[1] === BEWOHNER_ORDNER;
}

/** Darf das Konto diesen Pfad im Ordner der STWEG nr lesen? */
function stwegDokErlaubt(filePath, groups, nr) {
  const z = stwegDokZugang(groups, nr);
  if (z === 'voll') return true;
  if (z === 'bewohner') return istBewohnerPfad(filePath);
  return false;
}

module.exports = { BEWOHNER_ORDNER, stwegDokZugang, istBewohnerPfad, stwegDokErlaubt };
