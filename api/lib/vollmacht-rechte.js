// Wer eine Vollmacht widerrufen darf – eine Regel fuer den Server
// (POST /api/vollmachten/:id/revoke) und die Liste (Feld darf_widerrufen,
// danach zeigt vollmachten.html den Knopf „Widerrufen“). Befund B11: Ausschuss
// und Verwaltung sehen „Alle“, duerfen aber nicht widerrufen.
const { STWEG_GROUPS, isTechnik, isPraesident, getAusschussStwegs, verwaltungStwegs, verwaltetAlleStwegs } = require('./groups');

// Technik und Praesident duerfen jede Vollmacht widerrufen.
function widerrufAdmin(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g);
}

// Ist email eine der Vollmachtgeber-Adressen (Primaer-Adresse oder Liste
// vollmachten_vollmachtgeber)? Gross/Klein egal.
function istVollmachtgeber(email, primaerEmail, listeEmails) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (String(primaerEmail || '').trim().toLowerCase() === e) return true;
  return (listeEmails || []).some(x => String(x || '').trim().toLowerCase() === e);
}

// Recht ohne Status: Admin-Rolle oder Vollmachtgeber.
function darfWiderrufenRecht(groups, istGeber) {
  return widerrufAdmin(groups) || !!istGeber;
}

// Fuer eine Zeile der Liste (v.vollmachtgeber_liste = [{email, …}]): nur aktive
// Vollmachten bekommen den Knopf.
function darfWiderrufen(user, v) {
  if (!v || v.status !== 'aktiv') return false;
  const liste = Array.isArray(v.vollmachtgeber_liste) ? v.vollmachtgeber_liste.map(x => x && x.email) : [];
  return darfWiderrufenRecht(user && user.groups, istVollmachtgeber(user && user.email, v.vollmachtgeber_email, liste));
}

// ─── Hausverwaltung und Seitenrecht „vollmachten“ (Befund B19) ──────────
// Die Verwaltung (stwegN-verwaltung, Übergang: „Verwaltung“) bekommt bei
// Vollmachten nur, was das Seitenrecht „vollmachten“ ihrer Gruppe hergibt,
// und nur fuer ihre STWEG(s):
//   lesen     alle Vollmachten ihrer STWEG(s) sehen, PDF und KI-Pruefung
//   schreiben zusaetzlich fuer Dritte erfassen/bearbeiten und „Papier aktivieren“
// Eigene Vollmachten (als Vollmachtgeber) gehen fuer jedes Konto wie bisher.
// Technik/Praesident (alles) und Ausschuss (Vollmachten der eigenen STWEG
// sehen) bleiben unveraendert und haengen nicht am Seitenrecht.
const STUFE = { read: 1, write: 2 };
function stufe(perm) { return STUFE[perm] || 0; }

// STWEGs, fuer die die Verwaltung mit Seitenrecht >= mindestens handeln darf.
function vmVerwaltungStwegs(groups, perm, mindestens = 'read') {
  if (stufe(perm) < stufe(mindestens)) return new Set();
  return verwaltungStwegs(groups || []);
}

// Wer sieht welche Vollmachten (ausser den eigenen)?
// { alle, stwegs: [..], ohneStweg } — ohneStweg = Vollmachten ohne STWEG.
// R2 (Entscheid Stefan 28.11.2026): auch der Ausschuss sieht die Vollmachten
// seiner STWEG(s) nur mit Seitenrecht „vollmachten“ >= lesen (Vorgabe per
// Rechte-Migration: alle Ausschuesse lesen). So laesst es sich in der
// Rechteverwaltung abschalten.
function vmSicht(groups, perm) {
  const g = groups || [];
  if (widerrufAdmin(g)) return { alle: true, stwegs: [], ohneStweg: true };
  const s = stufe(perm) >= 1 ? getAusschussStwegs(g) : new Set();
  for (const n of vmVerwaltungStwegs(g, perm, 'read')) s.add(n);
  const alleVerwaltet = stufe(perm) >= 1 && verwaltetAlleStwegs(g);
  return { alle: false, stwegs: [...s].sort((a, b) => a - b), ohneStweg: alleVerwaltet };
}

// Darf die Sicht die Vollmacht einer STWEG (null = ohne) sehen?
function vmSichtErlaubt(sicht, stweg) {
  if (!sicht) return false;
  if (sicht.alle) return true;
  if (stweg === null || stweg === undefined || stweg === '') return !!sicht.ohneStweg;
  return sicht.stwegs.includes(Number(stweg));
}

// Fuer Dritte erfassen/bearbeiten und „Papier aktivieren“: Technik/Praesident
// immer; die Verwaltung mit Seitenrecht „schreiben“ fuer ihre STWEG(s), ohne
// STWEG nur, wenn sie alle STWEGs verwaltet.
function vmDarfVerwalten(groups, perm, stweg) {
  const g = groups || [];
  if (widerrufAdmin(g)) return true;
  if (stufe(perm) < 2) return false;
  if (stweg === null || stweg === undefined || stweg === '') return verwaltetAlleStwegs(g);
  return vmVerwaltungStwegs(g, perm, 'write').has(Number(stweg));
}

