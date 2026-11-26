// ═══════════════════════════════════════════════════════════════════
// SALZVORRAT der Enthärtungsanlagen (Rosenweg 2, 4, 9, Kooperation)
// ═══════════════════════════════════════════════════════════════════
//
// Ein Lager je Standort mit eigenem Bestand an Säcken. Gebucht wird mit der
// App „Rosenweg Salz“ (Barcode des Sacks scannen): Anlieferung (+n Säcke)
// und „Sack eingefüllt“ (−1). Unbekannte Barcodes werden einmal als Sorte
// mit Gewicht erfasst. Die Portal-Seite salz.html zeigt Bestand und Verlauf
// und stellt die Schwellen ein.
//
// Nachbestellen: aus dem Verbrauch je Lager (lib/salz.js) die Reichweite in
// Wochen; unter der Schwelle eine Mail an die Technik, einmal pro
// Unterschreitung, Erinnerung nach `wiederholung_tage`. Ohne genug
// Verbrauchsdaten zählt der Mindestbestand.
//
// Anmeldung: authMiddleware — nimmt die Portal-Anmeldung und die Tokens der
// Rosenweg-Apps (Authentik rosenweg-apps, lib/auth.js validateAppToken). Buchen darf Technik/Präsident und wer in einer Gruppe aus
// SALZ_GRUPPEN ist (z. B. Hauswart); Schwellen, Inventur und Sorten ändern
// nur Technik/Präsident.

const express = require('express');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik, isPraesident, STWEG_GROUPS } = require('../lib/groups');
const { resolveAncestorGroups } = require('../lib/auth');
const { HAEUSER, stwegVonHaus } = require('../lib/haeuser');
const { loggedSendMail, MAIL_FROM } = require('../lib/mail');
const { FENSTER_TAGE, verbrauchProWoche, lagerStand, meldeEntscheid, meldungsText, reichtText } = require('../lib/salz');

