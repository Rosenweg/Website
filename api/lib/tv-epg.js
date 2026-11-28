// SPDX-License-Identifier: GPL-3.0-or-later
// TV-Programm als JSON fuer die App Rosenweg TV (Jetzt/Danach, Programm je Sender).
// Reine Funktionen ueber dem Init7-EPG, den server.js ohnehin fuer XMLTV laedt
// (derselbe Cache, kein zweiter Abruf bei Init7).
//
// Eine Sendung im Index: { s: Start (ms), e: Ende (ms), t: Titel, u: Untertitel, d: Beschreibung }.
// Der Schluessel je Sender ist canonical_name = tvg-name der Playlist = Feld `tvg`
// in /api/tv/channels.
'use strict';

const TAG = 24 * 3600 * 1000;
const MAX_TAGE = 8;            // so weit reicht der Cache (~7 Tage voraus)
const MAX_SENDUNGEN = 600;     // Obergrenze je Antwort

/** Init7-Zeilen (timeslot.lower/upper, channel.canonical_name, title ...) -> Index je Sender. */
function indexBauen(zeilen, ab = 0) {
  const index = new Map();
  for (const r of zeilen || []) {
    const id = r && r.channel && r.channel.canonical_name;
    const ts = r && r.timeslot;
    if (!id || !ts) continue;
    const s = Date.parse(ts.lower), e = Date.parse(ts.upper);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e < ab) continue;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push({ s, e, t: r.title || '', u: r.sub_title || '', d: r.desc || '' });
  }
  for (const l of index.values()) l.sort((a, b) => a.s - b.s);
  return index;
}

const aussen = (x, mitBeschreibung) => ({
  start: new Date(x.s).toISOString(),
  ende: new Date(x.e).toISOString(),
  titel: x.t,
  ...(x.u ? { untertitel: x.u } : {}),
  ...(mitBeschreibung && x.d ? { beschreibung: x.d } : {}),
});

/** Jetzt und Danach fuer alle Sender: { "<tvg>": { jetzt, danach } }. Fehlt eines, fehlt der Schluessel. */
function jetztUndDanach(index, jetzt = Date.now()) {
  const aus = {};
  for (const [id, l] of index) {
    const i = l.findIndex(x => x.e > jetzt);
    if (i < 0) continue;
    const eintrag = {};
    if (l[i].s <= jetzt) { eintrag.jetzt = aussen(l[i]); if (l[i + 1]) eintrag.danach = aussen(l[i + 1]); }
    else eintrag.danach = aussen(l[i]);   // Luecke: noch nichts Laufendes
    aus[id] = eintrag;
  }
  return aus;
}

/** Zeitangabe aus der Anfrage: ISO-Text oder Millisekunden; sonst Rueckfall. */
function zeitAngabe(wert, rueckfall) {
  if (wert === undefined || wert === null || wert === '') return rueckfall;
  const s = String(wert);
  const ms = /^\d{10,13}$/.test(s) ? (s.length <= 10 ? Number(s) * 1000 : Number(s)) : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Programm eines Senders im Zeitraum [von, bis). Ohne Angaben: ab jetzt (laufende
 * Sendung eingeschlossen) 24 Stunden. Der Zeitraum ist auf MAX_TAGE begrenzt.
 * Liefert { fehler } bei ungueltiger Eingabe.
 */
function programm(index, kanal, vonRoh, bisRoh, jetzt = Date.now()) {
  if (!kanal || typeof kanal !== 'string') return { fehler: 'kanal fehlt' };
  const von = zeitAngabe(vonRoh, jetzt);
  if (von === null) return { fehler: 'von ist keine Zeitangabe' };
  const bis = zeitAngabe(bisRoh, von + TAG);
  if (bis === null) return { fehler: 'bis ist keine Zeitangabe' };
  if (bis <= von) return { fehler: 'bis muss nach von liegen' };
  const bisBegrenzt = Math.min(bis, von + MAX_TAGE * TAG);
  const l = index.get(kanal);
  if (!l) return { unbekannt: true };
  const sendungen = l.filter(x => x.e > von && x.s < bisBegrenzt).slice(0, MAX_SENDUNGEN).map(x => aussen(x, true));
  return { kanal, von: new Date(von).toISOString(), bis: new Date(bisBegrenzt).toISOString(), sendungen };
}

module.exports = { indexBauen, jetztUndDanach, programm, zeitAngabe, MAX_TAGE, MAX_SENDUNGEN };
