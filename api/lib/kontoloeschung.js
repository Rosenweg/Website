// Konto-Löschung vollständig (Fund F2/F3, Klärung Personen, Entscheid Stefan 28.11.2026:
// "Vor dem Bau beheben").
//
// Ablauf (server.js):
//   1. Vormerkung (authentik_pending_deletions): 30 Tage Frist, Erinnerung am Tag 23
//      (7 Tage vorher). Konten mit weiteren Gruppen werden nicht automatisch gelöscht,
//      sondern stehen in der Liste „manuell zu prüfen“ (manuell_pruefen).
//   2. Löschen in Authentik -> lokalesKontoNachLoeschung (Sitzungen, Token, VPN) ->
//      Nachlauf je Bereich (konto_loeschung_nachlauf):
//        anlage   Telefonanlage CT 220, POST /api/pbx/person/loeschen, Schritte
//                 einzeln (dazu nextcloud_konto: das Nextcloud-Konto selbst)
//        mailbox  Mailcow-Mailboxen, die der Person zugeordnet sind (mailbox_requests)
//        karten   Rosenweg-Karten (NFC in UniFi Access) entziehen, Zusatzadressen
//                 (person_email_alias) entfernen
//      Ein fehlgeschlagener Schritt bleibt vorgemerkt und wird mit Backoff wiederholt;
//      jedes Ergebnis steht im admin_protokoll (Bereich 'loeschungen'). Ab
//      NACHLAUF_SICHTBAR_AB Fehlversuchen zeigt ihn die Löschungen-Seite.
//   3. Aufräumlauf (täglich): Personen-Stammdaten und archivierte Wohnungskontakte
//      3 Monate nach dem Auszug bzw. der Löschung löschen bzw. anonymisieren
//      (Muster der Anlage: Zeile bleibt, Name „gelöscht“, Rest leer).
//
// Rechte:
//   stoppen, verlängern   wer loeschungen:write hat (auch Ausschuss/Verwaltung, nur
//                         die eigene STWEG – die Sicht prüft server.js)
//   Eintrag entfernen     nur Technik
//   Sofort löschen        nur Technik und Präsident, nur mit frischer Konto-Anmeldung
//                         (nie mit Karte, QR, Anlage-Token oder persönlichem Token)
//
// Ohne Datenbank und ohne Netz prüfbar (api/test/konto-loeschung.test.js).
'use strict';

const { isTechnik, isPraesident } = require('./groups');
const { passwortWechselErlaubt } = require('./stufen');

const FRIST_TAGE = 30;
const ERINNERUNG_TAGE_VORHER = 7;          // Erinnerung am Tag 23
const AUFBEWAHRUNG_MONATE = 3;
const GELOESCHT = 'gelöscht';              // wie die Anlage (pbx/api/app.py GELOESCHT)

function zahlAusEnv(name, standard, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : standard;
}
// Nach so vielen Fehlversuchen erscheint ein Nachlauf auf der Löschungen-Seite.
const NACHLAUF_SICHTBAR_AB = zahlAusEnv('KONTO_NACHLAUF_SICHTBAR_AB', 3, 1, 50);
const BACKOFF_START_MS = 15 * 60 * 1000;   // 15 min, 30 min, 1 h, 2 h … höchstens 24 h
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** Wartezeit bis zum nächsten Versuch nach `versuche` Fehlversuchen (>= 1). */
function backoffMs(versuche) {
  const n = Math.max(1, Math.floor(Number(versuche) || 1));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(n - 1, 20));
}

// Schritte der Anlage (pbx/api/app.py PERSON_LOESCHEN_SCHRITTE). nextcloud_konto
// nur, wenn kein anderes Konto mit dieser E-Mail besteht (wird immer verlangt,
// weil der Nachlauf nur dann angelegt wird).
const ANLAGE_SCHRITTE = ['sitzungen', 'nextcloud', 'nextcloud_konto', 'sip', 'combox', 'nummern', 'daten', 'anrufe', 'protokoll'];
const BEREICHE = ['anlage', 'mailbox', 'karten'];
const BEREICH_TEXT = { anlage: 'Telefonanlage', mailbox: 'Mailbox', karten: 'Karten' };

const nummernSauber = (liste) => [...new Set((Array.isArray(liste) ? liste : [])
  .map(n => String(n || '').trim()).filter(n => /^\d{2,15}$/.test(n)))].sort();

