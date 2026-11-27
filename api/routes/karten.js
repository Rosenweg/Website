// ─── Kartenverwaltung: /api/karten/* (aus der Telefonanlage umgezogen) ──────
//
// Entscheid Stefan 27.11.2026: Karten gehören nicht in die Telefonanlage.
// Die Routen lagen als /api/telefon/karten/* in der PBX-API (CT 220) und
// liegen jetzt hier; die Logik steht in lib/kartenverwaltung.js.
//
//   GET  /api/karten/personen     Auswahlliste "Einer Person zuordnen"
//   POST /api/karten/info         {uid} -> wem gehört die Karte
//   POST /api/karten/zuordnen     {uid, email}
//   POST /api/karten/entziehen    {uid}
//   POST /api/karten/loeschen     {uid}  (nur Karten ohne Inhaber)
//   GET  /api/karten/protokoll    ?tage=&aktion=&email=  (= /api/karten-protokoll)
//
// Rechte wie bisher: Technik oder Präsident (requireTechnikOrPraesident). Eine
// Seite "karten" in der Rechteverwaltung gibt es nicht; kommt eine dazu, hier
// requirePermission('karten', …) ergänzen.
//
// Anmeldung: jede, die authMiddleware kennt — Website, rosenweg-apps-Token,
// Karten-/QR-/Handy-Sitzung (rw_app_) und das Anlage-Token der geteilten
// Telefone. Karte = Schlüssel (volle Rechte); requireTechnikOrPraesident
// vermerkt schreibende Aktionen mit der Karte im Kartenprotokoll
// ("admin-mit-karte") und quittiert sie per Mail (lib/kartenadmin.js). Keine
// der Kartenaktionen gehört zu den zwölf heiklen mit E-Mail-Bestätigung.
//
// Übergang: Die alten Pfade der PBX (/api/telefon/karten/*) reichen an diese
// Routen weiter (pbx/api/app.py), bis die alte App Rosenweg Karten von den
// Telefonen ist. Das Kartenprotokoll der PBX übernimmt
// POST /api/pbx/karten-protokoll/uebernahme (PBX-Geheimnis, einmalig).
'use strict';

const kv = require('../lib/kartenverwaltung');