// Darf das Konto ueberhaupt fuer Dritte erfassen (Formular, ohne STWEG-Bezug)?
function vmDarfFuerAndereIrgendwo(groups, perm) {
  return widerrufAdmin(groups || []) || vmVerwaltungStwegs(groups, perm, 'write').size > 0;
}

// ─── Wer darf eine Vollmacht erteilen? (D1, Entscheid Stefan 28.11.2026) ──
// Nur Eigentuemer bzw. Wohnungs-Verwalter einer Wohnung erteilen eine
// Vollmacht fuer diese Wohnung und schalten sie aktiv (digital signieren,
// eigene PDF hochladen). Ohne Wohnung und ohne STWEG wird abgelehnt.
// Fuer eine STWEG ohne Wohnung: Eigentuemer/Wohnungs-Verwalter einer Wohnung
// dieser STWEG oder Mitglied ihrer Eigentuemergruppe (dort liegen auch die
// Wohnungs-Verwalter, siehe lib/dok-stweg-sicht.js der Mieter-Sperre).
// kontakte: aktive Eintraege des Kontos in wohnungen_kontakte
//           [{ wohnung_id, stweg, rolle }].
// Liefert { ok: true, stweg } oder { ok: false, fehler }.
const GEBER_ROLLEN = ['eigentuemer', 'verwalter'];
function leer(x) { return x === null || x === undefined || x === ''; }
function inEigentuemerGruppe(groups, nr) {
  const m = STWEG_GROUPS[Number(nr)];
  if (!m || !m.eigentuemer) return false;
  return (groups || []).some(g => String(g).toLowerCase() === m.eigentuemer.toLowerCase());
}
function vmGeberErlaubt(objekt, kontakte, groups) {
  const wohnungId = objekt && objekt.wohnungId;
  const stweg = objekt && objekt.stweg;
  const k = (kontakte || []).filter(x => x && GEBER_ROLLEN.includes(String(x.rolle || '').toLowerCase()));
  if (!leer(wohnungId)) {
    const w = k.find(x => String(x.wohnung_id) === String(wohnungId));
    if (!w) return { ok: false, fehler: 'Vollmachten für eine Wohnung erteilen nur ihre Eigentümer oder Wohnungs-Verwalter' };
    return { ok: true, stweg: w.stweg === undefined ? null : w.stweg };
  }
  if (!leer(stweg)) {
    const n = Number(stweg);
    if (k.some(x => Number(x.stweg) === n) || inEigentuemerGruppe(groups, n)) return { ok: true, stweg: n };
    return { ok: false, fehler: 'Vollmachten für eine STWEG erteilen nur ihre Eigentümer oder Wohnungs-Verwalter' };
  }
  return { ok: false, fehler: 'Bitte eine Wohnung oder STWEG angeben — Vollmachten ohne Objekt sind nicht möglich' };
}
// Darf das Konto ueberhaupt eine Vollmacht als Geber erteilen (Knopf „Neue Vollmacht“)?
function vmDarfErteilenIrgendwo(kontakte, groups) {
  if ((kontakte || []).some(x => x && GEBER_ROLLEN.includes(String(x.rolle || '').toLowerCase()))) return true;
  return Object.keys(STWEG_GROUPS).some(n => inEigentuemerGruppe(groups, n));
}

// ─── Signatur-Nachweise (D2) ─────────────────────────────────────────
// IP-Adresse, User-Agent und Authentik-Kennung der Vollmachtgeber sehen nur
// Technik und Praesident — in der Liste, in Antworten und auf dem PDF.
// Alle anderen bekommen diese Felder nicht (signed_at und signatur_typ bleiben).
const NACHWEIS_FELDER_GEBER = ['signed_ip', 'signed_user_agent', 'signed_authentik_sub', 'signed_bestaetigung_ref'];
const NACHWEIS_FELDER_VM = ['digital_signed_ip', 'digital_signed_user_agent', 'digital_signed_authentik_sub'];
function vmNachweisSehen(groups) { return widerrufAdmin(groups || []); }
function vmOhneNachweis(v, groups) {
  if (!v || typeof v !== 'object' || vmNachweisSehen(groups)) return v;
  const out = { ...v };
  for (const f of NACHWEIS_FELDER_VM) delete out[f];
  if (Array.isArray(out.vollmachtgeber_liste)) {
    out.vollmachtgeber_liste = out.vollmachtgeber_liste.map(g => {
      if (!g || typeof g !== 'object') return g;
      const x = { ...g };
      for (const f of NACHWEIS_FELDER_GEBER) delete x[f];
      return x;
    });
  }
  return out;
}