/**
 * Antwort der Anlage auswerten. angefragt: Schritte dieses Versuchs.
 * Ein verlangter Schritt, den die Anlage nicht meldet (alte Fassung), gilt als offen.
 * -> { ok, offen, nummern, fehler }
 */
function anlageAuswerten(antwort, angefragt) {
  const st = antwort?.schritte || {};
  const offen = [];
  const fehler = [];
  for (const s of angefragt) {
    const e = st[s];
    if (e && e.ok === true) continue;
    offen.push(s);
    fehler.push(`${s}: ${e ? String(e.fehler || 'fehlgeschlagen').slice(0, 120) : 'von der Anlage nicht gemeldet'}`);
  }
  const nummern = nummernSauber([...(antwort?.nummern || []), ...(st.nummern?.nummern || [])]);
  return { ok: offen.length === 0, offen, nummern, fehler: fehler.join('; ') || null };
}

/**
 * Einen Nachlauf-Eintrag ausführen. row: { email, bereich, offen, kontext }.
 * deps: { anlage({email, schritte, nummern}) -> {ok, grund?, antwort?},
 *         mailbox(email) -> {geloescht:[...]}, karten(email) -> {entzogen:n, aliase:n} }
 * Wirft nicht. -> { ok, offen, kontext, fehler, ergebnis }
 */
async function nachlaufAusfuehren(row, deps) {
  const kontext = { ...(row.kontext || {}) };
  try {
    if (row.bereich === 'anlage') {
      const schritte = Array.isArray(row.offen) && row.offen.length ? row.offen.filter(s => ANLAGE_SCHRITTE.includes(s)) : [...ANLAGE_SCHRITTE];
      const r = await deps.anlage({ email: row.email, schritte, nummern: nummernSauber(kontext.nummern) });
      if (!r || !r.antwort) {
        return { ok: false, offen: schritte, kontext, fehler: `Anlage: ${r?.grund || 'keine Antwort'}`, ergebnis: null };
      }
      const a = anlageAuswerten(r.antwort, schritte);
      if (a.nummern.length) kontext.nummern = nummernSauber([...(kontext.nummern || []), ...a.nummern]);
      return { ok: a.ok, offen: a.offen, kontext, fehler: a.fehler, ergebnis: { erledigt: schritte.filter(s => !a.offen.includes(s)) } };
    }
    if (row.bereich === 'mailbox') {
      const r = await deps.mailbox(row.email);
      return { ok: true, offen: [], kontext, fehler: null, ergebnis: { mailboxen: (r?.geloescht || []).length } };
    }
    if (row.bereich === 'karten') {
      const r = await deps.karten(row.email);
      return { ok: true, offen: [], kontext, fehler: null, ergebnis: { karten: r?.entzogen || 0, aliase: r?.aliase || 0 } };
    }
    return { ok: false, offen: [], kontext, fehler: 'unbekannter Bereich', ergebnis: null };
  } catch (e) {
    return { ok: false, offen: row.offen || [], kontext, fehler: String(e?.message || e || 'Fehler').slice(0, 300), ergebnis: null };
  }
}

/** Neuer Zustand nach einem Versuch. -> Felder für das UPDATE */
function naechsterZustand(row, erg, jetztMs = Date.now()) {
  if (erg.ok) {
    return { offen: [], kontext: erg.kontext, versuche: row.versuche || 0, letzter_fehler: null,
      naechster_versuch: null, erledigt_at: new Date(jetztMs) };
  }
  const versuche = (row.versuche || 0) + 1;
  return { offen: erg.offen, kontext: erg.kontext, versuche, letzter_fehler: erg.fehler,
    naechster_versuch: new Date(jetztMs + backoffMs(versuche)), erledigt_at: null };
}

/** Text fürs admin_protokoll. */
function protokollText(row, erg, zustand) {
  const b = BEREICH_TEXT[row.bereich] || row.bereich;
  if (erg.ok) {
    const e = erg.ergebnis || {};
    const teile = row.bereich === 'anlage' ? (e.erledigt || []).join(', ')
      : row.bereich === 'mailbox' ? `${e.mailboxen || 0} Mailbox(en)`
        : row.bereich === 'karten' ? `${e.karten || 0} Karte(n), ${e.aliase || 0} Zusatzadresse(n)` : '';
    return { aktion: `nachlauf-${row.bereich}`, alt: zustand.versuche ? `${zustand.versuche} Fehlversuch(e)` : null,
      neu: `${b}: erledigt${teile ? ' (' + teile + ')' : ''}` };
  }
  return { aktion: `nachlauf-${row.bereich}`, alt: `Versuch ${zustand.versuche}`,
    neu: `${b}: fehlgeschlagen${zustand.versuche >= NACHLAUF_SICHTBAR_AB ? ' (auf der Seite sichtbar)' : ''}`,
    fehler: erg.fehler };
}

