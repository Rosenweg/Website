// Kartenverwaltung (Rosenweg-Karten = NFC-Karten in UniFi Access)
//
// Entscheid Stefan 27.11.2026: "Karten gehören nicht in die Telefonanlage."
// Nachschlagen, Zuordnen, Entziehen und Löschen lagen als /api/telefon/karten/*
// in der PBX-API (CT 220), die mit dem PBX-Geheimnis an /api/pbx/karte/* der
// Haupt-API weiterreichte. Jetzt sind es eigene Routen der Haupt-API
// (routes/karten.js, /api/karten/*) mit der normalen Anmeldung:
//   Website-Login, rosenweg-apps-Token, Karten-/QR-/Handy-Sitzung (rw_app_)
//   und das Anlage-Token der geteilten Telefone (Rosenweg Gerät -> PBX
//   /api/telefon/portal). Karte = Schlüssel: volle Rechte, Admin-Aktionen mit
//   der Karte stehen im Kartenprotokoll ("admin-mit-karte") und werden
//   quittiert (lib/kartenadmin.js, über requireTechnikOrPraesident).
//
// Die Logik hier ist für beide Wege dieselbe: /api/karten/* (neu) und
// /api/pbx/karte/* (PBX-Geheimnis; bleibt für die Anmeldung am geteilten
// Telefon, GET /api/pbx/karte/:nfcId). Ohne Datenbank und ohne Netz prüfbar:
// UniFi Access und das Protokoll kommen als deps herein.
'use strict';

