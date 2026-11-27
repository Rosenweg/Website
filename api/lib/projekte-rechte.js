// Wer darf Projekte (projekte.html, /api/projects…) lesen und kommentieren?
// Eine Regel fuer die Routen in server.js und die Tests (Befund V1).
//
//   lesen        Technik/Praesident, jede Eigentuemergruppe (wie bisher) und die
//                Hausverwaltung (stwegN-verwaltung, Übergang „Verwaltung“) mit
//                Seitenrecht „projekte“ ab lesen.
//   kommentieren Technik/Praesident und Eigentuemer (unveraendert); die
//                Verwaltung liest nur.
//   bearbeiten   unveraendert Ausschuss/Technik (requireAusschussOrTechnik).
//
// Projekte haben keine STWEG (Projekte der STWEG-Kooperation, Tabelle projects
// ohne Spalte stweg) – sie sieht jede Verwaltung. STWEG-gebunden sind die
// Auslagen eines Projekts: die Verwaltung sieht nur die ihrer STWEG(s)
// (lib/stweg-sicht.js), wie auf auslagen.html.
const { isTechnik, isPraesident, isVerwaltungForAny, isVerwaltungFor, verwaltungStwegs, verwaltetAlleStwegs, getAusschussStwegs, isAusschussForAny } = require('./groups');
const { stwegSicht } = require('./stweg-sicht');

const STUFE = { read: 1, write: 2 };

function istEigentuemer(groups) {
  return (groups || []).some(g => String(g).toLowerCase().includes('eigentuemer'));
}

function projekteLesen(groups, perm) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g) || istEigentuemer(g)) return true;
  return isVerwaltungForAny(g) && (STUFE[perm] || 0) >= 1;
}

function projekteKommentieren(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g) || istEigentuemer(g);
}

// Auslagen eines Projekts: null = alle (wie bisher fuer Eigentuemer/Technik),
// sonst eine Sicht aus lib/stweg-sicht.js (nur die eigenen STWEGs).
function projektAuslagenSicht(groups) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g) || istEigentuemer(g)) return null;
  return stwegSicht(g);
}

// ─── Anlegen und bearbeiten (Entscheid Stefan 27.11.2026) ─────────────
// Ein Projekt gehoert einer STWEG (projects.stweg) oder der ganzen Kooperation
// (stweg NULL). Anlegen und bearbeiten (Daten, Termine, Offerten, Budget,
// Anhaenge, oeffentlich) duerfen:
//   Technik/Praesident   alles
//   Ausschuss            Projekte seiner STWEG(s); Kooperations-Projekte wie
//                        bisher jeder Ausschuss
//   Verwaltung           mit Seitenrecht „projekte“ = schreiben Projekte ihrer
//                        STWEG(s); Kooperations-Projekte nur eine Verwaltung
//                        aller STWEGs
function projektBearbeiten(groups, perm, stweg) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  const verwSchreiben = (STUFE[perm] || 0) >= 2;
  if (stweg === null || stweg === undefined || stweg === '') {
    return isAusschussForAny(g) || (verwSchreiben && verwaltetAlleStwegs(g));
  }
  const n = Number(stweg);
  return getAusschussStwegs(g).has(n) || (verwSchreiben && isVerwaltungFor(g, n));
}

// Fuer das Formular „Neues Projekt“: welche STWEG darf das Konto waehlen?
// { alle, stwegs: [..], ohneStweg }  – nichts davon = kein Knopf.
function projektAnlegenAuswahl(groups, perm) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { alle: true, stwegs: [1, 2, 3, 4, 5, 6, 7, 8], ohneStweg: true };
  const s = getAusschussStwegs(g);
  if ((STUFE[perm] || 0) >= 2) for (const n of verwaltungStwegs(g)) s.add(n);
  return { alle: false, stwegs: [...s].sort((a, b) => a - b), ohneStweg: projektBearbeiten(g, perm, null) };
}

function darfAnlegen(auswahl) {
  return !!(auswahl && (auswahl.alle || auswahl.ohneStweg || auswahl.stwegs.length));
}

// ─── Dokumente eines Projekts (Ordner projekte/<slug>/…, Befund P1) ────
// Gleiche Regel wie das Projekt selbst: hochladen, loeschen, verschieben darf,
// wer das Projekt bearbeiten darf (projektBearbeiten: Ausschuss der eigenen
// STWEG bzw. jeder Ausschuss bei Kooperations-Projekten, Verwaltung mit
// „projekte“ = schreiben fuer ihre STWEG(s)). Lesen duerfen zusaetzlich alle
// Eigentuemer (wie bisher) und die Verwaltung (ab lesen) fuer Projekte ihrer
// STWEG(s) und Kooperations-Projekte.
// projektStwegs: Map slug -> stweg|null der bestehenden Projekte.
// Liefert null, wenn der Pfad nicht im Ordner projekte liegt.
function projektDokRecht(groups, perm, filePath, projektStwegs) {
  const seg = String(filePath || '').split('/').filter(x => x && x !== '.');
  if (seg[0] !== 'projekte') return null;
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { lesen: true, schreiben: true };
  const eigentuemer = istEigentuemer(g);
  // Datei direkt unter projekte/ oder unbekanntes Projekt: keinem Projekt
  // zuzuordnen – lesen wie bisher die Eigentuemer, schreiben nur Technik/Praesident.
  const slug = seg.length >= 3 ? seg[1] : null;
  if (!slug || !projektStwegs || !projektStwegs.has(slug)) return { lesen: eigentuemer, schreiben: false };
  const stweg = projektStwegs.get(slug);
  const schreiben = projektBearbeiten(g, perm, stweg);
  const ohneStweg = stweg === null || stweg === undefined || stweg === '';
  const verwLesen = (STUFE[perm] || 0) >= 1
    && (ohneStweg ? isVerwaltungForAny(g) : isVerwaltungFor(g, Number(stweg)));
  return { lesen: eigentuemer || verwLesen || schreiben, schreiben };
}

// Adresskuerzel aus dem Titel (ae/oe/ue, nur a-z0-9 und Bindestrich, max. 60)
function slugAusTitel(titel) {
  return String(titel || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'projekt';
}

const PROJEKT_STATUS = ['geplant', 'aktiv', 'abgeschlossen', 'archiviert'];

module.exports = {
  projekteLesen, projekteKommentieren, projektAuslagenSicht,
  projektBearbeiten, projektAnlegenAuswahl, darfAnlegen, slugAusTitel, PROJEKT_STATUS,
  projektDokRecht,
};