// ─── Rechte ────────────────────────────────────────────────────────────────
/** Eintrag entfernen: nur Technik (Entscheid E3b). */
function darfEntfernen(groups) {
  return isTechnik(groups || []);
}

/**
 * Sofort löschen (Recht auf Löschung, Entscheid E3c): nur Technik und Präsident und
 * nur mit frischer Konto-Anmeldung (Website-Sitzung oder App-Token, auth_time
 * höchstens STUFE_FRISCH_MIN alt). Nie mit Karte, QR, Anlage-Token, persönlichem
 * Zugangstoken, MCP oder einer per E-Mail bestätigten Karten-Aktion.
 * -> { ok, status, fehler, reauth? }
 */
function sofortLoeschenPruefen({ groups, auth, pat = false, kanal = '' }) {
  const g = groups || [];
  if (!isTechnik(g) && !isPraesident(g)) return { ok: false, status: 403, fehler: 'Sofort löschen dürfen nur Technik und Präsident' };
  if (pat || String(kanal || '').toLowerCase() === 'mcp') return { ok: false, status: 403, fehler: 'Sofort löschen nur mit der eigenen Anmeldung' };
  if (!passwortWechselErlaubt(auth)) {
    return { ok: false, status: 403, reauth: true, fehler: 'Bitte zur Bestätigung neu mit dem Konto anmelden (nicht mit der Karte).' };
  }
  return { ok: true };
}

/** Konten, die „Sofort löschen“ nie trifft (nur über Konten durch Technik). */
function sofortGeschuetzt(authentikUser) {
  if (!authentikUser) return false;
  if (authentikUser.is_superuser) return true;
  const namen = (authentikUser.groups_obj || []).map(x => String(x?.name || ''));
  return isTechnik(namen) || isPraesident(namen);
}

// ─── Datenbank ─────────────────────────────────────────────────────────────
const SQL_TABELLEN = `
  ALTER TABLE authentik_pending_deletions ADD COLUMN IF NOT EXISTS manuell_pruefen BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE authentik_pending_deletions ADD COLUMN IF NOT EXISTS grund TEXT;
  CREATE TABLE IF NOT EXISTS konto_loeschung_nachlauf (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    bereich VARCHAR(20) NOT NULL,
    name TEXT,
    stweg INTEGER,
    offen JSONB NOT NULL DEFAULT '[]'::jsonb,
    kontext JSONB NOT NULL DEFAULT '{}'::jsonb,
    versuche INTEGER NOT NULL DEFAULT 0,
    naechster_versuch TIMESTAMPTZ DEFAULT NOW(),
    letzter_fehler TEXT,
    erstellt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erledigt_at TIMESTAMPTZ,
    anonymisiert_at TIMESTAMPTZ,
    UNIQUE (email, bereich)
  );
  CREATE INDEX IF NOT EXISTS idx_konto_nachlauf_faellig ON konto_loeschung_nachlauf (naechster_versuch) WHERE erledigt_at IS NULL;`;

// Nachlauf anlegen; besteht er schon (zweite Löschung derselben Adresse), alles neu.
const SQL_NACHLAUF_ANLEGEN = `
  INSERT INTO konto_loeschung_nachlauf (email, bereich, name, stweg, offen, kontext, versuche, naechster_versuch, letzter_fehler, erstellt_at, erledigt_at, anonymisiert_at)
  VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, 0, NOW(), NULL, NOW(), NULL, NULL)
  ON CONFLICT (email, bereich) DO UPDATE SET name = EXCLUDED.name, stweg = EXCLUDED.stweg, offen = EXCLUDED.offen,
    kontext = '{}'::jsonb, versuche = 0, naechster_versuch = NOW(), letzter_fehler = NULL, erstellt_at = NOW(),
    erledigt_at = NULL, anonymisiert_at = NULL
  RETURNING *`;

