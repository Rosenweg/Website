// Vollmachten fuer die App „Rosenweg Vollmachten“ (Flutter): Rechte je Zeile,
// Bevollmaechtigter-Erkennung, Bezug zur Versammlung, Weisung, Neuigkeiten.
// Rein funktional – Datenbank und Routen bleiben in server.js (wie
// lib/vollmacht-rechte.js und lib/zev.js).
//
// Entscheide Stefan 28.11.2026 (klaerung-vollmachten.md V1–V13):
//   V1  Signieren: einfache elektronische Signatur nur mit frischer Anmeldung
//       (lib/stufen.js signierenErlaubt – nie Karte, PAT, MCP); die Art der
//       Bestaetigung steht auf dem PDF (bestaetigungText)
//   V3  Vollmacht mit Bezug zu einer Versammlung (stweg_events, Kategorie
//       „versammlung“) und Weisung (Freitext)
//   V4  Versammlung: nur wer wen vertritt, mit Wertquote (kein Stimmenzaehlen)
//   V5  Erinnerung 14 und 3 Tage vor der Versammlung (die App meldet es aus
//       den Neuigkeiten, Basis HintergrundAbfrage)
//   V6  Benachrichtigungen: unterschreiben, aktiv, widerrufen, neu aktiv
//       (Verwaltung), Ablauf in 30 Tagen – ebenfalls ueber die Neuigkeiten
//   V8  Bevollmaechtigter auch ueber Person und Verwaltungsfirma erkennen
const vr = require('./vollmacht-rechte');
const { verwaltungStwegs, verwaltetAlleStwegs } = require('./groups');

const TAG_MS = 24 * 3600 * 1000;
const ABLAUF_TAGE = 30;
const ERINNERUNG_TAGE = 14;
const WEISUNG_MAX = 4000;

const klein = (s) => String(s || '').trim().toLowerCase();
const liste = (v) => (Array.isArray(v && v.vollmachtgeber_liste) ? v.vollmachtgeber_liste : []);

// ─── V8: Bevollmaechtigter ──────────────────────────────────────────────
// ctx: { groups, email, personIds: [id…] }; v.verwaltung_stweg = STWEG der
// Verwaltungsfirma (verwaltungen.stweg, null = fuer alle).
// Verwaltungsfirma -> Gruppe stwegN-verwaltung (bzw. Uebergang „Verwaltung“):
// gilt die STWEG der Firma, sonst die der Vollmacht; ohne beide nur, wer alle
// STWEGs verwaltet.
function istBevollmaechtigter(ctx, v) {
  if (!v) return false;
  const e = klein(ctx && ctx.email);
  if (e && klein(v.bevollmaechtigter_email) === e) return true;
  const ids = (ctx && ctx.personIds) || [];
  if (v.bevollmaechtigter_person_id != null && ids.some((i) => Number(i) === Number(v.bevollmaechtigter_person_id))) return true;
  if (v.bevollmaechtigter_verwaltung_id != null) {
    const g = (ctx && ctx.groups) || [];
    const st = v.verwaltung_stweg != null ? v.verwaltung_stweg : v.stweg;
    if (st === null || st === undefined || st === '') return verwaltetAlleStwegs(g);
    return verwaltungStwegs(g).has(Number(st));
  }
  return false;
}

// ─── Rechte je Zeile (L2) ───────────────────────────────────────────────
// ctx: { groups, email, perm, kontakte, personIds, pat, kanal }
// Gleiche Regeln wie die Routen (PUT, sign-digital, upload-signed, DELETE,
// verify-ai); die App baut nichts nach.
function zeilenRechte(ctx, v) {
  const g = ctx.groups || [];
  const email = klein(ctx.email);
  const zeilen = liste(v);
  const tp = vr.widerrufAdmin(g);
  const istGeber = vr.istVollmachtgeber(email, v.vollmachtgeber_email, zeilen.map((x) => x && x.email));
  const ersteller = !!email && klein(v.created_by_user_email) === email;
  const entwurf = v.status === 'entwurf';
  const signiert = Number(v.vg_signed) > 0;
  const geberOk = vr.vmGeberErlaubt({ wohnungId: v.wohnung_id, stweg: v.stweg }, ctx.kontakte || [], g).ok;
  const objektOk = tp || vr.vmDarfVerwalten(g, ctx.perm, v.stweg) || geberOk;
  const meine = zeilen.filter((x) => x && email && klein(x.email) === email);
  const offeneMeine = meine.filter((x) => !x.signed_at);
  const ohneToken = !ctx.pat && klein(ctx.kanal) !== 'mcp';
  const hatPdf = !!v.papier_pdf_path || zeilen.some((x) => x && x.papier_pdf_path);
  return {
    ich_geber: istGeber,
    ich_bevollmaechtigter: istBevollmaechtigter(ctx, v),
    ich_unterschrieben: meine.length > 0 && offeneMeine.length === 0,
    darf_bearbeiten: entwurf && !signiert && (tp || istGeber || ersteller) && objektOk,
    darf_signieren: entwurf && offeneMeine.length > 0 && geberOk && ohneToken,
    darf_hochladen: tp
      || (entwurf && istGeber && geberOk && meine.some((x) => !x.signed_at || x.signatur_typ === 'papier')),
    darf_loeschen: tp || ((istGeber || ersteller) && entwurf),
    darf_ki: ohneToken && hatPdf && vr.vmDarfKiPruefen(g, ctx.perm, v.stweg),
  };
}

