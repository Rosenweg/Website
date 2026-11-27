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

// Betrachtet wird bevorzugt das letzte halbe Jahr: ändert sich der Verbrauch
// (mehr Bewohner, neue Einstellung der Anlage), soll die Rechnung das bald merken.
const FENSTER_TAGE = 182;
// Mindestens so viele Einfüllungen (zusammengefasst, also an verschiedenen
// Tagen), die so weit auseinanderliegen, bevor die Reichweite zählt.
const MIN_EINFUELLUNGEN = 3;
const MIN_SPANNE_TAGE = 14;

// Zusammenfassen (Entscheid Stefan 27.11.2026): Wer mehrere Säcke auf einmal
// einfüllt, scannt sie einzeln — das gibt mehrere Buchungen innert Minuten.
// Liegt eine Einfüllung höchstens so viele Stunden nach der vorherigen, gehört
// sie zur selben Einfüllung (kg werden zusammengezählt).
const ZUSAMMEN_STUNDEN = 6;

// Datenlücken (Entscheid Stefan 27.11.2026): Wurde eine Zeit lang nichts
// gebucht (z. B. 2024–2026), war die Anlage nicht ohne Salz — es fehlen nur
// die Buchungen. Ein solcher Abstand zählt nicht für den Verbrauch.
// Ein Abstand ist eine Lücke, wenn er
//  - länger ist als LUECKE_FAKTOR × üblich. Üblich ist der Median aller
//    Abstände, bei einer grossen Einfüllung aber mindestens deren kg × der
//    Median der Tage je kg: 10 Säcke auf einmal halten zu Recht länger und sind
//    keine Lücke. Der Median braucht mindestens LUECKE_MIN_ABSTAENDE Abstände;
//  - oder länger als LUECKE_TAGE_JE_SACK Tage je 25 kg der vorherigen
//    Einfüllung — so lange hält ein Sack in keiner der Anlagen (das wären
//    unter 2 kg pro Woche). Gilt auch, wenn es für den Median zu wenig gibt.
const LUECKE_FAKTOR = 3;
const LUECKE_MIN_ABSTAENDE = 3;
const LUECKE_TAGE_JE_SACK = 90;
const NORM_SACK_KG = 25;

