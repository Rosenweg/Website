// Wer darf Projekte (projekte.html, /api/projects…) lesen und kommentieren?
// Eine Regel fuer die Routen in server.js, lib/doodle.js und die Tests
// (Befund V1; Funde R1/R2/D2, Entscheid Stefan 28.11.2026).
//
//   lesen        je Projekt (projektLesen): Technik/Praesident, Eigentuemer
//                der STWEG des Projekts bzw. jeder Eigentuemer bei
//                Kooperations-Projekten (F5), wer das Projekt
//                bearbeiten darf (Ausschuss der STWEG bzw. jeder Ausschuss bei
//                Kooperations-Projekten, auch ohne Eigentuemergruppe – R2) und
//                die Hausverwaltung mit Seitenrecht „projekte“ ab lesen nur fuer
//                Projekte ihrer STWEG(s) und Kooperations-Projekte (R1, gleich
//                wie bei den Dateien in projektDokRecht).
//                Reine Bewohner (Mieter) lesen nichts – auch keine Titel
//                (projects-mini, doodle/projects) und keine Projekt-Umfragen.
//   kommentieren wer das Projekt lesen darf (projektLesen), auch die Verwaltung
//                (Entscheid Stefan 28.11.2026, P10: sie liest mit und muss
//                antworten koennen). Eigene Kommentare 15 Minuten aendern oder
//                loeschen, danach nur, wer das Projekt bearbeitet.
//   loeschen     ein ganzes Projekt nur Technik/Praesident, mit Protokoll (P12).
//   bearbeiten   projektBearbeiten (unten).
//
// STWEG-gebunden sind auch die Auslagen eines Projekts: die Verwaltung sieht
// nur die ihrer STWEG(s) (lib/stweg-sicht.js), wie auf auslagen.html.
const { STWEG_GROUPS, isTechnik, isPraesident, isVerwaltungForAny, isVerwaltungFor, verwaltungStwegs, verwaltetAlleStwegs, getAusschussStwegs, isAusschussForAny } = require('./groups');
const { stwegSicht } = require('./stweg-sicht');

const STUFE = { read: 1, write: 2 };

function istEigentuemer(groups) {
  return (groups || []).some(g => String(g).toLowerCase().includes('eigentuemer'));
}

function ohne(stweg) { return stweg === null || stweg === undefined || stweg === ''; }

// Eigentuemer der STWEG nr (Eigentuemergruppe; dort liegen auch Wohnungs-Verwalter)
function eigentuemerVon(groups, nr) {
  const m = STWEG_GROUPS[Number(nr)];
  if (!m || !m.eigentuemer) return false;
  return (groups || []).some(x => String(x).toLowerCase() === m.eigentuemer.toLowerCase());
}

// Darf das Konto dieses Projekt (STWEG stweg, null = Kooperation) lesen?
// F5 (Entscheid Stefan 28.11.2026): Eigentuemer nur Projekte ihrer STWEG(s)
// und Kooperations-Projekte (jede Eigentuemergruppe).
function projektLesen(groups, perm, stweg) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  if (ohne(stweg) ? istEigentuemer(g) : eigentuemerVon(g, stweg)) return true;
  if (projektBearbeiten(g, perm, stweg)) return true;
  if ((STUFE[perm] || 0) < 1) return false;
  return ohne(stweg) ? isVerwaltungForAny(g) : isVerwaltungFor(g, Number(stweg));
}

// Darf das Konto ueberhaupt irgendein Projekt lesen (Seite, Liste)?
function projekteLesen(groups, perm) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g) || istEigentuemer(g)) return true;
  if (isAusschussForAny(g)) return true;                      // R2: Ausschuss ohne Eigentuemergruppe
  return isVerwaltungForAny(g) && (STUFE[perm] || 0) >= 1;
}

// Nur die lesbaren Projekte einer Liste [{ stweg, … }]
function lesbareProjekte(groups, perm, projekte) {
  return (projekte || []).filter(p => p && projektLesen(groups, perm, p.stweg));
}

// Auslagen eines Projekts (D3): die E-Mail der einreichenden Person sehen nur
// Technik/Praesident und die Verwaltung der STWEG der Auslage; alle anderen
// (Eigentuemer, Ausschuss) nur den Namen.
function auslageEmailSehen(groups, stweg) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  return !ohne(stweg) && isVerwaltungFor(g, Number(stweg));
}

// Kommentare (D4): neben dem Kommentar steht nur der Name, nie die E-Mail.
// eigene = Kommentar des Kontos (fuer die Anzeige „du“).
function kommentarOhneEmail(k, email) {
  if (!k || typeof k !== 'object') return k;
  const { user_email, ...rest } = k;
  const e = String(email || '').trim().toLowerCase();
  return { ...rest, eigener: !!e && String(user_email || '').trim().toLowerCase() === e };
}

// ─── Oeffentliche Projekte (D1, Entscheid Stefan 28.11.2026) ──────────
// Ohne Anmeldung nur Titel, Beschreibung, Status, Zeitachse, Kandidaten ohne
// Offertbetrag/-details/Bewertung (und ohne Kontakte/Notizen) und nur Anhaenge,
// die ausdruecklich als oeffentlich markiert sind (project_attachments.oeffentlich).
const OEFFENTLICH_KANDIDAT = ['id', 'name', 'webseite', 'status'];
function oeffentlicherKandidat(k) {
  const out = {};
  for (const f of OEFFENTLICH_KANDIDAT) if (k && k[f] !== undefined) out[f] = k[f];
  return out;
}
function oeffentlicheAnhaenge(anhaenge) {
  return (anhaenge || []).filter(a => a && a.oeffentlich === true)
    .map(a => ({ id: a.id, target_type: a.target_type, target_id: a.target_id, doc_path: a.doc_path }));
}

