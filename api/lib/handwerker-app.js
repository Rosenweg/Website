// Rosenweg Handwerker (App): reine Hilfen für Erinnerungen, Vorschläge aus Reparatur,
// Vertragsdokument in Unterlagen und Bewertung je Einsatz (Klärung Welle 3.3,
// E7/E8/E10; Entscheid Stefan 28.11.2026). Ohne Datenbank, damit testbar.
const { folderStwegNr } = require('./groups');
const { hwLesen } = require('./handwerker-rechte');

const TAG = 86400000;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));
const alsTag = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };

/** Tage von heute bis datum (negativ = vorbei). null bei ungültigem Datum. */
function tageBis(heute, datum) {
  const a = alsTag(ymd(heute)), b = alsTag(ymd(datum));
  return a === null || b === null ? null : Math.round((b - a) / TAG);
}

/** Letzter Tag, an dem gekündigt werden kann: endet_am minus Kündigungsfrist (Tage). null ohne beides. */
function kuendigungBis(v) {
  const ende = alsTag(ymd(v?.endet_am));
  const frist = Number.isInteger(Number(v?.kuendigungsfrist_tage)) && v?.kuendigungsfrist_tage !== null && v?.kuendigungsfrist_tage !== '' ? Number(v.kuendigungsfrist_tage) : null;
  if (ende === null || frist === null || frist < 0) return null;
  return new Date(ende - frist * TAG).toISOString().slice(0, 10);
}

/** Stufe der Erinnerung: 30 (8–30 Tage), 7 (0–7 Tage), 0 (überfällig, nur Termine). */
function stufe(tage) {
  if (tage === null) return null;
  if (tage < 0) return 0;
  if (tage <= 7) return 7;
  if (tage <= 30) return 30;
  return null;
}

/**
 * Wer bekommt die Erinnerung zu einem Vertrag der STWEG stweg? Die Verwaltung dieser
 * STWEG (schreibend); Verträge „alle STWEG“ (NULL) bekommen Technik/Präsident.
 */
function erinnerungEmpfaenger(sicht, stweg) {
  if (stweg === null || stweg === undefined || stweg === '') return sicht.alle;
  return sicht.schreiben.has(Number(stweg));
}

/**
 * Fällige Erinnerungen für ein Konto. zeilen: aktive Verträge nicht archivierter Firmen mit
 * id, handwerker_id, firma, titel, stweg, naechster_termin, endet_am, kuendigungsfrist_tage.
 * Jede Erinnerung hat einen stabilen Schlüssel je Stufe: die App meldet jede Stufe einmal.
 */
function erinnerungenFuer(sicht, zeilen, heute = new Date()) {
  const out = [];
  for (const v of zeilen || []) {
    if (!erinnerungEmpfaenger(sicht, v.stweg)) continue;
    const arten = [['termin', ymd(v.naechster_termin)], ['kuendigung', kuendigungBis(v)]];
    for (const [art, datum] of arten) {
      if (!datum) continue;
      const tage = tageBis(heute, datum);
      const s = stufe(tage);
      if (s === null || (art === 'kuendigung' && tage < 0)) continue;
      out.push({
        schluessel: `${art}-${v.id}-${datum}-${s}`,
        art, stufe: s, tage, datum,
        vertrag_id: v.id, handwerker_id: v.handwerker_id, firma: v.firma, titel: v.titel,
        stweg: v.stweg === undefined ? null : v.stweg,
      });
    }
  }
  return out.sort((a, b) => a.tage - b.tage || String(a.firma).localeCompare(String(b.firma), 'de'));
}

/**
 * Pfad eines Vertragsdokuments in Unterlagen prüfen: relativ, ohne „..“, Ordner einer STWEG
 * (stwegN/…, meg/…), die das Konto sehen darf. -> { pfad } (null = leer) | { fehler }
 */
function dokumentPfad(roh, sicht) {
  if (roh === undefined || roh === null || String(roh).trim() === '') return { pfad: null };
  const p = String(roh).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (p.length > 500) return { fehler: 'Pfad zu lang' };
  if (p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || /[\0-\x1f]/.test(p)) return { fehler: 'Ungültiger Pfad in Unterlagen' };
  const ordner = p.split('/')[0];
  const nr = folderStwegNr(ordner);
  if (nr === null || !p.includes('/')) return { fehler: 'Das Dokument liegt in Unterlagen in einem STWEG-Ordner (z. B. stweg3/Verträge/Lift.pdf)' };
  if (!hwLesen(sicht, nr)) return { fehler: 'Dieser Ordner gehört zu einer anderen STWEG' };
  return { pfad: p };
}

/** Bewertung eines Einsatzes: ganze Zahl 1–5 oder null; Text kurz und ohne Steuerzeichen. */
function bewertungNormal(b) {
  const n = b?.bewertung === undefined || b?.bewertung === null || b?.bewertung === '' ? null : parseInt(b.bewertung, 10);
  const text = b?.bewertung_text == null ? null : String(b.bewertung_text).replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 500) || null;
  const bewertung = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  return { bewertung, bewertung_text: bewertung === null ? null : text };
}

const KATEGORIE_NAME = {
  aufzug: 'Aufzug', heizung: 'Heizung', wasser: 'Wasser', tuer: 'Tür', reinigung: 'Reinigung', sonstige: 'Sonstiges',
};

/** Vorschlag für einen Einsatz aus einer erledigten Meldung (Datum, Beschreibung; Kosten trägt die Verwaltung nach). */
function einsatzVorschlag(rekl) {
  const kat = KATEGORIE_NAME[rekl?.kategorie] || (rekl?.kategorie ? String(rekl.kategorie) : null);
  const text = String(rekl?.beschreibung || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    datum: ymd(rekl?.erledigt_am) || new Date().toISOString().slice(0, 10),
    beschreibung: `Meldung #${rekl?.id}${kat ? ` (${kat})` : ''}: ${text}`.slice(0, 400),
  };
}

/**
 * Text der Benachrichtigung an die Firma (nur ein Vorschlag, die Verwaltung prüft und sendet):
 * Meldung als Ort/Beschreibung, ohne Namen der meldenden Person, Kontakt ist die Verwaltung.
 */
function auftragsMailText(rekl, absender) {
  const kat = KATEGORIE_NAME[rekl?.kategorie] || (rekl?.kategorie ? String(rekl.kategorie) : null);
  const text = String(rekl?.beschreibung || '').trim().slice(0, 1000);
  const von = absender?.name || 'die Verwaltung';
  const kontakt = [absender?.name, absender?.email].filter(Boolean).join(', ');
  return {
    betreff: `Anfrage Rosenweg${rekl?.stweg ? ` (STWEG ${rekl.stweg})` : ''}${kat ? `: ${kat}` : ''}`,
    text: [
      'Guten Tag',
      '',
      `Wir bitten Sie um einen Einsatz in der Siedlung Rosenweg${kat ? ` (${kat})` : ''}:`,
      '',
      text,
      '',
      `Bitte melden Sie sich zur Terminvereinbarung bei ${von}${kontakt ? ` (${kontakt})` : ''}.`,
      '',
      'Freundliche Grüsse',
      von,
    ].join('\n'),
  };
}

const MAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const mailOk = (a) => MAIL_RE.test(String(a || '').trim());

module.exports = {
  tageBis, kuendigungBis, stufe, erinnerungEmpfaenger, erinnerungenFuer, dokumentPfad,
  bewertungNormal, einsatzVorschlag, auftragsMailText, mailOk,
};