function median(werte) {
  const s = [...werte].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Einzelne Buchungen „Sack eingefüllt“ zu Einfüllungen zusammenfassen.
 *
 * @param {Array<{am: Date|string, kg: number, saecke?: number, kg_je_sack?: number}>} einfuellungen
 * @param {Date} jetzt  Buchungen danach zählen nicht
 * @returns {Array<{t: number, bis: number, kg: number, saecke: number, kgJeSack: number}>}
 *   aufsteigend; t = erste Buchung der Einfüllung, bis = letzte
 */
function einfuellungenZusammenfassen(einfuellungen, jetzt = new Date()) {
  const alle = (einfuellungen || [])
    .map(e => {
      const kg = Number(e.kg) || 0;
      const kgJeSack = Number(e.kg_je_sack ?? e.kgJeSack) || kg;
      const saecke = Number(e.saecke) || (kgJeSack > 0 ? Math.round(kg / kgJeSack) || 1 : 1);
      return { t: new Date(e.am).getTime(), kg, saecke, kgJeSack };
    })
    .filter(e => Number.isFinite(e.t) && e.t <= jetzt.getTime() && e.kg > 0)
    .sort((a, b) => a.t - b.t);
  const gruppen = [];
  for (const e of alle) {
    const g = gruppen[gruppen.length - 1];
    if (g && e.t - g.bis <= ZUSAMMEN_STUNDEN * 60 * 60 * 1000) {
      g.bis = e.t;
      g.kg += e.kg;
      g.saecke += e.saecke;
      g.kgJeSack = e.kgJeSack; // zuletzt eingefüllte Sorte
    } else {
      gruppen.push({ t: e.t, bis: e.t, kg: e.kg, saecke: e.saecke, kgJeSack: e.kgJeSack });
    }
  }
  return gruppen;
}

/**
 * Zusammengefasste Einfüllungen an den Datenlücken in Abschnitte teilen.
 * @returns {{abschnitte: Array<Array<object>>, luecken: number}}
 */
function inAbschnitte(gruppen) {
  if (!gruppen.length) return { abschnitte: [], luecken: 0 };
  const abstaende = [];
  for (let i = 1; i < gruppen.length; i++) {
    const tage = (gruppen[i].t - gruppen[i - 1].t) / TAG_MS;
    abstaende.push({ tage, kg: gruppen[i - 1].kg, tageJeKg: tage / gruppen[i - 1].kg });
  }
  const mitMedian = abstaende.length >= LUECKE_MIN_ABSTAENDE;
  const mTage = mitMedian ? median(abstaende.map(a => a.tage)) : null;
  const mTageJeKg = mitMedian ? median(abstaende.map(a => a.tageJeKg)) : null;
  const abschnitte = [[gruppen[0]]];
  abstaende.forEach((a, i) => {
    const ueberSack = a.tage > LUECKE_TAGE_JE_SACK * a.kg / NORM_SACK_KG;
    const ueblich = mitMedian ? Math.max(mTage, a.kg * mTageJeKg) : null;
    const ueberMedian = mitMedian && a.tage > LUECKE_FAKTOR * ueblich;
    if (ueberSack || ueberMedian) abschnitte.push([]);
    abschnitte[abschnitte.length - 1].push(gruppen[i + 1]);
  });
  return { abschnitte, luecken: abschnitte.length - 1 };
}

const genug = l => l.length >= MIN_EINFUELLUNGEN && l[l.length - 1].t - l[0].t >= MIN_SPANNE_TAGE * TAG_MS;

/**
 * Verbrauch in kg pro Woche aus den Einfüllungen eines Lagers.
 *
 * 1. Buchungen innert ZUSAMMEN_STUNDEN zu einer Einfüllung zusammenfassen.
 * 2. An Datenlücken in Abschnitte teilen (inAbschnitte).
 * 3. Den jüngsten Abschnitt mit genug Daten nehmen — darin bevorzugt das
 *    letzte halbe Jahr, sonst den ganzen Abschnitt. Reicht der jüngste nicht
 *    (z. B. erste Einfüllung nach einer Lücke), den letzten guten davor.
 * 4. Im gewählten Stück wird jede Einfüllung bis zur nächsten verbraucht: die
 *    kg aller Einfüllungen ausser der letzten, geteilt durch die Zeit von der
 *    ersten bis zur letzten. Die letzte ist noch nicht aufgebraucht.
 *
 * @param {Array<{am: Date|string, kg: number, saecke?: number, kg_je_sack?: number}>} einfuellungen  beliebige Reihenfolge
 * @param {Date} jetzt
 * @returns {{kgProWoche: number|null, einfuellungen: number, spanneTage: number,
 *   von: number|null, bis: number|null, aktuell: boolean, luecken: number, letzte: object|null}}
 *   kgProWoche null = zu wenig Daten. einfuellungen/spanneTage/von/bis: das
 *   gerechnete Stück. aktuell = aus dem jüngsten Abschnitt. letzte = die
 *   jüngste zusammengefasste Einfüllung überhaupt (auch ohne Verbrauch).
 */
function verbrauchProWoche(einfuellungen, jetzt = new Date()) {
  const gruppen = einfuellungenZusammenfassen(einfuellungen, jetzt);
  const letzte = gruppen.length ? gruppen[gruppen.length - 1] : null;
  const { abschnitte, luecken } = inAbschnitte(gruppen);
  const ab = jetzt.getTime() - FENSTER_TAGE * TAG_MS;
  let liste = null;
  let aktuell = false;
  for (let i = abschnitte.length - 1; i >= 0 && !liste; i--) {
    const fenster = abschnitte[i].filter(e => e.t >= ab);
    if (genug(fenster)) liste = fenster;
    else if (genug(abschnitte[i])) liste = abschnitte[i];
    if (liste) aktuell = i === abschnitte.length - 1;
  }
  const leer = abschnitte.length ? abschnitte[abschnitte.length - 1] : [];
  const l = liste || leer;
  const n = l.length;
  const spanneMs = n >= 2 ? l[n - 1].t - l[0].t : 0;
  const spanneTage = Math.round(spanneMs / TAG_MS * 10) / 10;
  const basis = { einfuellungen: n, spanneTage, von: n ? l[0].t : null, bis: n ? l[n - 1].t : null, luecken, letzte };
  if (!liste) return { kgProWoche: null, aktuell: false, ...basis };
  const kg = l.slice(0, -1).reduce((s, e) => s + e.kg, 0);
  return { kgProWoche: kg / (spanneMs / WOCHE_MS), aktuell, ...basis };
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

// ─── Nächster Sack (Wunsch Stefan 26./27.11.2026) ─────────────────

/** Kalendertag in Zürich als 'YYYY-MM-DD'. */
function zuerichTag(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(d));
}

/** Stunde (0–23) in Zürich. */
function zuerichStunde(d = new Date()) {
  return Number(new Intl.DateTimeFormat('de-CH', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Zurich' })
    .formatToParts(new Date(d)).find(t => t.type === 'hour')?.value);
}

/** Ganze Tage von Tag a bis Tag b ('YYYY-MM-DD'). */
function tageZwischen(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / TAG_MS);
}

/** Tag (Zürich), an dem ab `am` so viele kg beim Verbrauch aufgebraucht sind. */
function tagNachVerbrauch(am, kg, kgProWoche) {
  if (!am || !(Number(kg) > 0) || !(Number(kgProWoche) > 0)) return null;
  const t = new Date(am).getTime();
  if (!Number.isFinite(t)) return null;
  return zuerichTag(t + Number(kg) / Number(kgProWoche) * WOCHE_MS);
}

/**
 * Wann ist in der Anlage wieder Platz für einen Sack? (Präzisierung Stefan
 * 27.11.2026: „wann ein Sack aufgebraucht ist und wieder ersetzt werden soll“.)
 * Letzte (zusammengefasste) Einfüllung + ein Sack ÷ kg pro Woche, auf den Tag
 * (Zürich). Auch nach 10 Säcken auf einmal ist nach einem Sack Verbrauch
 * wieder Platz. Nach jeder Einfüllung neu ab dieser gerechnet.
 * null, wenn es keinen Verbrauch oder keine Einfüllung gibt.
 */
function naechsterSack({ letzteAm, sackKg, kgProWoche }) {
  return tagNachVerbrauch(letzteAm, sackKg, kgProWoche);
}

/** Bis wann reicht alles, was zuletzt eingefüllt wurde? (ohne Rest von früher) */
function inhaltReichtBis({ letzteAm, letzteKg, kgProWoche }) {
  return tagNachVerbrauch(letzteAm, letzteKg, kgProWoche);
}

/**
 * Hinweis, wenn es (noch) keinen Termin gibt — sonst null.
 * Klar sagen, was fehlt, statt einfach nichts zu zeigen.
 */
function prognoseHinweis({ letzte, kgProWoche }) {
  if (!letzte) return 'Noch keine Einfüllung gebucht – darum noch kein Termin für den nächsten Sack.';
  if (!(Number(kgProWoche) > 0)) {
    return `Noch zu wenig Daten für eine Schätzung: Es braucht mindestens ${MIN_EINFUELLUNGEN} Einfüllungen `
      + `an verschiedenen Tagen über ${MIN_SPANNE_TAGE / 7} Wochen.`;
  }
  return null;
}

// Erinnerung schon so viele Tage vor dem geschätzten Tag (der Tag ist eine
// Schätzung; wer am Vorabend Bescheid weiss, kann einplanen). Danach wird bis
// NACHHOLEN_TAGE nach dem Tag nachgeholt (Server war weg). Ältere
// Fälligkeiten — etwa aus importierten alten Listen — lösen nichts aus.
const VORLAUF_TAGE = 1;
const NACHHOLEN_TAGE = 2;
// Mails nur tagsüber.
const ERINNERUNG_AB_STUNDE = 8;
const ERINNERUNG_BIS_STUNDE = 20;

/**
 * Soll jetzt an das Einfüllen erinnert werden?
 *
 * Einmal je Fälligkeit: gemeldetAm ist der Zeitpunkt der letzten Erinnerung,
 * letzteEinfuellung der Beginn der letzten (zusammengefassten) Einfüllung.
 * Wurde seit der letzten Einfüllung schon erinnert, kommt nichts mehr — auch
 * wenn sich der geschätzte Tag noch um einen Tag verschiebt. Erst die nächste
 * Einfüllung startet eine neue Fälligkeit.
 * @returns {boolean}
 */
function einfuellErinnern({ faellig, gemeldetAm, letzteEinfuellung, eingeschaltet, inBetrieb, jetzt = new Date() }) {
  if (!faellig || !eingeschaltet || !inBetrieb) return false;
  if (gemeldetAm && (!letzteEinfuellung || new Date(gemeldetAm).getTime() >= new Date(letzteEinfuellung).getTime())) return false;
  const tage = tageZwischen(faellig, zuerichTag(jetzt));
  if (tage < -VORLAUF_TAGE || tage > NACHHOLEN_TAGE) return false;
  const stunde = zuerichStunde(jetzt);
  return stunde >= ERINNERUNG_AB_STUNDE && stunde < ERINNERUNG_BIS_STUNDE;
}

/** "Donnerstag, 3. Dezember" */
function tagText(tag) {
  return new Intl.DateTimeFormat('de-CH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(tag + 'T12:00:00Z'));
}

/** "etwa morgen (Donnerstag, 3. Dezember)" usw. — der Tag ist eine Schätzung. */
function faelligText(faellig, jetzt = new Date()) {
  const tage = tageZwischen(faellig, zuerichTag(jetzt));
  if (tage === -1) return `etwa morgen (${tagText(faellig)})`;
  if (tage === 0) return `etwa heute (${tagText(faellig)})`;
  if (tage < 0) return `etwa am ${tagText(faellig)}`;
  return `seit etwa ${tagText(faellig)}`;
}

function einfuellText({ lager, ort, faellig, bestandSaecke, kgProWoche, sackKg, portalUrl, jetzt = new Date() }) {
  const z = [];
  z.push(`Im Salzlager ${lager} ist ${faelligText(faellig, jetzt)} der nächste Sack fällig:`);
  z.push('In der Enthärtungsanlage ist dann wieder Platz für einen Sack.');
  if (ort) z.push(`Ort: ${ort}`);
  z.push('');
  const kg = Math.round(kgProWoche * 10) / 10;
  const sackTage = sackKg > 0 && kgProWoche > 0 ? Math.round(sackKg / kgProWoche * 7) : null;
  z.push(`Geschätzt aus dem bisherigen Verbrauch (etwa ${kg} kg pro Woche${sackTage ? `, ein Sack reicht rund ${sackTage} Tage` : ''}).`);
  z.push(`Im Lager: ${bestandSaecke} ${bestandSaecke === 1 ? 'Sack' : 'Säcke'}.`);
  z.push('');
  z.push('Nach dem Einfüllen in der App „Rosenweg Salz“ auf „Sack eingefüllt“ tippen und den Sack scannen –');
  z.push('dann rechnet Rosenweg den nächsten Termin neu.');
  if (portalUrl) z.push(`Erinnerung abschalten: ${portalUrl}`);
  return z.join('\n');
}

module.exports = {
  FENSTER_TAGE, MIN_EINFUELLUNGEN, MIN_SPANNE_TAGE, NACHHOLEN_TAGE, VORLAUF_TAGE, ZUSAMMEN_STUNDEN,
  LUECKE_FAKTOR, LUECKE_TAGE_JE_SACK,
  einfuellungenZusammenfassen, inAbschnitte, verbrauchProWoche,
  lagerStand, meldeEntscheid, meldungsText, wochenText, reichtText,
  zuerichTag, naechsterSack, inhaltReichtBis, prognoseHinweis, einfuellErinnern, einfuellText, faelligText, tagText,
};