// ─── V3: Versammlung und Weisung pruefen ────────────────────────────────
// termin: Zeile aus stweg_events ({ id, stweg, category }) oder null.
// -> { ok: true } | { fehler }
function terminPruefen(termin, stweg) {
  if (!termin) return { fehler: 'Diese Versammlung gibt es nicht' };
  if (termin.category !== 'versammlung') return { fehler: 'Nur Termine der Kategorie „Versammlung“ sind möglich' };
  if (stweg === null || stweg === undefined || stweg === '' || Number(termin.stweg) !== Number(stweg)) {
    return { fehler: 'Die Versammlung gehört zu einer anderen STWEG als die Vollmacht' };
  }
  return { ok: true };
}
// Weisung aus dem Formular: Text (getrimmt) oder null; Fehlertext, wenn zu lang.
function weisungPruefen(w) {
  if (w === undefined || w === null) return { wert: null };
  const t = String(w).trim();
  if (t.length > WEISUNG_MAX) return { fehler: `Die Weisung ist zu lang (höchstens ${WEISUNG_MAX} Zeichen)` };
  return { wert: t || null };
}

// ─── V1: Art der Bestaetigung (L6) ───────────────────────────────────────
// Kommt aus req.auth (nie aus dem Body): Art und Anmeldezeit der Anfrage.
function bestaetigungText(auth, jetztMs = Date.now()) {
  const art = { app: 'in der App', website: 'im Portal', authentik: 'im Portal' }[auth && auth.art] || '';
  const t = auth && Number(auth.auth_time) > 0 ? new Date(Number(auth.auth_time) * 1000) : new Date(jetztMs);
  const datum = t.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });
  const zeit = t.toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
  return `Rosenweg-Konto, frisch angemeldet${art ? ' ' + art : ''} am ${datum} um ${zeit} Uhr`;
}

// ─── V4: wer vertritt wen, mit Wertquote ────────────────────────────────
// Summe der Wertquoten (Anteil 0..1) aus Wohnungen [{ wertquote_zaehler, wertquote_nenner }].
function wertquoteAnteil(wohnungen) {
  let s = 0;
  for (const w of wohnungen || []) {
    const z = Number(w && w.wertquote_zaehler);
    const n = Number(w && w.wertquote_nenner);
    if (Number.isFinite(z) && Number.isFinite(n) && n > 0) s += z / n;
  }
  return Math.round(s * 1e6) / 1e6;
}

// Gilt die aktive Vollmacht an diesem Tag fuer diese Versammlung?
// Mit Bezug: nur dieser Termin. Ohne Bezug: allgemeine Vollmachten (generell,
// spezifisch), nicht die reine Auskunfts-Vollmacht; Gueltigkeit am Termintag.
function gilt(v, termin) {
  if (!v || v.status !== 'aktiv') return false;
  if (Number(v.stweg) !== Number(termin.stweg)) return false;
  if (v.termin_id !== null && v.termin_id !== undefined) return Number(v.termin_id) === Number(termin.id);
  if (v.art === 'auskunft') return false;
  const tag = new Date(termin.start).toISOString().slice(0, 10);
  const ab = v.gueltig_ab ? new Date(v.gueltig_ab).toISOString().slice(0, 10) : null;
  const bis = v.gueltig_bis ? new Date(v.gueltig_bis).toISOString().slice(0, 10) : null;
  return (!ab || ab <= tag) && (!bis || bis >= tag);
}

