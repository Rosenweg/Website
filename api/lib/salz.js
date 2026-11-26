// Salzvorrat der Enthärtungsanlagen — reine Rechnung, ohne Datenbank.
//
// Getrennt von routes/salz.js, damit sich Reichweite und Meldeentscheid ohne
// Postgres prüfen lassen (api/test/salz.test.js, `node --test`).
//
// Grundidee (Entscheid Stefan 26.11.2026): nachbestellen, wenn der Vorrat
// eines Lagers nach dem bisherigen Verbrauch nur noch wenige Wochen reicht.
// Solange es zu wenig Verbrauchsdaten gibt, gilt ein fester Mindestbestand.

const TAG_MS = 24 * 60 * 60 * 1000;
const WOCHE_MS = 7 * TAG_MS;

// Betrachtet wird nur das letzte halbe Jahr: ändert sich der Verbrauch (mehr
// Bewohner, neue Einstellung der Anlage), soll die Rechnung das bald merken.
const FENSTER_TAGE = 182;
// Mindestens so viele Einfüllungen im Fenster, die so weit auseinanderliegen,
// bevor die Reichweite zählt. Zwei Säcke an einem Nachmittag sagen nichts.
const MIN_EINFUELLUNGEN = 3;
const MIN_SPANNE_TAGE = 14;

/**
 * Verbrauch in kg pro Woche aus den Einfüllungen eines Lagers.
 *
 * Ein Sack, der am Tag t eingefüllt wird, wird bis zur nächsten Einfüllung
 * verbraucht. Die Säcke der Einfüllungen 1..n-1 decken also die Zeit von der
 * ersten bis zur letzten Einfüllung. Der zuletzt eingefüllte Sack zählt nicht
 * mit — er ist noch nicht aufgebraucht.
 *
 * @param {Array<{am: Date|string, kg: number}>} einfuellungen  beliebige Reihenfolge
 * @param {Date} jetzt
 * @returns {{kgProWoche: number|null, einfuellungen: number, spanneTage: number}}
 *   kgProWoche null = zu wenig Daten
 */
function verbrauchProWoche(einfuellungen, jetzt = new Date()) {
  const ab = jetzt.getTime() - FENSTER_TAGE * TAG_MS;
  const liste = (einfuellungen || [])
    .map(e => ({ t: new Date(e.am).getTime(), kg: Number(e.kg) || 0 }))
    .filter(e => Number.isFinite(e.t) && e.t >= ab && e.t <= jetzt.getTime() && e.kg > 0)
    .sort((a, b) => a.t - b.t);
  const n = liste.length;
  const spanneMs = n >= 2 ? liste[n - 1].t - liste[0].t : 0;
  const spanneTage = Math.round(spanneMs / TAG_MS * 10) / 10;
  if (n < MIN_EINFUELLUNGEN || spanneMs < MIN_SPANNE_TAGE * TAG_MS) {
    return { kgProWoche: null, einfuellungen: n, spanneTage };
  }
  const kg = liste.slice(0, -1).reduce((s, e) => s + e.kg, 0);
  return { kgProWoche: kg / (spanneMs / WOCHE_MS), einfuellungen: n, spanneTage };
}

/**
 * Stand eines Lagers: reicht der Vorrat noch?
 *
 * @param {object} p
 * @param {number} p.bestandSaecke
 * @param {number} p.bestandKg
 * @param {number|null} p.kgProWoche     aus verbrauchProWoche
 * @param {number} p.schwelleWochen      z. B. 4
 * @param {number} p.mindestSaecke       Rückfall ohne Verbrauchsdaten
 * @returns {{modus: 'reichweite'|'mindestbestand', reichweiteWochen: number|null, knapp: boolean}}
 */