// ─── KI-Pruefung (D3) ────────────────────────────────────────────────
// Schickt die PDF an einen externen Dienst (OpenRouter -> Anthropic). Nur auf
// Knopfdruck durch Technik/Praesident oder die Verwaltung der STWEG (Seitenrecht
// „vollmachten“ >= lesen), nie automatisch, nie fuer Geber oder Ausschuss.
function vmDarfKiPruefen(groups, perm, stweg) {
  const g = groups || [];
  if (widerrufAdmin(g)) return true;
  if (leer(stweg)) return stufe(perm) >= 1 && verwaltetAlleStwegs(g);
  return vmVerwaltungStwegs(g, perm, 'read').has(Number(stweg));
}

// ─── Personensuche (D4) ──────────────────────────────────────────────
// Die Suche nach Bevollmaechtigten liefert Name und E-Mail nur fuer STWEGs,
// deren Eigentuemer-Unterlagen das Konto sehen darf: Eigentuemer, Ausschuss
// und Verwaltung der STWEG (gleiche Regel wie stwegDokZugang() === 'voll' in
// lib/dok-stweg-sicht.js, Mieter-Sperre). Reine Bewohner (Mieter) bekommen
// nichts. Die Verwaltung zaehlt hier wie bisher nur mit Seitenrecht
// „vollmachten“ (vmVerwaltungStwegs).
function vmSucheStwegs(groups, perm) {
  const g = groups || [];
  const lower = new Set(g.map(x => String(x).toLowerCase()));
  const s = new Set();
  for (const [nr, m] of Object.entries(STWEG_GROUPS)) {
    const hat = rolle => !!m[rolle] && lower.has(m[rolle].toLowerCase());
    if (hat('eigentuemer') || hat('ausschuss')) s.add(Number(nr));
  }
  for (const n of vmVerwaltungStwegs(g, perm, 'read')) s.add(n);
  return s;
}

// ─── Vorlagen pro STWEG (R2) ─────────────────────────────────────────
// Vorlage mit stweg NULL = global (Vorgabe fuer alle, auch die bestehenden).
// Global anlegen/aendern/loeschen nur Technik/Praesident; der Ausschuss nur
// Vorlagen seiner STWEG(s). Sehen: global + die der eigenen STWEG(s).
function vmVorlageBearbeiten(groups, stweg) {
  const g = groups || [];
  if (widerrufAdmin(g)) return true;
  if (leer(stweg)) return false;
  return getAusschussStwegs(g).has(Number(stweg));
}
function vmVorlagenStwegs(groups) {
  const g = groups || [];
  if (widerrufAdmin(g)) return null; // alle
  const s = new Set();
  for (const [nr, m] of Object.entries(STWEG_GROUPS)) {
    if (Object.values(m).some(name => g.some(x => String(x).toLowerCase() === name.toLowerCase()))) s.add(Number(nr));
  }
  for (const n of verwaltungStwegs(g)) s.add(n);
  return s;
}
function vmVorlageSichtbar(groups, stweg) {
  if (leer(stweg)) return true;
  const s = vmVorlagenStwegs(groups);
  return s === null || s.has(Number(stweg));
}
// STWEGs, fuer die das Konto Vorlagen anlegen darf (Formular): null = alle inkl. global
function vmVorlagenAnlegenStwegs(groups) {
  const g = groups || [];
  if (widerrufAdmin(g)) return null;
  return [...getAusschussStwegs(g)].sort((a, b) => a - b);
}

// ─── Typ des Bevollmaechtigten (Befund F2-6) ─────────────────────────
// Die Datenbank kennt eigentuemer | verwaltung | mieter | extern
// (vm_typ_chk). Das Formular bietet zusaetzlich „Person aus Objektverwaltung“
// (UI-Wert person); den genauen Typ setzt erst die Auswahl eines Kontakts.
// Wird der Name von Hand getippt, kam 'person' an und der Server lehnte ab.
// Ohne Auswahl ist die Person nicht aus der Objektverwaltung belegt -> extern.
const BV_TYPEN = ['eigentuemer', 'verwaltung', 'mieter', 'extern'];
function bvTyp(typ) {
  const t = String(typ || '').trim().toLowerCase();
  if (t === 'person') return 'extern';
  return BV_TYPEN.includes(t) ? t : null;
}

module.exports = {
  BV_TYPEN, bvTyp,
  widerrufAdmin, istVollmachtgeber, darfWiderrufenRecht, darfWiderrufen,
  vmVerwaltungStwegs, vmSicht, vmSichtErlaubt, vmDarfVerwalten, vmDarfFuerAndereIrgendwo,
  GEBER_ROLLEN, vmGeberErlaubt, vmDarfErteilenIrgendwo,
  vmNachweisSehen, vmOhneNachweis, vmDarfKiPruefen, vmSucheStwegs,
  vmVorlageBearbeiten, vmVorlagenStwegs, vmVorlageSichtbar, vmVorlagenAnlegenStwegs,
};