const MELDUNG_AN = process.env.SALZ_MELDUNG_AN || 'technik@rosenweg4303.ch';
const PORTAL_URL = process.env.SALZ_PORTAL_URL || 'https://rosenweg4303.ch/salz.html';
const SALZ_GRUPPEN = (process.env.SALZ_GRUPPEN || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Die Lager. „Rosenweg Kooperation“ ist kein Haus (haeuser.js kennt nur
// Hausnummern), sondern ein eigener Standort der Kooperation — darum
// haus = null; das Lager steht im Rosenweg 10 (Entscheid Stefan 26.11.2026).
//
// bewohnerHaus: wessen Bewohnergruppe in diesem Lager buchen darf. Die Gruppe
// kommt aus STWEG_GROUPS (lib/groups.js) über das STWEG des Hauses — es gibt
// keine Bewohnergruppe je Haus, nur je STWEG. Folge: Rosenweg 2 und 4 sind
// beide STWEG 7, ihre Bewohner dürfen in beiden Lagern buchen; die Kooperation
// (Rosenweg 10) gehört zu STWEG 4. Die Technik kann die Gruppen je Lager im
// Portal ändern (Spalte bewohner_gruppen); das hier ist nur der Anfang.
const LAGER_START = [
  { schluessel: 'haus2', name: 'Rosenweg 2', haus: 2, ort: null, bewohnerHaus: 2, reihenfolge: 1 },
  { schluessel: 'haus4', name: 'Rosenweg 4', haus: 4, ort: null, bewohnerHaus: 4, reihenfolge: 2 },
  { schluessel: 'haus9', name: 'Rosenweg 9', haus: 9, ort: null, bewohnerHaus: 9, reihenfolge: 3 },
  { schluessel: 'kooperation', name: 'Rosenweg Kooperation', haus: null, ort: 'Lager im Rosenweg 10', bewohnerHaus: 10, reihenfolge: 4 },
];
for (const l of LAGER_START) {
  for (const h of [l.haus, l.bewohnerHaus]) {
    if (h != null && !HAEUSER.includes(h)) throw new Error(`salz: Haus ${h} fehlt in lib/haeuser.js`);
  }
  const g = STWEG_GROUPS[stwegVonHaus(l.bewohnerHaus)]?.bewohner;
  if (!g) throw new Error(`salz: keine Bewohnergruppe für Haus ${l.bewohnerHaus}`);
  l.bewohnerGruppen = [g];
}

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;

// EAN-13/EAN-8/UPC/Code 128 — lesbare Zeichen, keine Steuerzeichen.
const BARCODE_RE = /^[\x21-\x7e]{4,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const STORNO_EIGENE_STUNDEN = 24;

function istVerwalter(user) {
  const g = user?.groups || [];
  return Boolean(user?.isAdmin || isTechnik(g) || isPraesident(g));
}

/** Darf in allen Lagern buchen und neue Sorten erfassen (Technik, Präsident, SALZ_GRUPPEN). */
function darfAlleLager(user) {
  if (istVerwalter(user)) return true;
  const g = (user?.groups || []).map(x => String(x).toLowerCase());
  return SALZ_GRUPPEN.some(s => g.includes(s));
}

/**
 * Die Lager, in denen diese Person buchen darf: alle (Technik usw.) oder die
 * Lager, deren bewohner_gruppen sie (auch über eine Obergruppe) angehört.
 * lagerZeilen: [{id, bewohner_gruppen}].
 */
async function erlaubteLager(user, lagerZeilen) {
  if (darfAlleLager(user)) return new Set(lagerZeilen.map(l => l.id));
  const eigene = new Set(await resolveAncestorGroups((user?.groups || []).map(String)));
  return new Set(lagerZeilen
    .filter(l => (l.bewohner_gruppen || []).some(g => eigene.has(String(g).toLowerCase())))
    .map(l => l.id));
}

async function lagerRechte(user) {
  const r = await pool.query('SELECT id, bewohner_gruppen FROM salz_lager WHERE aktiv');
  return erlaubteLager(user, r.rows);
}

let schemaVersprechen = null;
function ensureSchema() {
  if (!schemaVersprechen) {
    schemaVersprechen = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS salz_lager (
          id SERIAL PRIMARY KEY,
          schluessel TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          haus INT,
          reihenfolge INT NOT NULL DEFAULT 0,
          schwelle_wochen NUMERIC(5,1) NOT NULL DEFAULT 4 CHECK (schwelle_wochen >= 0 AND schwelle_wochen <= 52),
          mindest_saecke INT NOT NULL DEFAULT 4 CHECK (mindest_saecke >= 0 AND mindest_saecke <= 500),
          wiederholung_tage INT NOT NULL DEFAULT 7 CHECK (wiederholung_tage >= 0 AND wiederholung_tage <= 90),
          meldung_seit TIMESTAMPTZ,
          meldung_zuletzt TIMESTAMPTZ,
          aktiv BOOLEAN NOT NULL DEFAULT true,
          geaendert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      // Ort (Anzeige), Hauswart-Adressen (bekommen die Meldung mit) und die
      // Bewohnergruppen, die in diesem Lager buchen dürfen.
      await pool.query(`ALTER TABLE salz_lager
          ADD COLUMN IF NOT EXISTS ort TEXT,
          ADD COLUMN IF NOT EXISTS hauswart_emails TEXT[] NOT NULL DEFAULT '{}',
          ADD COLUMN IF NOT EXISTS bewohner_gruppen TEXT[]`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS salz_sorten (
          barcode TEXT PRIMARY KEY,
          bezeichnung TEXT NOT NULL,
          gewicht_kg NUMERIC(6,2) NOT NULL CHECK (gewicht_kg > 0 AND gewicht_kg <= 100),
          erfasst_von TEXT,
          erfasst_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS salz_buchungen (
          id SERIAL PRIMARY KEY,
          lager_id INT NOT NULL REFERENCES salz_lager(id),
          art TEXT NOT NULL CHECK (art IN ('anlieferung','eingefuellt','korrektur')),
          saecke INT NOT NULL CHECK (saecke <> 0),
          barcode TEXT REFERENCES salz_sorten(barcode) ON UPDATE CASCADE,
          kg_je_sack NUMERIC(6,2) NOT NULL,
          notiz TEXT,
          client_id TEXT UNIQUE,
          gebucht_von TEXT,
          gebucht_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          storniert_am TIMESTAMPTZ,
          storniert_von TEXT
        )`);
      await pool.query('CREATE INDEX IF NOT EXISTS salz_buchungen_lager_am ON salz_buchungen (lager_id, gebucht_am)');
      for (const l of LAGER_START) {
        await pool.query(
          `INSERT INTO salz_lager (schluessel, name, haus, ort, reihenfolge, bewohner_gruppen) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (schluessel) DO NOTHING`, [l.schluessel, l.name, l.haus, l.ort, l.reihenfolge, l.bewohnerGruppen]);
        // Bestehende Zeilen (erste Fassung): Bewohnergruppen nur setzen, wenn
        // noch nie gesetzt — eine Änderung im Portal bleibt stehen.
        await pool.query('UPDATE salz_lager SET bewohner_gruppen = $2 WHERE schluessel = $1 AND bewohner_gruppen IS NULL',
          [l.schluessel, l.bewohnerGruppen]);
      }
      // Umbenennung 26.11.2026: "Kooperation" -> "Rosenweg Kooperation", Ort Rosenweg 10.
      await pool.query(`UPDATE salz_lager SET name = 'Rosenweg Kooperation', ort = COALESCE(ort, 'Lager im Rosenweg 10')
                         WHERE schluessel = 'kooperation' AND name = 'Kooperation'`);
    })().catch(e => { schemaVersprechen = null; throw e; });
  }
  return schemaVersprechen;
}

// ─── Lesen ─────────────────────────────────────────────────────────

/** Alle aktiven Lager mit Bestand, Verbrauch, Reichweite. lagerId: nur eines. */
async function lagerUebersicht(lagerId = null, db = pool) {
  const lager = await db.query(
    `SELECT l.*,
            COALESCE(SUM(b.saecke) FILTER (WHERE b.storniert_am IS NULL), 0)::int AS bestand_saecke,
            COALESCE(SUM(b.saecke * b.kg_je_sack) FILTER (WHERE b.storniert_am IS NULL), 0)::float AS bestand_kg,
            MAX(b.gebucht_am) FILTER (WHERE b.storniert_am IS NULL AND b.art = 'anlieferung') AS letzte_anlieferung,
            MAX(b.gebucht_am) FILTER (WHERE b.storniert_am IS NULL AND b.art = 'eingefuellt') AS letzte_einfuellung,
            COUNT(b.id) FILTER (WHERE b.storniert_am IS NULL)::int AS buchungen
       FROM salz_lager l LEFT JOIN salz_buchungen b ON b.lager_id = l.id
      WHERE l.aktiv AND ($1::int IS NULL OR l.id = $1)
      GROUP BY l.id ORDER BY l.reihenfolge, l.id`, [lagerId]);
  const ein = await db.query(
    `SELECT lager_id, gebucht_am AS am, (-saecke * kg_je_sack)::float AS kg
       FROM salz_buchungen
      WHERE art = 'eingefuellt' AND storniert_am IS NULL
        AND ($1::int IS NULL OR lager_id = $1)`, [lagerId]);
  const jetzt = new Date();
  return lager.rows.map(l => {
    const v = verbrauchProWoche(ein.rows.filter(e => e.lager_id === l.id), jetzt);
    const schwelle = Number(l.schwelle_wochen);
    const stand = lagerStand({
      bestandSaecke: l.bestand_saecke, bestandKg: l.bestand_kg, kgProWoche: v.kgProWoche,
      schwelleWochen: schwelle, mindestSaecke: l.mindest_saecke,
    });
    // Ein Lager, in dem noch nie gebucht wurde, ist noch nicht in Betrieb:
    // kein Alarm für „0 Säcke“, bevor jemand die erste Lieferung erfasst hat.
    const inBetrieb = l.buchungen > 0;
    return {
      id: l.id, schluessel: l.schluessel, name: l.name, haus: l.haus, ort: l.ort || null, in_betrieb: inBetrieb,
      bestand_saecke: l.bestand_saecke, bestand_kg: Math.round(l.bestand_kg * 10) / 10,
      verbrauch_kg_woche: v.kgProWoche == null ? null : Math.round(v.kgProWoche * 10) / 10,
      einfuellungen_im_fenster: v.einfuellungen,
      modus: stand.modus, reichweite_wochen: stand.reichweiteWochen, knapp: inBetrieb && stand.knapp,
      schwelle_wochen: schwelle, mindest_saecke: l.mindest_saecke, wiederholung_tage: l.wiederholung_tage,
      meldung_seit: l.meldung_seit, meldung_zuletzt: l.meldung_zuletzt,
      letzte_anlieferung: l.letzte_anlieferung, letzte_einfuellung: l.letzte_einfuellung,
      hauswart_emails: l.hauswart_emails || [], bewohner_gruppen: l.bewohner_gruppen || [],
    };
  });
}

// ─── Meldung an die Technik ────────────────────────────────────────

let meldelaufAktiv = false;
async function meldelauf({ lagerId = null, nurTagsueber = false } = {}) {
  // Erinnerungen nicht mitten in der Nacht; Buchungen geschehen ohnehin tagsüber.
  if (nurTagsueber) {
    // formatToParts: format() liefert auf Deutsch "16 Uhr", nicht "16".
    const stunde = Number(new Intl.DateTimeFormat('de-CH', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Zurich' })
      .formatToParts(new Date()).find(t => t.type === 'hour')?.value);
    if (stunde < 7 || stunde >= 20) return;
  }
  if (meldelaufAktiv) return;
  meldelaufAktiv = true;
  try {
    await ensureSchema();
    for (const l of await lagerUebersicht(lagerId)) {
      const was = meldeEntscheid({
        knapp: l.knapp, meldungSeit: l.meldung_seit, meldungZuletzt: l.meldung_zuletzt,
        letzteAnlieferung: l.letzte_anlieferung, wiederholungTage: l.wiederholung_tage,
      });
      if (was === 'nichts') continue;
      if (was === 'entwarnen') {
        await pool.query('UPDATE salz_lager SET meldung_seit = NULL, meldung_zuletzt = NULL WHERE id = $1', [l.id]);
        console.log(`[salz] ${l.name}: wieder genug Salz`);
        continue;
      }
      // Erst den Zustand setzen (bedingt — ein zweiter Lauf gleichzeitig
      // findet nichts mehr; Vergleich auf Millisekunden, so genau kommt die
      // Zeit aus JavaScript zurück), dann senden; scheitert die Mail, zurücksetzen,
      // damit der nächste Lauf es nochmals versucht.
      const gesetzt = was === 'melden'
        ? await pool.query(`UPDATE salz_lager SET meldung_seit = NOW(), meldung_zuletzt = NOW()
                              WHERE id = $1 AND meldung_seit IS NULL RETURNING id`, [l.id])
        : await pool.query(`UPDATE salz_lager SET meldung_zuletzt = NOW()
                              WHERE id = $1 AND date_trunc('milliseconds', meldung_zuletzt) IS NOT DISTINCT FROM $2::timestamptz RETURNING id`, [l.id, l.meldung_zuletzt]);
      if (gesetzt.rowCount === 0) continue;
      const erinnerung = was === 'erinnern';
      const kurz = l.modus === 'reichweite' ? `reicht noch ${reichtText(l.reichweite_wochen)}` : `noch ${l.bestand_saecke} ${l.bestand_saecke === 1 ? 'Sack' : 'Säcke'}`;
      // An die Technik und den Hauswart dieses Lagers (Entscheid 26.11.2026).
      const an = [...new Set([MELDUNG_AN, ...(l.hauswart_emails || [])].map(e => String(e).trim().toLowerCase()).filter(Boolean))];
      try {
        await loggedSendMail({
          from: MAIL_FROM, to: an.join(', '),
          subject: `${erinnerung ? 'Erinnerung: ' : ''}Salz nachbestellen – ${l.name} (${kurz})`,
          text: meldungsText({
            lager: l.name, ort: l.ort, stand: { modus: l.modus, reichweiteWochen: l.reichweite_wochen },
            bestandSaecke: l.bestand_saecke, bestandKg: l.bestand_kg, kgProWoche: l.verbrauch_kg_woche,
            schwelleWochen: l.schwelle_wochen, mindestSaecke: l.mindest_saecke, erinnerung, portalUrl: PORTAL_URL,
          }),
        }, erinnerung ? 'salz-erinnerung' : 'salz-nachbestellen');
        console.log(`[salz] ${l.name}: ${erinnerung ? 'Erinnerung' : 'Meldung'} an ${an.length} Empfänger (${kurz})`);
      } catch (e) {
        console.error(`[salz] Mail ${l.name}:`, e.message);
        if (erinnerung) await pool.query('UPDATE salz_lager SET meldung_zuletzt = $2 WHERE id = $1', [l.id, l.meldung_zuletzt]);
        else await pool.query('UPDATE salz_lager SET meldung_seit = NULL, meldung_zuletzt = NULL WHERE id = $1', [l.id]);
      }
    }
  } finally {
    meldelaufAktiv = false;
  }
}

function meldelaufBald(lagerId) {
  setImmediate(() => meldelauf({ lagerId }).catch(e => console.error('[salz] Meldelauf:', e.message)));
}

/** Stündlich prüfen (Erinnerungen, gleitendes Verbrauchsfenster). */
function starteSalzCron(intervalle = []) {
  const lauf = () => meldelauf({ nurTagsueber: true }).catch(e => console.error('[salz] Meldelauf:', e.message));
  intervalle.push(setInterval(lauf, 60 * 60 * 1000));
  setTimeout(lauf, 2 * 60 * 1000);
}

// ─── Router ────────────────────────────────────────────────────────

function salzRouter({ rateLimitGuard }) {
  const router = express.Router();

  // Grenzen je Konto. Eine Lieferung sind selten mehr als ein paar Buchungen;
  // die App fragt die Übersicht beim Öffnen und nach jeder Buchung.
  const grenze = (name, max) => (req, res, next) => {
    const r = rateLimitGuard(`salz-${name}`, req.user.email || req.ip, max, 60 * 60 * 1000);
    if (r.ok) return next();
    if (r.retryAfter) res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: 'Zu viele Anfragen — bitte später erneut.' });
  };
  const lesen = grenze('lesen', 600);
  const fehler = (res, e, wo) => {
    console.error(`[salz] ${wo}:`, e.message);
    res.status(500).json({ error: 'Interner Fehler' });
  };
  const schreiben = grenze('schreiben', 120);

  const KEIN_RECHT = 'Für den Salzvorrat bist du nicht freigeschaltet. Bitte bei der Technik melden.';
  // Mindestens ein Lager; welche genau, steht danach in req.salzLager.
  const nurBuchende = async (req, res, next) => {
    try {
      req.salzLager = await lagerRechte(req.user);
      return req.salzLager.size ? next() : res.status(403).json({ error: KEIN_RECHT });
    } catch (e) { return fehler(res, e, 'rechte'); }
  };
  const fuerLager = (id, req, res) => {
    if (req.salzLager.has(id)) return true;
    res.status(403).json({ error: 'In diesem Lager darfst du nicht buchen.' });
    return false;
  };
  const nurVerwalter = (req, res, next) => istVerwalter(req.user) ? next()
    : res.status(403).json({ error: 'Nur die Technik kann das ändern.' });
  const schema = (req, res, next) => ensureSchema().then(() => next(), e => {
    console.error('[salz] Schema:', e.message);
    res.status(503).json({ error: 'Datenbank nicht bereit' });
  });

  router.use(authMiddleware, schema);

  // Wer bin ich, was darf ich? Die App zeigt danach Knöpfe oder einen Hinweis.
  router.get('/ich', lesen, async (req, res) => {
    try {
      const lager = await lagerRechte(req.user);
      res.json({ name: req.user.name || null, email: req.user.email || null,
        darf_buchen: lager.size > 0, darf_einstellen: istVerwalter(req.user),
        darf_sorten_erfassen: darfAlleLager(req.user), lager_ids: [...lager] });
    } catch (e) { fehler(res, e, 'ich'); }
  });

  // Nur die Lager, in denen die Person buchen darf (Bewohner: ihr Haus).
  // Hauswart-Adressen und Gruppen sieht nur, wer sie pflegt.
  router.get('/lager', lesen, nurBuchende, async (req, res) => {
    try {
      const verwalter = istVerwalter(req.user);
      const lager = (await lagerUebersicht()).filter(l => req.salzLager.has(l.id))
        .map(l => verwalter ? l : { ...l, hauswart_emails: undefined, bewohner_gruppen: undefined });
      res.json({ lager });
    } catch (e) { fehler(res, e, 'lager'); }
  });

  router.get('/lager/:id/verlauf', lesen, nurBuchende, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!fuerLager(id, req, res)) return;
    const anzahl = Math.min(Math.max(parseInt(req.query.anzahl, 10) || 50, 1), 500);
    try {
      const r = await pool.query(
        `SELECT b.id, b.art, b.saecke, b.barcode, s.bezeichnung, b.kg_je_sack::float AS kg_je_sack, b.notiz,
                b.gebucht_am, b.storniert_am, b.gebucht_von, u.name AS von_name
           FROM salz_buchungen b
           LEFT JOIN salz_sorten s ON s.barcode = b.barcode
           LEFT JOIN users u ON LOWER(u.email) = LOWER(b.gebucht_von)
          WHERE b.lager_id = $1 ORDER BY b.gebucht_am DESC, b.id DESC LIMIT $2`, [id, anzahl]);
      const ich = String(req.user.email || '').toLowerCase();
      const verwalter = istVerwalter(req.user);
      res.json({ buchungen: r.rows.map(b => ({
        id: b.id, art: b.art, saecke: b.saecke, barcode: b.barcode, sorte: b.bezeichnung,
        kg_je_sack: b.kg_je_sack, notiz: b.notiz, gebucht_am: b.gebucht_am, storniert_am: b.storniert_am,
        eigene: String(b.gebucht_von || '').toLowerCase() === ich,
        // Wer gebucht hat, sieht nur die Technik (Name, sonst Mail); die
        // anderen nur ihre eigenen Buchungen als solche.
        von: verwalter ? (b.von_name || b.gebucht_von) : (String(b.gebucht_von || '').toLowerCase() === ich ? (b.von_name || 'du') : null),
      })) });
    } catch (e) { fehler(res, e, 'verlauf'); }
  });

  router.put('/lager/:id', schreiben, nurVerwalter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const zahl = (v, min, max) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new RangeError();
      return n;
    };
    let schwelle, mindest, wiederholung;
    try {
      schwelle = zahl(b.schwelle_wochen, 0, 52);
      mindest = zahl(b.mindest_saecke, 0, 500);
      wiederholung = zahl(b.wiederholung_tage, 0, 90);
    } catch { return res.status(400).json({ error: 'Schwelle 0–52 Wochen, Mindestbestand 0–500 Säcke, Wiederholung 0–90 Tage' }); }
    // Listen: Array oder Text mit Komma/Zeilen; fehlt das Feld, bleibt es.
    const liste = v => v == null ? null
      : (Array.isArray(v) ? v : String(v).split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
    const hauswart = liste(b.hauswart_emails);
    if (hauswart && (hauswart.length > 10 || hauswart.some(e => !EMAIL_RE.test(e) || e.length > 200))) {
      return res.status(400).json({ error: 'Hauswart: gültige Mailadressen (höchstens 10)' });
    }
    const gruppen = liste(b.bewohner_gruppen);
    if (gruppen && (gruppen.length > 10 || gruppen.some(g => !/^[\p{L}0-9._-]{2,80}$/u.test(g)))) {
      return res.status(400).json({ error: 'Bewohnergruppen: Gruppennamen aus Authentik (höchstens 10)' });
    }
    try {
      const r = await pool.query(
        `UPDATE salz_lager SET schwelle_wochen = COALESCE($2, schwelle_wochen),
                mindest_saecke = COALESCE($3, mindest_saecke),
                wiederholung_tage = COALESCE($4, wiederholung_tage),
                hauswart_emails = COALESCE($5, hauswart_emails),
                bewohner_gruppen = COALESCE($6, bewohner_gruppen), geaendert_am = NOW()
          WHERE id = $1 AND aktiv RETURNING id`,
        [id, schwelle, mindest == null ? null : Math.round(mindest), wiederholung == null ? null : Math.round(wiederholung),
          hauswart && hauswart.map(e => e.toLowerCase()), gruppen && gruppen.map(g => g.toLowerCase())]);
      if (!r.rowCount) return res.status(404).json({ error: 'Lager nicht gefunden' });
      meldelaufBald(id);
      res.json({ lager: (await lagerUebersicht(id))[0] });
    } catch (e) { fehler(res, e, 'lager-put'); }
  });

  // ── Sorten ──
  router.get('/sorten', lesen, nurBuchende, async (req, res) => {
    try {
      const r = await pool.query('SELECT barcode, bezeichnung, gewicht_kg::float AS gewicht_kg, erfasst_am FROM salz_sorten ORDER BY bezeichnung');
      res.json({ sorten: r.rows });
    } catch (e) { fehler(res, e, 'sorten'); }
  });

  router.get('/sorten/:barcode', lesen, nurBuchende, async (req, res) => {
    const code = String(req.params.barcode || '').trim();
    if (!BARCODE_RE.test(code)) return res.status(400).json({ error: 'Ungültiger Barcode' });
    try {
      const r = await pool.query('SELECT barcode, bezeichnung, gewicht_kg::float AS gewicht_kg FROM salz_sorten WHERE barcode = $1', [code]);
      if (!r.rowCount) return res.status(404).json({ error: 'Unbekannter Barcode', unbekannt: true });
      res.json({ sorte: r.rows[0] });
    } catch (e) { fehler(res, e, 'sorte'); }
  });

  function sorteLesen(b) {
    const bezeichnung = String(b.bezeichnung || '').trim().replace(/\s+/g, ' ');
    const gewicht = Number(String(b.gewicht_kg ?? '').replace(',', '.'));
    if (bezeichnung.length < 2 || bezeichnung.length > 80) return { fehler: 'Bezeichnung fehlt (2–80 Zeichen)' };
    if (!Number.isFinite(gewicht) || gewicht <= 0 || gewicht > 100) return { fehler: 'Gewicht je Sack in kg (über 0, höchstens 100)' };
    return { bezeichnung, gewicht: Math.round(gewicht * 100) / 100 };
  }

  // Neue Sorte — Technik, Präsident und SALZ_GRUPPEN, nicht die Bewohner
  // (Entscheid 26.11.2026: Sorten bleiben bei der Technik). Ändern nur die Technik.
  router.post('/sorten', schreiben, async (req, res) => {
    if (!darfAlleLager(req.user)) {
      return res.status(403).json({ error: 'Diesen Sack kennt Rosenweg noch nicht. Bitte die Technik, ihn einmal zu erfassen.' });
    }
    const code = String(req.body?.barcode || '').trim();
    if (!BARCODE_RE.test(code)) return res.status(400).json({ error: 'Ungültiger Barcode' });
    const s = sorteLesen(req.body || {});
    if (s.fehler) return res.status(400).json({ error: s.fehler });
    try {
      const r = await pool.query(
        `INSERT INTO salz_sorten (barcode, bezeichnung, gewicht_kg, erfasst_von) VALUES ($1,$2,$3,$4)
         ON CONFLICT (barcode) DO NOTHING
         RETURNING barcode, bezeichnung, gewicht_kg::float AS gewicht_kg`,
        [code, s.bezeichnung, s.gewicht, req.user.email || null]);
      if (r.rowCount) return res.status(201).json({ sorte: r.rows[0] });
      // Schon da (zwei Geräte gleichzeitig, oder Wiederholung nach 502): die bestehende zurückgeben.
      const da = await pool.query('SELECT barcode, bezeichnung, gewicht_kg::float AS gewicht_kg FROM salz_sorten WHERE barcode = $1', [code]);
      res.json({ sorte: da.rows[0], schon_da: true });
    } catch (e) { fehler(res, e, 'sorte-post'); }
  });

  router.put('/sorten/:barcode', schreiben, nurVerwalter, async (req, res) => {
    const code = String(req.params.barcode || '').trim();
    const s = sorteLesen(req.body || {});
    if (s.fehler) return res.status(400).json({ error: s.fehler });
    try {
      // Das Gewicht gilt für künftige Buchungen; gebuchte behalten ihr kg_je_sack.
      const r = await pool.query(
        `UPDATE salz_sorten SET bezeichnung = $2, gewicht_kg = $3 WHERE barcode = $1
         RETURNING barcode, bezeichnung, gewicht_kg::float AS gewicht_kg`, [code, s.bezeichnung, s.gewicht]);
      if (!r.rowCount) return res.status(404).json({ error: 'Unbekannter Barcode' });
      res.json({ sorte: r.rows[0] });
    } catch (e) { fehler(res, e, 'sorte-put'); }
  });

  // ── Buchungen ──

  // Eine Buchung in einer Transaktion: Lager sperren (FOR UPDATE), damit zwei
  // gleichzeitige „Sack eingefüllt“ den Bestand nicht unter null drücken.
  async function buchen(user, { lagerId, art, saecke, barcode, notiz, clientId }) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_email', $1, true)`, [user.email || 'unbekannt']);
      if (clientId) {
        const da = await c.query('SELECT id FROM salz_buchungen WHERE client_id = $1', [clientId]);
        if (da.rowCount) { await c.query('ROLLBACK'); return { buchungId: da.rows[0].id, wiederholt: true }; }
      }
      const l = await c.query('SELECT id FROM salz_lager WHERE id = $1 AND aktiv FOR UPDATE', [lagerId]);
      if (!l.rowCount) throw Object.assign(new Error('Lager nicht gefunden'), { status: 404 });
      let kg = null;
      if (barcode) {
        const s = await c.query('SELECT gewicht_kg FROM salz_sorten WHERE barcode = $1', [barcode]);
        if (!s.rowCount) throw Object.assign(new Error('Unbekannter Barcode — bitte zuerst Sorte und Gewicht erfassen'), { status: 409, unbekannt: true });
        kg = Number(s.rows[0].gewicht_kg);
      } else {
        // Korrektur ohne Scan: Gewicht des zuletzt in diesem Lager gebuchten Sacks, sonst 25 kg.
        const z = await c.query(`SELECT kg_je_sack FROM salz_buchungen WHERE lager_id = $1 AND storniert_am IS NULL
                                  ORDER BY gebucht_am DESC LIMIT 1`, [lagerId]);
        kg = z.rowCount ? Number(z.rows[0].kg_je_sack) : 25;
      }
      const best = await c.query(`SELECT COALESCE(SUM(saecke), 0)::int AS n FROM salz_buchungen
                                   WHERE lager_id = $1 AND storniert_am IS NULL`, [lagerId]);
      const bestand = best.rows[0].n;
      if (bestand + saecke < 0) {
        throw Object.assign(new Error(bestand <= 0
          ? 'Laut Bestand ist in diesem Lager kein Sack mehr. Bitte zuerst die Anlieferung buchen.'
          : `Laut Bestand sind hier nur noch ${bestand} ${bestand === 1 ? 'Sack' : 'Säcke'}.`), { status: 409, bestand });
      }
      const r = await c.query(
        `INSERT INTO salz_buchungen (lager_id, art, saecke, barcode, kg_je_sack, notiz, client_id, gebucht_von)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [lagerId, art, saecke, barcode || null, kg, notiz || null, clientId || null, user.email || null]);
      await c.query('COMMIT');
      return { buchungId: r.rows[0].id, wiederholt: false };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      // Zwei gleichzeitige Wiederholungen derselben Buchung: die zweite scheitert am UNIQUE.
      if (e.code === '23505' && clientId) {
        const da = await pool.query('SELECT id FROM salz_buchungen WHERE client_id = $1', [clientId]);
        if (da.rowCount) return { buchungId: da.rows[0].id, wiederholt: true };
      }
      throw e;
    } finally {
      c.release();
    }
  }

  // POST /api/salz/buchungen { lager_id, art: anlieferung|eingefuellt, barcode, saecke?, client_id }
  // client_id (UUID aus der App) macht die Buchung wiederholbar: kommt eine
  // Anfrage nach 502 nochmals, wird nicht doppelt gebucht.
  router.post('/buchungen', schreiben, nurBuchende, async (req, res) => {
    const b = req.body || {};
    const lagerId = parseInt(b.lager_id, 10);
    const art = String(b.art || '');
    const barcode = String(b.barcode || '').trim();
    const clientId = b.client_id == null ? null : String(b.client_id);
    if (!Number.isInteger(lagerId)) return res.status(400).json({ error: 'Lager fehlt' });
    if (!['anlieferung', 'eingefuellt'].includes(art)) return res.status(400).json({ error: 'Art: anlieferung oder eingefuellt' });
    if (!BARCODE_RE.test(barcode)) return res.status(400).json({ error: 'Bitte den Barcode des Sacks scannen' });
    if (clientId !== null && !CLIENT_ID_RE.test(clientId)) return res.status(400).json({ error: 'Ungültige client_id' });
    let saecke = b.saecke == null ? 1 : Number(b.saecke);
    if (!Number.isInteger(saecke) || saecke < 1 || saecke > (art === 'anlieferung' ? 500 : 10)) {
      return res.status(400).json({ error: art === 'anlieferung' ? 'Anzahl Säcke: 1 bis 500' : 'Eingefüllt: 1 bis 10 Säcke' });
    }
    if (art === 'eingefuellt') saecke = -saecke;
    if (!fuerLager(lagerId, req, res)) return;
    try {
      const r = await buchen(req.user, { lagerId, art, saecke, barcode, clientId });
      if (!r.wiederholt) meldelaufBald(lagerId);
      res.status(r.wiederholt ? 200 : 201).json({ buchung_id: r.buchungId, wiederholt: r.wiederholt, lager: (await lagerUebersicht(lagerId))[0] });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.unbekannt ? { unbekannt: true } : {}), ...(e.bestand != null ? { bestand: e.bestand } : {}) });
      fehler(res, e, 'buchen');
    }
  });

  // Gezählt: Bestand auf den gezählten Wert setzen (Korrektur-Buchung mit der Differenz).
  router.post('/lager/:id/inventur', schreiben, nurVerwalter, async (req, res) => {
    const lagerId = parseInt(req.params.id, 10);
    const ist = Number(req.body?.saecke);
    const barcode = req.body?.barcode ? String(req.body.barcode).trim() : null;
    if (!Number.isInteger(ist) || ist < 0 || ist > 2000) return res.status(400).json({ error: 'Gezählte Säcke: ganze Zahl ab 0' });
    if (barcode && !BARCODE_RE.test(barcode)) return res.status(400).json({ error: 'Ungültiger Barcode' });
    try {
      const vorher = (await lagerUebersicht(lagerId))[0];
      if (!vorher) return res.status(404).json({ error: 'Lager nicht gefunden' });
      const diff = ist - vorher.bestand_saecke;
      if (diff === 0) return res.json({ lager: vorher, unveraendert: true });
      const notiz = String(req.body?.notiz || '').trim().slice(0, 200) || `Gezählt: ${ist}`;
      await buchen(req.user, { lagerId, art: 'korrektur', saecke: diff, barcode, notiz });
      meldelaufBald(lagerId);
      res.json({ lager: (await lagerUebersicht(lagerId))[0] });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      fehler(res, e, 'inventur');
    }
  });

  // Rückgängig: eigene Buchung innert 24 Stunden, die Technik jederzeit.
  router.delete('/buchungen/:id', schreiben, nurBuchende, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_email', $1, true)`, [req.user.email || 'unbekannt']);
      const r = await c.query('SELECT * FROM salz_buchungen WHERE id = $1', [id]);
      const b = r.rows[0];
      if (!b) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Buchung nicht gefunden' }); }
      if (b.storniert_am) { await c.query('ROLLBACK'); return res.json({ ok: true, schon: true }); }
      const eigene = String(b.gebucht_von || '').toLowerCase() === String(req.user.email || '').toLowerCase();
      const frisch = Date.now() - new Date(b.gebucht_am).getTime() < STORNO_EIGENE_STUNDEN * 3600 * 1000;
      if (!istVerwalter(req.user) && !(eigene && frisch && req.salzLager.has(b.lager_id))) {
        await c.query('ROLLBACK');
        return res.status(403).json({ error: 'Rückgängig machen geht nur bei eigenen Buchungen der letzten 24 Stunden.' });
      }
      await c.query('SELECT id FROM salz_lager WHERE id = $1 FOR UPDATE', [b.lager_id]);
      const best = await c.query(`SELECT COALESCE(SUM(saecke), 0)::int AS n FROM salz_buchungen
                                   WHERE lager_id = $1 AND storniert_am IS NULL`, [b.lager_id]);
      if (best.rows[0].n - b.saecke < 0) {
        await c.query('ROLLBACK');
        return res.status(409).json({ error: 'Dann wäre der Bestand unter null — die Säcke sind schon eingefüllt.' });
      }
      await c.query('UPDATE salz_buchungen SET storniert_am = NOW(), storniert_von = $2 WHERE id = $1', [id, req.user.email || null]);
      await c.query('COMMIT');
      meldelaufBald(b.lager_id);
      res.json({ ok: true, lager: (await lagerUebersicht(b.lager_id))[0] });
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      fehler(res, e, 'storno');
    } finally {
      c.release();
    }
  });

  return router;
}

module.exports = { salzRouter, ensureSchema, starteSalzCron, meldelauf, lagerUebersicht, erlaubteLager, darfAlleLager, istVerwalter, LAGER_START };