const normNfcId = (s) => String(s || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
const nfcIdGueltig = (s) => /^[0-9A-F]{8,20}$/.test(s) && s.length % 2 === 0;
const emailGueltig = (s) => /^[^\s@]+@[^\s@]+$/.test(String(s || ''));

/** Fehler mit HTTP-Status (wie kartenFehler in server.js). */
function fehlerAntwort(e) {
  if (e && e.http) return { status: e.http, body: { error: e.message } };
  return { status: 500, body: { error: 'Kartenabfrage fehlgeschlagen' } };
}

/**
 * Wer hat es getan? Steht im Kartenprotokoll (Spalte durch) und sagt der
 * Technik, über welchen Weg die Aktion kam.
 */
function durchText(req) {
  const u = req?.user || {};
  const wer = `${u.name || u.email || '?'} <${u.email || '?'}>`;
  if (req?.anlage?.ext) return `Telefon ${req.anlage.ext} (${wer})`;
  const app = req?.rosenwegApp?.text || req?.appKarte?.app_name || req?.appKarte?.app;
  if (app) return `${String(app).slice(0, 80)} (${wer})`;
  return `Portal (${wer})`;
}

/**
 * deps: { accessKarteZurUid(nfcId, frisch), accessKarteImportieren(nfcId, alias),
 *         karteNachschlagen(nfcId), unifiUserByEmail(email), unifiAccessRaw(m, p, body),
 *         accessOk(r), accessKartenBesitzerId(k), accessKartenBesitzerName(k),
 *         accessKartenCacheLeeren(), kartenProtokollieren(aktion, felder) }
 * Jede Funktion -> { status, body } (wirft nicht).
 */
function kartenVerwaltung(deps) {
  const ok = (r) => deps.accessOk(r) && (!r.body?.code || r.body.code === 'SUCCESS');
  const erreichbar = (r) => {
    if (r.status === 0) throw Object.assign(new Error('UniFi Access nicht erreichbar'), { http: 502 });
  };

  /** Wem gehoert die Karte? Fuer Menschen: ohne Gruppen und Website-ID. */
  async function info(nfcId, durch, { protokoll = true } = {}) {
    if (!nfcIdGueltig(nfcId)) return { status: 400, body: { error: 'Karte nicht lesbar' } };
    try {
      const { karte, ...d } = await deps.karteNachschlagen(nfcId);
      const p = d.person;
      const body = { ...d, person: p ? { name: p.name || null, email: p.email || null } : null, uid: nfcId };
      if (protokoll) {
        await deps.kartenProtokollieren('info', { nfcId, displayId: d.display_id, email: p?.email, name: p?.name || d.access_name,
          durch, erfolg: true, detail: d.found ? (d.assigned ? 'zugeordnet' : 'frei') : 'unbekannt' });
      }
      return { status: 200, body };
    } catch (e) { return fehlerAntwort(e); }
  }

  async function zuordnen(nfcId, emailRoh, durch) {
    const email = String(emailRoh || '').toLowerCase().trim();
    if (!nfcIdGueltig(nfcId)) return { status: 400, body: { error: 'Ungueltige Karten-UID' } };
    if (!emailGueltig(email)) return { status: 400, body: { error: 'E-Mail fehlt' } };
    const log = { nfcId, email, durch };
    try {
      const au = await deps.unifiUserByEmail(email);
      if (!au) {
        await deps.kartenProtokollieren('zuordnen', { ...log, erfolg: false, detail: 'kein Access-Benutzer' });
        return { status: 404, body: { error: 'Diese Person hat keinen Benutzer in UniFi Access — bitte zuerst dort anlegen.' } };
      }
      const auName = au.full_name || `${au.first_name || ''} ${au.last_name || ''}`.trim() || email;
      let k = await deps.accessKarteZurUid(nfcId, true);
      let importiert = false;
      if (!k) { k = await deps.accessKarteImportieren(nfcId, `Rosenweg ${email}`); importiert = true; }
      const besitzer = deps.accessKartenBesitzerId(k);
      if (besitzer && String(besitzer) !== String(au.id)) {
        const wer = deps.accessKartenBesitzerName(k) || 'jemand anderem';
        await deps.kartenProtokollieren('zuordnen', { ...log, displayId: k.display_id, name: auName, erfolg: false, detail: `gehoert ${wer}` });
        return { status: 409, body: { error: `Die Karte gehört bereits ${wer}. Zuerst entziehen.`, besitzer: { name: wer } } };
      }
      if (besitzer) return { status: 200, body: { ok: true, schon: true, display_id: k.display_id || null, name: auName } };
      const r = await deps.unifiAccessRaw('PUT', `/users/${encodeURIComponent(au.id)}/nfc_cards`, { token: k.token });
      deps.accessKartenCacheLeeren();
      erreichbar(r);
      const gut = ok(r);
      await deps.kartenProtokollieren('zuordnen', { ...log, displayId: k.display_id, name: auName, erfolg: gut,
        detail: (importiert ? 'importiert; ' : '') + (gut ? '' : `${r.status} ${r.body?.msg || ''}`) });
      if (!gut) return { status: 502, body: { error: r.body?.msg || 'Zuordnen in UniFi Access fehlgeschlagen' } };
      return { status: 200, body: { ok: true, importiert, display_id: k.display_id || null, name: auName } };
    } catch (e) { return fehlerAntwort(e); }
  }

  /** Zuordnung loesen; die Karte bleibt in der Access-Inventur. */
  async function entziehen(nfcId, durch) {
    if (!nfcIdGueltig(nfcId)) return { status: 400, body: { error: 'Ungueltige Karten-UID' } };
    try {
      const k = await deps.accessKarteZurUid(nfcId, true);
      if (!k) return { status: 404, body: { error: 'Karte nicht bekannt' } };
      const besitzer = deps.accessKartenBesitzerId(k);
      if (!besitzer) return { status: 200, body: { ok: true, schon: true, display_id: k.display_id || null } };
      const wer = deps.accessKartenBesitzerName(k);
      const r = await deps.unifiAccessRaw('PUT', `/users/${encodeURIComponent(besitzer)}/nfc_cards/delete`, { token: k.token });
      deps.accessKartenCacheLeeren();
      erreichbar(r);
      const gut = ok(r);
      await deps.kartenProtokollieren('entziehen', { nfcId, displayId: k.display_id, name: wer, durch, erfolg: gut,
        detail: gut ? '' : `${r.status} ${r.body?.msg || ''}` });
      if (!gut) return { status: 502, body: { error: r.body?.msg || 'Entziehen in UniFi Access fehlgeschlagen' } };
      return { status: 200, body: { ok: true, display_id: k.display_id || null, name: wer } };
    } catch (e) { return fehlerAntwort(e); }
  }

  /** Aus dem Bestand loeschen (defekt/verloren); nur Karten ohne Inhaber. */
  async function loeschen(nfcId, durch) {
    if (!nfcIdGueltig(nfcId)) return { status: 400, body: { error: 'Ungueltige Karten-UID' } };
    try {
      const k = await deps.accessKarteZurUid(nfcId, true);
      if (!k) return { status: 404, body: { error: 'Karte nicht bekannt' } };
      if (deps.accessKartenBesitzerId(k)) return { status: 409, body: { error: 'Karte ist noch zugeordnet - zuerst entziehen' } };
      const r = await deps.unifiAccessRaw('DELETE', `/credentials/nfc_cards/tokens/${encodeURIComponent(k.token)}`);
      deps.accessKartenCacheLeeren();
      erreichbar(r);
      const gut = ok(r);
      await deps.kartenProtokollieren('loeschen', { nfcId, displayId: k.display_id, name: '', durch, erfolg: gut,
        detail: gut ? '' : `${r.status} ${r.body?.msg || ''}` });
      if (!gut) return { status: 502, body: { error: r.body?.msg || 'Loeschen in UniFi Access fehlgeschlagen' } };
      return { status: 200, body: { ok: true, display_id: k.display_id || null } };
    } catch (e) { return fehlerAntwort(e); }
  }

  return { info, zuordnen, entziehen, loeschen };
}

/** Auswahlliste "Einer Person zuordnen": eine Zeile je E-Mail, nach Name. */
function personenListe(zeilen) {
  const je = new Map();
  for (const z of zeilen || []) {
    const email = String(z?.email || '').toLowerCase().trim();
    if (!emailGueltig(email)) continue;
    const name = String(z?.name || '').trim() || email;
    if (!je.has(email) || name.localeCompare(je.get(email)) < 0) je.set(email, name);
  }
  return [...je].map(([email, name]) => ({ name, email }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) || a.email.localeCompare(b.email));
}

// ─── Übernahme des alten Kartenprotokolls der PBX (telefon_log) ─────────────
// Die PBX schrieb Kartenaktionen in ihr telefon_log (SQLite). Sie schickt diese
// Zeilen einmal an POST /api/pbx/karten-protokoll/uebernahme; jede bekommt die
// Quelle "pbx:<id>" (UNIQUE), ein zweiter Lauf legt nichts doppelt an.
// An- und Abmeldungen am Telefon (an, ab, karte-abgelehnt, gefunden) bleiben
// in der PBX: sie gehören zum Telefon, nicht zur Kartenverwaltung.
const PBX_EREIGNISSE = {
  'karte-info': 'telefon-info',
  'karte-zu': 'telefon-zuordnen',
  'karte-weg': 'telefon-entziehen',
  'karte-geloescht': 'telefon-loeschen',
};

/** Zeile aus telefon_log -> Zeile fuer access_karten_protokoll, oder null. */
function pbxZeileUebernehmen(z) {
  const aktion = PBX_EREIGNISSE[z?.ereignis];
  const id = Number(z?.id);
  if (!aktion || !Number.isInteger(id) || id <= 0) return null;
  const zeit = new Date(String(z.zeit || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(z.zeit || '')) ? '' : 'Z'));
  if (Number.isNaN(zeit.getTime())) return null;
  // durch der PBX: "karte:0042->ziel@x:409" (Karte, Ziel, Status bei Fehler)
  const d = String(z.durch || '');
  const m = d.match(/^karte:([^\s>:-]*)(?:->([^\s:]+))?(?::(\d{3}))?$/);
  const ext = String(z.ext || '');
  return {
    quelle: `pbx:${id}`,
    aktion,
    display_id: m && m[1] ? m[1].slice(0, 40) : null,
    ziel_email: m && m[2] && emailGueltig(m[2]) ? m[2].toLowerCase().slice(0, 200) : null,
    ziel_name: null,
    durch: `${ext === 'App' ? 'Rosenweg Karten' : 'Telefon ' + ext} (${String(z.name || '').slice(0, 80)} <${String(z.email || '').slice(0, 120)}>)`,
    erfolg: !(m && m[3]),
    detail: `aus der Telefonanlage übernommen${m && m[3] ? '; HTTP ' + m[3] : ''}`.slice(0, 500),
    created_at: zeit.toISOString(),
  };
}

module.exports = {
  normNfcId, nfcIdGueltig, emailGueltig, durchText, kartenVerwaltung, personenListe,
  PBX_EREIGNISSE, pbxZeileUebernehmen, fehlerAntwort,
};