// ─── V5/V6: Neuigkeiten fuer die App ───────────────────────────────────
// zeilen: sichtbare Vollmachten mit Rechten (zeilenRechte) und
//         vollmachtgeber_liste; ctx wie oben (groups, email, perm);
// termine: bevorstehende Versammlungen der eigenen STWEGs
//         [{ id, stweg, title, start_date }]; jetzt: Date.
// Die App vergleicht die IDs mit den bekannten und meldet lokal (Basis
// HintergrundAbfrage, wie ZEV): keine Mail, kein Push-Dienst.
function neuigkeiten({ zeilen, ctx, termine, jetzt }) {
  const jetztMs = (jetzt || new Date()).getTime();
  const email = klein(ctx.email);
  const g = ctx.groups || [];
  const verwSt = vr.vmVerwaltungStwegs(g, ctx.perm, 'read');
  const kurz = (v) => ({ id: v.id, doc_hash: v.doc_hash || null, stweg: v.stweg ?? null });
  const raus = { unterschreiben: [], aktiv: [], widerrufen: [], neu_aktiv: [], laeuft_ab: [], versammlungen: [] };
  for (const v of zeilen || []) {
    const ichGeber = v.ich_geber === true;
    const ichBv = v.ich_bevollmaechtigter === true;
    const meineOffen = liste(v).some((x) => x && klein(x.email) === email && !x.signed_at);
    if (v.status === 'entwurf' && ichGeber && meineOffen && klein(v.created_by_user_email) !== email) {
      raus.unterschreiben.push({ ...kurz(v), bevollmaechtigter: v.bevollmaechtigter_name || null });
    }
    if (v.status === 'aktiv' && ichBv) {
      raus.aktiv.push({ ...kurz(v), von: v.vollmachtgeber_name || null });
    }
    if (v.status === 'widerrufen' && (ichGeber || ichBv) && klein(v.widerrufen_von_user_email) !== email) {
      raus.widerrufen.push({ ...kurz(v), von: v.vollmachtgeber_name || null, bevollmaechtigter: v.bevollmaechtigter_name || null });
    }
    if (v.status === 'aktiv' && !ichGeber && !ichBv && v.stweg != null && verwSt.has(Number(v.stweg))) {
      const seit = v.updated_at ? new Date(v.updated_at).getTime() : 0;
      if (jetztMs - seit <= 60 * TAG_MS) raus.neu_aktiv.push({ ...kurz(v), von: v.vollmachtgeber_name || null, bevollmaechtigter: v.bevollmaechtigter_name || null });
    }
    if (v.status === 'aktiv' && ichGeber && v.gueltig_bis) {
      const bis = new Date(v.gueltig_bis).getTime();
      const tage = Math.ceil((bis - jetztMs) / TAG_MS);
      if (tage >= 0 && tage <= ABLAUF_TAGE) raus.laeuft_ab.push({ ...kurz(v), gueltig_bis: new Date(v.gueltig_bis).toISOString().slice(0, 10), tage });
    }
  }
  for (const t of termine || []) {
    const tage = Math.ceil((new Date(t.start_date).getTime() - jetztMs) / TAG_MS);
    if (tage < 0 || tage > ERINNERUNG_TAGE) continue;
    const terminObj = { id: t.id, stweg: t.stweg, start: t.start_date };
    const meine = (zeilen || []).filter((v) => v.ich_geber === true && Number(v.stweg) === Number(t.stweg));
    const vertreten = meine.some((v) => gilt(v, terminObj));
    const offen = meine
      .filter((v) => v.status === 'entwurf' && liste(v).some((x) => x && klein(x.email) === email && !x.signed_at)
        && (v.termin_id === null || v.termin_id === undefined || Number(v.termin_id) === Number(t.id)))
      .map((v) => v.id);
    raus.versammlungen.push({ termin_id: t.id, titel: t.title, start: new Date(t.start_date).toISOString(), stweg: t.stweg, tage, vertreten, offen });
  }
  return raus;
}

module.exports = {
  ABLAUF_TAGE, ERINNERUNG_TAGE, WEISUNG_MAX,
  istBevollmaechtigter, zeilenRechte,
  terminPruefen, weisungPruefen, bestaetigungText, wertquoteAnteil, gilt, neuigkeiten,
};