function kartenRoutes(app, deps) {
  const { pool, authMiddleware, requireTechnikOrPraesident, requirePbxSecret, kartenProtokollieren } = deps;
  const verwaltung = kv.kartenVerwaltung(deps);
  const uid = (req) => kv.normNfcId(req.body?.uid ?? req.body?.nfc_id);
  const senden = (res) => ({ status, body }) => res.status(status).json(body);
  const nurTechnik = [authMiddleware, requireTechnikOrPraesident];

  // Personen mit E-Mail: die Personen mit interner Nummer (Abbild der Telefonanlage,
  // telefon_interne_nummern - dieselbe Liste wie bisher in der PBX). Leer oder noch
  // nicht abgeglichen: aktive Konten.
  app.get('/api/karten/personen', ...nurTechnik, async (_req, res) => {
    try {
      let zeilen = [];
      try {
        zeilen = (await pool.query(`SELECT LOWER(email) AS email, MIN(name) AS name FROM telefon_interne_nummern
            WHERE aktiv AND COALESCE(email,'') <> '' GROUP BY LOWER(email)`)).rows;
      } catch (e) { if (!/does not exist/.test(e.message)) throw e; }
      if (!zeilen.length) {
        zeilen = (await pool.query(`SELECT LOWER(email) AS email, MIN(name) AS name FROM users
            WHERE COALESCE(active, true) AND COALESCE(email,'') <> '' GROUP BY LOWER(email)`)).rows;
      }
      res.json({ personen: kv.personenListe(zeilen) });
    } catch (e) {
      console.error('[karten] personen:', e.message);
      res.status(500).json({ error: 'Abfrage fehlgeschlagen' });
    }
  });

  // Nachschlagen aendert nichts (POST nur wegen der UID im Koerper): kein "admin-mit-karte"
  // und keine Quittung; es steht ohnehin als "info" mit "durch" im Kartenprotokoll.
  const nurLesen = (req, _res, next) => { req._kartenAdminVermerk = true; next(); };
  app.post('/api/karten/info', authMiddleware, nurLesen, requireTechnikOrPraesident, async (req, res) => {
    senden(res)(await verwaltung.info(uid(req), kv.durchText(req)));
  });
  app.post('/api/karten/zuordnen', ...nurTechnik, async (req, res) => {
    senden(res)(await verwaltung.zuordnen(uid(req), req.body?.email, kv.durchText(req)));
  });
  app.post('/api/karten/entziehen', ...nurTechnik, async (req, res) => {
    senden(res)(await verwaltung.entziehen(uid(req), kv.durchText(req)));
  });
  app.post('/api/karten/loeschen', ...nurTechnik, async (req, res) => {
    senden(res)(await verwaltung.loeschen(uid(req), kv.durchText(req)));
  });

  // Kartenprotokoll fuer die Technik. ?aktion=admin-mit-karte (Admin-Aktionen mit der Karte),
  // bestaetigung-angefragt | bestaetigt | abgelehnt | app-anmeldung | info | zuordnen | telefon-… ;
  // ?email=; ?tage= (Standard 30, hoechstens 365)
  async function protokoll(req, res) {
    try {
      const tage = Math.min(365, Math.max(1, parseInt(req.query.tage, 10) || 30));
      const bed = ['created_at > NOW() - make_interval(days => $1)'];
      const p = [tage];
      if (req.query.aktion) { p.push(String(req.query.aktion)); bed.push(`aktion = $${p.length}`); }
      if (req.query.email) { p.push(String(req.query.email).toLowerCase()); bed.push(`LOWER(ziel_email) = $${p.length}`); }
      const r = await pool.query(`SELECT id, aktion, nfc_id, display_id, ziel_email, ziel_name, durch, erfolg, detail, created_at
          FROM access_karten_protokoll WHERE ${bed.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, p);
      res.json({ tage, eintraege: r.rows });
    } catch (e) {
      if (/does not exist/.test(e.message)) return res.json({ tage: 30, eintraege: [] });
      console.error('[karten-protokoll]', e.message);
      res.status(500).json({ error: 'Abfrage fehlgeschlagen' });
    }
  }
  app.get('/api/karten/protokoll', ...nurTechnik, protokoll);
  app.get('/api/karten-protokoll', ...nurTechnik, protokoll);   // alter Pfad (Website, Karten 2.0)

  // Einmalige Uebernahme des Kartenprotokolls der PBX (telefon_log). Body {zeilen:[telefon_log-Zeilen]},
  // hoechstens 1000 je Aufruf. Idempotent ueber quelle = 'pbx:<id>'.
  let spalteBereit = null;
  app.post('/api/pbx/karten-protokoll/uebernahme', requirePbxSecret, async (req, res) => {
    const roh = Array.isArray(req.body?.zeilen) ? req.body.zeilen : null;
    if (!roh || roh.length > 1000) return res.status(400).json({ error: 'zeilen fehlt oder mehr als 1000' });
    const zeilen = roh.map(kv.pbxZeileUebernehmen).filter(Boolean);
    try {
      // Tabelle wie kartenProtokollieren sie anlegt, plus Herkunft der uebernommenen Zeilen
      await kartenProtokollieren('uebernahme', { durch: 'pbx', erfolg: true, detail: `${zeilen.length} von ${roh.length} Zeilen` });
      spalteBereit ??= pool.query(`ALTER TABLE access_karten_protokoll ADD COLUMN IF NOT EXISTS quelle TEXT;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_akp_quelle ON access_karten_protokoll(quelle) WHERE quelle IS NOT NULL`);
      await spalteBereit;
      let neu = 0;
      for (const z of zeilen) {
        const r = await pool.query(`INSERT INTO access_karten_protokoll
            (quelle, aktion, display_id, ziel_email, ziel_name, durch, erfolg, detail, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (quelle) WHERE quelle IS NOT NULL DO NOTHING`,
          [z.quelle, z.aktion, z.display_id, z.ziel_email, z.ziel_name, z.durch, z.erfolg, z.detail, z.created_at]);
        neu += r.rowCount;
      }
      res.json({ ok: true, gelesen: roh.length, uebernommen: neu, uebersprungen: roh.length - zeilen.length, schon_da: zeilen.length - neu });
    } catch (e) {
      spalteBereit = null;
      console.error('[karten-protokoll] uebernahme:', e.message);
      res.status(500).json({ error: 'Uebernahme fehlgeschlagen' });
    }
  });

  return verwaltung;
}

module.exports = { kartenRoutes };