// Anker „Auszug bzw. Löschung“ einer Person: das späteste Archivdatum ihrer Kontakte
// (über person_id oder E-Mail) bzw. der Konto-Löschung. Nur Personen, die
//   - keinen aktiven Wohnungskontakt mehr haben,
//   - kein aktives lokales Konto und keine offene Lösch-Vormerkung haben,
//   - einen Anker haben (nie verknüpfte, frisch angelegte Personen bleiben),
//   - deren Anker AUFBEWAHRUNG_MONATE zurückliegt.
// $1 = Monate
const SQL_PERSONEN_FAELLIG = `
  WITH p AS (
    SELECT pe.id, LOWER(TRIM(COALESCE(pe.email, ''))) AS email,
           (SELECT ARRAY(SELECT LOWER(TRIM(x)) FROM jsonb_array_elements_text(COALESCE(pe.emails, '[]'::jsonb)) x)) AS weitere
      FROM personen pe
     WHERE pe.name IS DISTINCT FROM '${GELOESCHT}' AND pe.name NOT LIKE '${GELOESCHT} #%'
  ), a AS (
    SELECT p.id, p.email,
           GREATEST(
             (SELECT MAX(k.archiviert_am)::timestamptz FROM wohnungen_kontakte k
               WHERE k.archiviert_am IS NOT NULL AND (k.person_id = p.id OR (p.email <> '' AND LOWER(TRIM(k.email)) = p.email))),
             (SELECT MAX(n.erstellt_at) FROM konto_loeschung_nachlauf n WHERE p.email <> '' AND n.email = p.email)
           ) AS anker
      FROM p
     WHERE NOT EXISTS (SELECT 1 FROM wohnungen_kontakte k WHERE k.archiviert_am IS NULL
                         AND (k.person_id = p.id OR (p.email <> '' AND LOWER(TRIM(k.email)) = p.email)
                              OR LOWER(TRIM(k.email)) = ANY(p.weitere)))
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.active AND u.email IS NOT NULL
                         AND (LOWER(u.email) = p.email OR LOWER(u.email) = ANY(p.weitere)))
       AND NOT EXISTS (SELECT 1 FROM authentik_pending_deletions d WHERE NOT d.cancelled
                         AND (LOWER(d.email) = p.email OR LOWER(d.email) = ANY(p.weitere)))
  )
  SELECT id, email FROM a WHERE anker IS NOT NULL AND anker <= NOW() - make_interval(months => $1::int)
  ORDER BY id LIMIT 500`;

// Archivierte Kontakte 3 Monate nach dem Auszug anonymisieren (Zeile bleibt für die
// Geschichte der Wohnung: Rolle, gültig ab, archiviert am). Nur wenn die Adresse
// nirgends mehr aktiv ist und kein aktives Konto mehr hat (wer im Haus umzieht, bleibt).
// $1 = Monate
const SQL_KONTAKTE_ANONYMISIEREN = `
  UPDATE wohnungen_kontakte k
     SET name = '${GELOESCHT}', email = NULL, telefon = NULL, mobile = NULL, adresse = NULL, person_id = NULL
   WHERE k.archiviert_am IS NOT NULL
     AND k.archiviert_am <= (CURRENT_DATE - make_interval(months => $1::int))
     AND (k.name IS DISTINCT FROM '${GELOESCHT}' OR k.email IS NOT NULL OR k.telefon IS NOT NULL
          OR k.mobile IS NOT NULL OR k.adresse IS NOT NULL OR k.person_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM wohnungen_kontakte a WHERE a.archiviert_am IS NULL
                       AND ((k.person_id IS NOT NULL AND a.person_id = k.person_id)
                            OR (k.email IS NOT NULL AND LOWER(TRIM(a.email)) = LOWER(TRIM(k.email)))))
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.active AND k.email IS NOT NULL AND LOWER(u.email) = LOWER(TRIM(k.email)))
     AND NOT EXISTS (SELECT 1 FROM authentik_pending_deletions d WHERE NOT d.cancelled AND k.email IS NOT NULL
                       AND LOWER(d.email) = LOWER(TRIM(k.email)))
  RETURNING k.id`;

// Erledigte Nachläufe enthalten die E-Mail der gelöschten Person: nach der Frist
// ebenfalls anonymisieren (nur das Ergebnis bleibt). $1 = Monate
const SQL_NACHLAUF_ANONYMISIEREN = `
  UPDATE konto_loeschung_nachlauf
     SET email = '${GELOESCHT} #' || id, name = NULL, kontext = '{}'::jsonb, anonymisiert_at = NOW()
   WHERE erledigt_at IS NOT NULL AND anonymisiert_at IS NULL
     AND erledigt_at <= NOW() - make_interval(months => $1::int)
  RETURNING id`;