// Kommentieren (P10): wer das Projekt lesen darf. Gleiche Regel wie projektLesen.
function projektKommentieren(groups, perm, stweg) {
  return projektLesen(groups, perm, stweg);
}

// Eigene Kommentare aendern oder loeschen: nur der Verfasser, nur kurz danach.
const KOMMENTAR_FRIST_MIN = 15;
function kommentarEigenAenderbar(kommentar, email, jetzt = Date.now()) {
  if (!kommentar || !email) return false;
  if (String(kommentar.user_email || '').trim().toLowerCase() !== String(email).trim().toLowerCase()) return false;
  const t = new Date(kommentar.created_at).getTime();
  return Number.isFinite(t) && jetzt - t <= KOMMENTAR_FRIST_MIN * 60000;
}

// Ein ganzes Projekt loeschen (P12): nur Technik/Praesident. Alle anderen
// setzen den Status auf „archiviert“.
function projektLoeschen(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g);
}

// Abgeleitetes Seitenrecht fuer /api/auth/me: „projekte-bearbeiten“ = write, wenn
// das Konto irgendein Projekt anlegen oder bearbeiten darf (Technik/Praesident,
// Ausschuss, Verwaltung mit projekte = schreiben). Die Farbe der App Rosenweg
// Projekte folgt ihm (blau); Verwaltung mit nur „lesen“ bleibt rot.
function projekteBearbeitenRecht(groups, perm) {
  return darfAnlegen(projektAnlegenAuswahl(groups, perm)) ? 'write' : undefined;
}

// Gelesene Projekte nach ?stweg=3|8|allgemein und ?status=aktiv,geplant (L1)
function projekteFiltern(projekte, { stweg, status } = {}) {
  let l = projekte || [];
  if (stweg !== undefined && stweg !== null && String(stweg) !== '') {
    const w = String(stweg).toLowerCase();
    l = l.filter(p => (w === 'allgemein' || w === 'kooperation') ? ohne(p.stweg) : String(p.stweg) === w);
  }
  if (status) {
    const erlaubt = new Set(String(status).split(',').map(x => x.trim()).filter(Boolean));
    l = l.filter(p => erlaubt.has(p.status));
  }
  return l;
}

// Teil-Update (L4): nur die gesendeten Felder setzen. spalten = erlaubte Namen.
// -> { sets: ['a = $1', …], werte: [...] } (Platzhalter ab $start). Leerer Text = NULL.
function teilUpdate(body, spalten, start = 1) {
  const sets = [];
  const werte = [];
  for (const sp of spalten) {
    if (body && Object.prototype.hasOwnProperty.call(body, sp) && body[sp] !== undefined) {
      werte.push(body[sp] === '' ? null : body[sp]);
      sets.push(`${sp} = $${start + werte.length - 1}`);
    }
  }
  return { sets, werte };
}

// Zeitachsen-Eintrag als Termin in Rosenweg Termine (P7): Felder fuer stweg_events.
// Kooperations-Projekte (stweg NULL) laufen unter der MEG (Nummer 8).
const TERMIN_KOOPERATION = 8;
function terminAusEintrag(projekt, eintrag) {
  const datum = String(eintrag.datum || '').slice(0, 10);
  const zeit = /^\d{2}:\d{2}/.test(String(eintrag.uhrzeit || '')) ? String(eintrag.uhrzeit).slice(0, 5) : null;
  return {
    stweg: ohne(projekt.stweg) ? TERMIN_KOOPERATION : Number(projekt.stweg),
    title: `Projekt ${projekt.title}: ${eintrag.titel}`.slice(0, 255),
    description: [eintrag.beschreibung, `Projekt „${projekt.title}“ (projekt/${projekt.slug})`].filter(Boolean).join('\n\n').slice(0, 4000),
    start_date: `${datum} ${zeit || '00:00'}:00`,
    all_day: !zeit,
    location: eintrag.ort ? String(eintrag.ort).slice(0, 255) : null,
    category: 'sonstiges',
  };
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
  // Gleiche Leseregel wie das Projekt selbst (projektLesen)
  return { lesen: projektLesen(g, perm, stweg), schreiben: projektBearbeiten(g, perm, stweg) };
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
  projekteLesen, projektLesen, lesbareProjekte, auslageEmailSehen, kommentarOhneEmail,
  OEFFENTLICH_KANDIDAT, oeffentlicherKandidat, oeffentlicheAnhaenge,
  projektKommentieren, kommentarEigenAenderbar, KOMMENTAR_FRIST_MIN, projektLoeschen, projekteBearbeitenRecht,
  projekteFiltern, teilUpdate, terminAusEintrag, TERMIN_KOOPERATION, projektAuslagenSicht,
  projektBearbeiten, projektAnlegenAuswahl, darfAnlegen, slugAusTitel, PROJEKT_STATUS,
  projektDokRecht,
};
