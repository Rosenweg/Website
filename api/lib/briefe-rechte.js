// Regeln der Brief-Ablage (Klaerung Briefe, Entscheide Stefan 28.11.2026).
// Rein funktional fuer Server, Tests und spaeter die App.
//
//  - STWEG beim Erfassen: jeder Brief gehoert einer STWEG. Der Ausschuss sieht
//    und erfasst nur fuer seine STWEG(s), Technik/Praesident alles. Altbestand
//    ohne STWEG sehen nur Technik/Praesident (sie koennen ihn zuordnen).
//  - Loeschen: Begruendung, Vier-Augen (andere Konto-ID, Ausschuss derselben
//    STWEG oder Technik/Praesident), Protokoll.
//  - Upload: Inhalt pruefen (Magic Bytes), nicht die Endung; hoechstens 15 MB.
//  - Texterkennung extern (OpenRouter): nur nach ausdruecklichem Hinweis, mit
//    Tageslimit je Konto (Zaehler in der Datenbank).
const { isTechnik, isPraesident, getAusschussStwegs, ALLE_STWEGS } = require('./groups');

const MAX_BYTES = 15 * 1024 * 1024;
const OCR_TAGESLIMIT = Math.max(1, parseInt(process.env.BRIEFE_OCR_TAGESLIMIT, 10) || 30);
const HINWEIS_EXTERN = 'Das Foto des Couverts (mit Name und Adresse des Empfängers) wird für die Texterkennung an einen externen Dienst geschickt: OpenRouter, von dort an Anthropic (Claude). Die Daten verlassen damit das Rosenweg-Netz.';

const istAdmin = (groups) => isTechnik(groups || []) || isPraesident(groups || []);

/** Sicht: null = alles (auch ohne STWEG), sonst Set der STWEG-Nummern. */
function sichtStwegs(groups) {
  if (istAdmin(groups)) return null;
  return getAusschussStwegs(groups || []);
}

function darfZugang(groups) {
  const s = sichtStwegs(groups);
  return s === null || s.size > 0;
}

function darfSehen(groups, stweg) {
  const s = sichtStwegs(groups);
  if (s === null) return true;
  const n = parseInt(stweg, 10);
  return Number.isFinite(n) && s.has(n);
}

/** STWEG fuer einen neuen Brief: gueltige Nummer, die das Konto erfassen darf, sonst null. */
function erfassStweg(groups, wunsch) {
  const s = sichtStwegs(groups);
  let n = parseInt(wunsch, 10);
  // Ohne Angabe: die einzige eigene STWEG
  if (!Number.isFinite(n) && s && s.size === 1) n = [...s][0];
  if (!Number.isFinite(n) || !ALLE_STWEGS.includes(n)) return null;
  return darfSehen(groups, n) ? n : null;
}

/**
 * Loeschantrag entscheiden: andere Person (Konto-ID) und Ausschuss derselben
 * STWEG oder Technik/Praesident. Liefert { ok, grund }.
 */
function darfEntscheiden(user, antrag, briefStweg) {
  const groups = (user && user.groups) || [];
  const id = user && user.id != null ? Number(user.id) : null;
  if (id == null || !Number.isFinite(id)) return { ok: false, grund: 'keine-konto-id' };
  if (Number(antrag.beantragt_von_id) === id) return { ok: false, grund: 'eigener-antrag' };
  if (istAdmin(groups)) return { ok: true };
  return darfSehen(groups, briefStweg) ? { ok: true } : { ok: false, grund: 'andere-stweg' };
}

/** Bildtyp aus dem Inhalt (Magic Bytes): 'jpeg' | 'png' | null. */
function bildTyp(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => buf[i] === b)) return 'png';
  return null;
}

/** Base64 (ohne/mit data:-Vorspann) in Bytes; null wenn kein sauberes Base64. */
function base64Bytes(text) {
  const s = String(text || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/** Dateiname einer Ablage (<name>-<5 Ziffern>.jpeg|jpg|png, ohne / \\ und Steuerzeichen), sonst null. */
function sichererDateiname(name) {
  const n = String(name || '');
  return /^[A-Za-z0-9][A-Za-z0-9._ &-]{0,200}-\d{5}\.(jpe?g|png)$/i.test(n) ? n : null;
}

module.exports = {
  MAX_BYTES, OCR_TAGESLIMIT, HINWEIS_EXTERN, sichtStwegs, darfZugang, darfSehen, erfassStweg,
  darfEntscheiden, bildTyp, base64Bytes, sichererDateiname,
};