/** Tabellen, die auf personen(id) zeigen (ON DELETE SET NULL). */
const SQL_PERSONEN_VERWEISE = `
  SELECT c.conrelid::regclass::text AS tabelle, a.attname AS spalte
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
   WHERE c.contype = 'f' AND c.confrelid = 'personen'::regclass AND c.conrelid <> 'wohnungen_kontakte'::regclass`;

const bereitJe = new WeakMap();
/** Spalten und Tabelle einmal je Pool anlegen (wie lib/admin-protokoll.js). */
function bereit(pool) {
  if (!bereitJe.has(pool)) {
    bereitJe.set(pool, pool.query(SQL_TABELLEN).catch((e) => { bereitJe.delete(pool); throw e; }));
  }
  return bereitJe.get(pool);
}

const bezeichnerGueltig = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(String(s || ''));

/**
 * Aufräumlauf (Punkt 3). Personen ohne Verweise werden gelöscht; wird eine Person
 * noch von einem anderen Bereich verwendet (WhatsApp, Vollmachten, Reklamationen,
 * Rufgruppen …), wird sie anonymisiert, damit dessen eigener Ablauf sie später noch
 * findet. -> { personen_geloescht, personen_anonymisiert, kontakte, nachlauf }
 */
async function aufraeumen(pool, { monate = AUFBEWAHRUNG_MONATE } = {}) {
  await bereit(pool);
  const raus = { personen_geloescht: 0, personen_anonymisiert: 0, kontakte: 0, nachlauf: 0 };
  const verweise = (await pool.query(SQL_PERSONEN_VERWEISE)).rows
    .filter(v => bezeichnerGueltig(v.tabelle) && bezeichnerGueltig(v.spalte));
  const faellig = (await pool.query(SQL_PERSONEN_FAELLIG, [monate])).rows;
  for (const p of faellig) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Trigger zwischen personen und wohnungen_kontakte nicht auslösen (nur diese Transaktion)
      await client.query("SELECT set_config('rosenweg.person_sync', 'on', true)");
      let verwendet = false;
      for (const v of verweise) {
        const r = await client.query(`SELECT 1 FROM ${v.tabelle} WHERE ${v.spalte} = $1 LIMIT 1`, [p.id]);
        if (r.rows.length) { verwendet = true; break; }
      }
      await client.query('UPDATE wohnungen_kontakte SET person_id = NULL WHERE person_id = $1 AND archiviert_am IS NOT NULL', [p.id]);
      if (verwendet) {
        await client.query(
          `UPDATE personen SET name = $2, vorname = NULL, nachname = NULL, email = NULL, telefon = NULL, mobile = NULL,
                  adresse = NULL, geburtsdatum = NULL, anrede = NULL, notiz = NULL, telefone = '[]'::jsonb,
                  emails = '[]'::jsonb, whatsapp_opt_in = false, whatsapp_letzte_aktivitaet = NULL,
                  review_needed = false, updated_at = NOW()
            WHERE id = $1`, [p.id, `${GELOESCHT} #${p.id}`]);
        raus.personen_anonymisiert++;
      } else {
        await client.query('DELETE FROM personen WHERE id = $1', [p.id]);
        raus.personen_geloescht++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[Aufraeumen] Person #${p.id}: ${e.message}`);
    } finally { client.release(); }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('rosenweg.person_sync', 'on', true)");
    raus.kontakte = (await client.query(SQL_KONTAKTE_ANONYMISIEREN, [monate])).rowCount;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Aufraeumen] Kontakte:', e.message);
  } finally { client.release(); }
  raus.nachlauf = (await pool.query(SQL_NACHLAUF_ANONYMISIEREN, [monate])).rowCount;
  return raus;
}

module.exports = {
  FRIST_TAGE, ERINNERUNG_TAGE_VORHER, AUFBEWAHRUNG_MONATE, GELOESCHT, NACHLAUF_SICHTBAR_AB,
  ANLAGE_SCHRITTE, BEREICHE, BEREICH_TEXT,
  backoffMs, anlageAuswerten, nachlaufAusfuehren, naechsterZustand, protokollText,
  darfEntfernen, sofortLoeschenPruefen, sofortGeschuetzt, nummernSauber, aufraeumen, bereit,
  SQL_TABELLEN, SQL_NACHLAUF_ANLEGEN, SQL_PERSONEN_FAELLIG, SQL_KONTAKTE_ANONYMISIEREN,
  SQL_NACHLAUF_ANONYMISIEREN, SQL_PERSONEN_VERWEISE,
};