function lagerStand({ bestandSaecke, bestandKg, kgProWoche, schwelleWochen, mindestSaecke }) {
  const saecke = Number(bestandSaecke) || 0;
  if (kgProWoche && kgProWoche > 0) {
    const wochen = Math.max(0, Number(bestandKg) || 0) / kgProWoche;
    const reichweiteWochen = Math.round(wochen * 10) / 10;
    return { modus: 'reichweite', reichweiteWochen, knapp: saecke <= 0 || wochen < Number(schwelleWochen) };
  }
  return { modus: 'mindestbestand', reichweiteWochen: null, knapp: saecke <= Number(mindestSaecke) };
}

/**
 * Was soll der Meldelauf für ein Lager tun?
 *
 * Eine Meldung pro Unterschreitung. Bleibt das Lager knapp, kommt nach
 * `wiederholungTage` eine Erinnerung — gezählt ab der letzten Meldung oder
 * der letzten Anlieferung, je nachdem was später war: wer eine Teillieferung
 * bucht, hat gerade gehandelt und braucht nicht am nächsten Tag die nächste Mail.
 * Reicht der Vorrat wieder, wird die Unterschreitung beendet (ohne Mail).
 *
 * @returns {'melden'|'erinnern'|'entwarnen'|'nichts'}
 */
function meldeEntscheid({ knapp, meldungSeit, meldungZuletzt, letzteAnlieferung, wiederholungTage, jetzt = new Date() }) {
  if (!knapp) return meldungSeit ? 'entwarnen' : 'nichts';
  if (!meldungSeit) return 'melden';
  const tage = Number(wiederholungTage);
  if (!(tage > 0)) return 'nichts';
  const bezug = Math.max(
    meldungZuletzt ? new Date(meldungZuletzt).getTime() : 0,
    letzteAnlieferung ? new Date(letzteAnlieferung).getTime() : 0,
  );
  return jetzt.getTime() - bezug >= tage * TAG_MS ? 'erinnern' : 'nichts';
}

/** "1 Woche", "2.5 Wochen" */
function wochenText(n) {
  return `${n} ${Number(n) === 1 ? 'Woche' : 'Wochen'}`;
}

/** Reichweite in Worten: unter einer Woche nicht "0 Wochen". */
function reichtText(n) {
  return Number(n) < 1 ? 'weniger als 1 Woche' : `etwa ${wochenText(n)}`;
}

/** Text der Mail an die Technik. Keine Personendaten. */
function meldungsText({ lager, ort, stand, bestandSaecke, bestandKg, kgProWoche, schwelleWochen, mindestSaecke, erinnerung, portalUrl }) {
  const zeilen = [];
  zeilen.push(erinnerung
    ? `Erinnerung: Im Salzlager ${lager} ist noch immer zu wenig Salz.`
    : `Im Salzlager ${lager} wird das Salz knapp. Bitte nachbestellen.`);
  if (ort) zeilen.push(`Ort: ${ort}`);
  zeilen.push('');
  zeilen.push(`Bestand: ${bestandSaecke} ${bestandSaecke === 1 ? 'Sack' : 'Säcke'} (${Math.round(bestandKg)} kg)`);
  if (stand.modus === 'reichweite') {
    zeilen.push(`Reicht noch: ${reichtText(stand.reichweiteWochen)} (Meldung unter ${wochenText(schwelleWochen)})`);
    zeilen.push(`Verbrauch bisher: etwa ${Math.round(kgProWoche * 10) / 10} kg pro Woche`);
  } else {
    zeilen.push(`Noch zu wenig Verbrauchsdaten für eine Reichweite — Meldung ab ${mindestSaecke} Säcken oder weniger.`);
  }
  zeilen.push('');
  zeilen.push('Ist die Lieferung da, in der App „Rosenweg Salz“ auf „Anlieferung“ tippen und den Sack scannen.');
  if (portalUrl) zeilen.push(`Übersicht und Einstellungen: ${portalUrl}`);
  return zeilen.join('\n');
}

module.exports = {
  FENSTER_TAGE, MIN_EINFUELLUNGEN, MIN_SPANNE_TAGE,
  verbrauchProWoche, lagerStand, meldeEntscheid, meldungsText, wochenText, reichtText,
};
