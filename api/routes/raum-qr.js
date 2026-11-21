// ═══════════════════════════════════════════════════════════════════
// RAUM-QR: Tuerschilder und Aushaenge mit Token-QR-Codes
// ═══════════════════════════════════════════════════════════════════
// Raeume legt man auf tuerschilder.html selbst an (Tabelle raum_orte): Typ
// (heizung, waschkueche, lift, …) + Kurzname des Hauses (z. B. r9) + Standort.
// Je Raum und Thema gibt es einen Zufalls-Token (Tabelle raum_qr, Spalte raum =
// Slug <typ>-<kurz>). Nur wer den Code scannt, sieht die Raum-Infos auf
// /raum.html?t=<token>; ohne gueltigen Token zeigt die Seite nichts.
// Schluesselhalter: Authentik-Gruppe schluessel-<typ>-<kurz>.
// Die Druckvorlagen liegen hier im API-Image (api/vorlagen/aushaenge/) und
// werden nur angemeldeten Personen mit Reklamations-Rechten ausgegeben –
// das Repo ist oeffentlich, Tokens duerfen daher nie in Dateien stehen.
// Rechte wie bei den Melde-Orten (requirePermission('reklamationen', …)).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { pool } = require('../lib/db');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { SITE_URL } = require('../lib/config');
const { authentikAPI } = require('../lib/auth');

const router = express.Router();
const VORLAGEN_DIR = path.join(__dirname, '..', 'vorlagen', 'aushaenge');

// ─── Inhalte je Raumtyp ────────────────────────────────────────────────
// Bausteine: text (HTML, nur von uns geschrieben), liste, kontakt
// (technik|verwaltung|meg, Daten laedt die Seite aus den oeffentlichen
// APIs), notruf, defekt, link, schluessel (wird in /info zu 'personen'). Die Abschnitts-IDs sind die "themen", fuer
// die je ein Token erzeugt wird; sie entsprechen den {{QR:<thema>}} der Vorlagen.
const zugang = raum => ({ t: 'text', html: `<p>Der ${raum} ist abgeschlossen. Zutritt nur für Hauswart, berechtigte Bewohnerinnen und Bewohner sowie beauftragte Servicetechniker.</p><p>Schlüssel und Zutrittsberechtigungen vergibt der <strong>Technische Dienst</strong>. Bitte Schlüssel nicht weitergeben und die Tür nach dem Verlassen immer verschliessen.</p>` });
const unterlagen = was => ({ t: 'text', html: `<p>${was} sind aus Sicherheitsgründen nicht öffentlich. Berechtigte Fachpersonen erhalten sie beim <strong>Technischen Dienst</strong>.</p>` });
const kontakt = wer => ({ t: 'kontakt', wer });
// Schluesselhalter: Mitglieder der Authentik-Gruppe schluessel-<typ>-<kurz> (Name + Attribut telefon).
const schluessel = { t: 'schluessel' };

const TYPEN = {
  heizung: {
    titel: '🔥 Heizungs- und Technikraum', sub: '',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'zugang', titel: '🔑 Schlüssel & Zugang', bloecke: [zugang('Heizungs- und Technikraum'), schluessel] },
      { id: 'notfall', titel: '🚨 Notfall & Service', bloecke: [
        { t: 'text', html: '<p><strong>Heizungsausfall, Wasseraustritt oder Gasgeruch:</strong> bei Gefahr sofort die Feuerwehr, sonst den Technischen Dienst anrufen.</p>' },
        { t: 'notruf' }, kontakt('technik'), { t: 'defekt' }] },
    ],
  },
  waschkueche: {
    titel: '🧺 Waschküche', sub: '',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'regeln', titel: '📅 Regeln & Buchung', bloecke: [
        { t: 'liste', items: ['Mo–Sa: 07:00–22:00 Uhr', 'Sonntag und Feiertage: Ruhetag', 'Waschen nur mit Reservation',
          'Fenster geschlossen halten; zum Trocknen Trockner oder die fest verbauten Wäscheleinen nutzen',
          'Maschinen und Raum nach Gebrauch sauber hinterlassen'] },
        { t: 'link', href: 'https://stweg3.rosenweg4303.ch/#waschkueche', text: 'Waschküche reservieren' }] },
      { id: 'zugang', titel: '🔑 Schlüssel & Zugang', bloecke: [
        { t: 'text', html: '<p>Zugang und Schlüssel für die Waschküche erhalten Bewohnerinnen und Bewohner über den <strong>Technischen Dienst</strong>. Defekte an Maschinen bitte sofort melden.</p>' },
        schluessel, { t: 'defekt' }] },
    ],
  },
  lift: {
    titel: '🛗 Liftmaschinenraum', sub: '',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung'), schluessel] },
      { id: 'servicefirma', titel: '🔧 Liftfirma', bloecke: [
        { t: 'text', html: '<p>Wartung und Störungsbehebung der Lifte erfolgen durch <strong>Otis</strong>. Aufträge an Otis laufen über den <strong>Technischen Dienst</strong> bzw. die Verwaltung.</p>' },
        kontakt('technik')] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p><strong>Im Lift eingeschlossen?</strong> Ruhe bewahren und die <strong>Notruftaste im Lift</strong> drücken; sie ist direkt mit der Notrufzentrale von Otis verbunden. Bei Rauch oder Feuer: Feuerwehr 118.</p>' },
        { t: 'notruf' }] },
    ],
  },
  telekom: {
    titel: '📡 Telekommunikation', sub: '',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), schluessel] },
      { id: 'dokumentation', titel: '📄 Dokumentation', bloecke: [unterlagen('Netzwerkplan und Anlagendokumentation')] },
      { id: 'support', titel: '🛠 Störungen & Support', bloecke: [
        { t: 'text', html: '<p>Die Erschliessung der Gebäude (Glasfaser) stammt von der <strong>Swisscom</strong>.</p><p>Internet, TV oder Telefon gestört? Bitte zuerst den <strong>Technischen Dienst</strong> informieren; er klärt, ob die Hausanlage, die Swisscom-Erschliessung oder der eigene Anbieter zuständig ist.</p>' },
        kontakt('technik'), { t: 'defekt' }] },
    ],
  },
  hauptverteilung: {
    titel: '⚡ Hauptverteilung', sub: '',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung'), schluessel] },
      { id: 'schema', titel: '📐 Schaltschema', bloecke: [unterlagen('Verteilplan und Schaltschema'),
        { t: 'text', html: '<p><strong>Arbeiten an der Anlage nur durch konzessionierte Elektrofachpersonen.</strong></p>' }] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p><strong>Lebensgefahr – Hochspannung.</strong> Bei Brand, Rauch oder Stromunfall sofort Notruf wählen; verunfallte Personen erst berühren, wenn der Strom abgeschaltet ist. Stromausfall im Haus: Technischen Dienst anrufen.</p>' },
        { t: 'notruf' }, kontakt('technik')] },
    ],
  },
  tiefgarage: {
    titel: '🚗 Tiefgarage', sub: '', org: 'MEG Rosenweg',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('meg'), kontakt('technik'), schluessel] },
      { id: 'hausordnung', titel: '📋 Hausordnung', bloecke: [
        { t: 'text', html: '<p>Brandsicherheit in Einstellhallen nach dem Merkblatt der BFB (Brandverhütungsstelle der kantonalen Gebäudeversicherungen).</p><p><strong>Je Abstellplatz erlaubt</strong></p>' },
        { t: 'liste', items: ['1 Schrank: 1 m³ nicht brennbar oder 0,5 m³ brennbar', '1 Satz Reifen', 'Sperrige Gegenstände wie Sportgeräte, Dachboxen, Leitern'] },
        { t: 'text', html: '<p><strong>Verboten</strong></p>' },
        { t: 'liste', items: ['Brenn- und Treibstoffe (Kanister, Gasflaschen)', 'Hausrat, Möbel, Altpapier, Karton', 'Werkstattbetrieb'] },
        { t: 'text', html: '<p><strong>Sicherheit</strong></p>' },
        { t: 'liste', items: ['Alle Notausgänge frei halten', 'Löscheinrichtungen zugänglich und einsatzbereit halten', 'Bei Brand: Halle verlassen, Feuerwehr 118'] },
        { t: 'link', href: 'https://cms.vkg.ch/media/m45fk21t/bfb-merkblatt-einstellhallen.pdf', text: 'Merkblatt Brandsicherheit (BFB, PDF)' }] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p>Bei Feuer oder Rauch: Tiefgarage verlassen und Feuerwehr 118 alarmieren.</p>' },
        { t: 'notruf' }] },
    ],
  },
};

// Druckvorlagen je Typ. {{QR:<thema>}} wird ersetzt, {{ORT}} durch den Standort des Raums.
const VORLAGEN = {
  'heizung-technikraum': { typ: 'heizung', titel: 'Türschild', art: 'Türschild' },
  'waschkueche': { typ: 'waschkueche', titel: 'Türschild', art: 'Türschild' },
  'liftmaschinenraum': { typ: 'lift', titel: 'Türschild', art: 'Türschild' },
  'telekommunikation': { typ: 'telekom', titel: 'Türschild', art: 'Türschild' },
  'hauptverteilung': { typ: 'hauptverteilung', titel: 'Türschild', art: 'Türschild' },
  'tiefgarage': { typ: 'tiefgarage', titel: 'Türschild', art: 'Türschild' },
  'waschkueche-poster-a4': { typ: 'waschkueche', titel: 'Poster A4', art: 'Poster' },
  'waschkueche-kompakt': { typ: 'waschkueche', titel: 'Poster kompakt', art: 'Poster' },
  'waschkueche-poster': { typ: 'waschkueche', titel: 'Poster Bildschirm', art: 'Poster' },
};

function genToken() {
  // 16 Zeichen aus 32 -> 80 Bit; ohne verwechselbare Zeichen wie bei den Melde-Orten.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

let tabelleBereit = null;
function tabelle() {
  if (!tabelleBereit) {
    tabelleBereit = pool.query(`
      CREATE TABLE IF NOT EXISTS raum_orte (
        id SERIAL PRIMARY KEY,
        typ VARCHAR(40) NOT NULL,
        kurz VARCHAR(16) NOT NULL,
        standort VARCHAR(200) NOT NULL,
        aktiv BOOLEAN NOT NULL DEFAULT true,
        erstellt_von VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raum_orte_slug ON raum_orte (typ, kurz) WHERE aktiv;
      CREATE TABLE IF NOT EXISTS raum_qr (
        id SERIAL PRIMARY KEY,
        token VARCHAR(32) UNIQUE NOT NULL,
        raum VARCHAR(80) NOT NULL,
        thema VARCHAR(40) NOT NULL,
        aktiv BOOLEAN NOT NULL DEFAULT true,
        erstellt_von VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deaktiviert_at TIMESTAMPTZ
      );
      ALTER TABLE raum_qr ALTER COLUMN raum TYPE VARCHAR(80);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raum_qr_aktiv ON raum_qr (raum, thema) WHERE aktiv;
      -- Bearbeitete Texte der Druckvorlagen: ebene 'typ' (Vorgabe fuer alle Raeume eines
      -- Typs, ziel = Typ) oder 'ort' (ein Raum, ziel = raum_orte.id). felder: {data-feld: Wert}.
      CREATE TABLE IF NOT EXISTS raum_inhalt (
        ebene VARCHAR(8) NOT NULL,
        ziel VARCHAR(40) NOT NULL,
        vorlage VARCHAR(60) NOT NULL,
        felder JSONB NOT NULL DEFAULT '{}',
        geaendert_von VARCHAR(255),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (ebene, ziel, vorlage)
      );
      -- Tokens aus der ersten Fassung (ein Raum je Typ, ohne Haus) nie gedruckt -> stilllegen.
      UPDATE raum_qr SET aktiv = false, deaktiviert_at = NOW() WHERE aktiv AND raum NOT LIKE '%-%';
    `).catch(e => { tabelleBereit = null; throw e; });
  }
  return tabelleBereit;
}

const slugVon = o => `${o.typ}-${o.kurz}`;
const gruppeVon = o => `schluessel-${slugVon(o)}`;

async function ortById(id) {
  await tabelle();
  const r = await pool.query('SELECT id, typ, kurz, standort, aktiv, created_at FROM raum_orte WHERE id = $1 AND aktiv', [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}

// Aktive Tokens eines Raums; fehlende werden angelegt.
async function tokensFuer(ort, wer) {
  const slug = slugVon(ort);
  const r = await pool.query('SELECT thema, token FROM raum_qr WHERE raum = $1 AND aktiv', [slug]);
  const map = Object.fromEntries(r.rows.map(x => [x.thema, x.token]));
  for (const teil of TYPEN[ort.typ].teile) {
    if (map[teil.id]) continue;
    const ins = await pool.query(
      `INSERT INTO raum_qr (token, raum, thema, erstellt_von) VALUES ($1,$2,$3,$4)
       ON CONFLICT (raum, thema) WHERE aktiv DO NOTHING RETURNING token`, [genToken(), slug, teil.id, wer || null]);
    map[teil.id] = ins.rows[0]?.token
      || (await pool.query('SELECT token FROM raum_qr WHERE raum=$1 AND thema=$2 AND aktiv', [slug, teil.id])).rows[0].token;
  }
  return map;
}

// Mitglieder einer Gruppe schluessel-… aus Authentik, 5 Minuten zwischengespeichert
// (wie /api/public/technik). Nur Name und Telefon; ohne Gruppe/Mitglieder: leere Liste.
const halterCache = { at: 0, data: null };
async function schluesselhalter(gruppe) {
  try {
    if (!halterCache.data || Date.now() - halterCache.at > 5 * 60 * 1000) {
      const [g, u] = await Promise.all([
        authentikAPI('GET', '/core/groups/?page_size=500'),
        authentikAPI('GET', '/core/users/?page_size=500&is_active=true'),
      ]);
      halterCache.data = { groups: g.results || [], users: u.results || [] };
      halterCache.at = Date.now();
    }
    const grp = halterCache.data.groups.find(x => x.name.toLowerCase() === gruppe);
    if (!grp) return [];
    return halterCache.data.users
      .filter(x => x.is_active && (x.groups_obj ? x.groups_obj.map(o => o.pk) : (x.groups || [])).includes(grp.pk))
      .map(x => ({ name: x.name, telefon: x.attributes?.telefon || null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  } catch (e) {
    console.error('[raum-qr-schluessel]', e.message);
    return [];
  }
}

// ─── Bearbeitbare Texte ─────────────────────────────────────────────
// Elemente mit data-feld in den Vorlagen. *-liste: Array von Zeilen (nur Text),
// sonst Text mit <strong>/<b>/<em>/<br> erlaubt. Alles andere wird entfernt.
function saeubereText(v) {
  return String(v ?? '').slice(0, 1000)
    .replace(/<(?!\/?(strong|b|em|br)\s*\/?>)[^>]*>/gi, '')
    .replace(/&(?!(amp|lt|gt|quot|nbsp|shy|#\d+);)/g, '&amp;')
    .trim();
}
function saeubereFelder(felder) {
  const out = {};
  for (const [k, v] of Object.entries(felder || {})) {
    if (!/^[a-z0-9-]{1,30}$/.test(k)) continue;
    if (k.endsWith('-liste')) {
      if (!Array.isArray(v)) continue;
      out[k] = v.map(x => String(x ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 200)).filter(Boolean).slice(0, 20);
    } else {
      out[k] = saeubereText(v);
    }
  }
  return out;
}
async function inhaltFuer(ort, vorlage) {
  const r = await pool.query(
    `SELECT ebene, felder FROM raum_inhalt WHERE vorlage = $1 AND ((ebene = 'typ' AND ziel = $2) OR (ebene = 'ort' AND ziel = $3))`,
    [vorlage, ort.typ, String(ort.id)]);
  const typ = r.rows.find(x => x.ebene === 'typ')?.felder || {};
  const eigen = r.rows.find(x => x.ebene === 'ort')?.felder || {};
  return { wirksam: { ...typ, ...eigen }, eigen: Object.keys(eigen) };
}

// Skript, das die gespeicherten Texte in die data-feld-Elemente setzt; im
// Bearbeiten-Modus zusaetzlich contenteditable + Leiste, die ueber
// window.opener (tuerschilder.html, angemeldet) speichert.
function inhaltSkript(felder, bearbeiten, info) {
  const json = JSON.stringify(felder).replace(/</g, '\\u003c');
  const meta = JSON.stringify(info).replace(/</g, '\\u003c');
  return `<script>(function(){
  var F=${json}, M=${meta};
  document.querySelectorAll('[data-feld]').forEach(function(el){
    var k=el.getAttribute('data-feld'); if(!(k in F)) return;
    if(/-liste$/.test(k)){ el.innerHTML=''; F[k].forEach(function(t){ var li=document.createElement('li'); li.textContent=t; el.appendChild(li); }); }
    else el.innerHTML=F[k];
  });
  if(!${bearbeiten ? 'true' : 'false'}) return;
  var st=document.createElement('style');
  st.textContent='[data-feld]{outline:1.5px dashed #c41e1e66;outline-offset:2px;cursor:text}[data-feld]:focus{outline:2px solid #c41e1e;background:#fff8}'
    +'#rw-leiste{position:fixed;top:0;left:0;right:0;z-index:99;background:#1f2937;color:#fff;font:13px Arial,sans-serif;padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}'
    +'#rw-leiste button{border:0;border-radius:6px;padding:6px 10px;font:600 13px Arial,sans-serif;cursor:pointer}'
    +'@media print{#rw-leiste{display:none}body{padding-top:0!important}[data-feld]{outline:none!important;background:none!important}}';
  document.head.appendChild(st);
  document.querySelectorAll('[data-feld]').forEach(function(el){ el.contentEditable='true'; });
  // Gemeinschaft wird gewaehlt, nicht getippt: Auswahl in der Leiste, Wappen wechselt mit.
  var kn=document.querySelector('[data-feld="kopf-name"]'), img=document.querySelector('.rw-kopf img'), ws=null;
  if(kn){ kn.contentEditable='false'; kn.style.cursor='pointer'; kn.title='Gemeinschaft oben in der Leiste wählen'; }
  var l=document.createElement('div'); l.id='rw-leiste';
  l.innerHTML='<span>✏️ Bearbeiten: '+M.raum+' – rot umrandete Texte anklicken; in Listen erzeugt Enter einen neuen Punkt.'+(M.eigen?' <b>(eigene Texte aktiv)</b>':'')+'</span>'
    +'<button id="rw-ort" style="background:#c41e1e;color:#fff">Für diesen Raum speichern</button>'
    +'<button id="rw-typ" style="background:#fff;color:#111">Als Vorgabe für alle '+M.typ+'</button>'
    +'<button id="rw-reset" style="background:#4b5563;color:#fff">Eigene Texte entfernen</button>'
    +'<button id="rw-druck" style="background:#4b5563;color:#fff">🖨 Drucken</button>';
  document.body.prepend(l);
  if(kn){
    var lab=document.createElement('label'); lab.textContent='Gemeinschaft: ';
    ws=document.createElement('select'); ws.style.cssText='font:13px Arial,sans-serif;padding:4px;border-radius:6px';
    var akt=kn.textContent.trim(), da=false;
    M.gemeinschaften.forEach(function(g){ var o=document.createElement('option'); o.value=g; o.textContent=g; if(g===akt){o.selected=true;da=true;} ws.appendChild(o); });
    if(!da){ var o=document.createElement('option'); o.value=akt; o.textContent=akt+' (bisher)'; o.selected=true; ws.insertBefore(o, ws.firstChild); }
    function wappen(){ if(img) img.src=M.logos[ws.value]||M.standardLogo; }
    ws.onchange=function(){ kn.textContent=ws.value; wappen(); };
    kn.addEventListener('click',function(){ ws.focus(); });
    lab.appendChild(ws); l.insertBefore(lab, l.children[1]);
  }
  // Leiste bricht je nach Breite um: Abstand oben an ihre Hoehe anpassen.
  function platz(){ document.body.style.paddingTop=l.offsetHeight+'px'; }
  platz(); window.addEventListener('resize', platz);
  function sammeln(){ var o={}; document.querySelectorAll('[data-feld]').forEach(function(el){ var k=el.getAttribute('data-feld');
    o[k]=/-liste$/.test(k)?Array.prototype.map.call(el.querySelectorAll('li'),function(li){return li.textContent.trim();}).filter(Boolean):el.innerHTML.trim(); }); return o; }
  function senden(ebene){ if(!window.opener||!window.opener.rwInhaltSpeichern){ alert('Bitte aus der Seite «Türschilder & Aushänge» heraus öffnen.'); return; }
    window.opener.rwInhaltSpeichern(M.id, M.vorlage, ebene, ebene==='weg'?null:sammeln()).then(function(ok){ if(ok) alert('Gespeichert.'); }); }
  document.getElementById('rw-ort').onclick=function(){ senden('ort'); };
  document.getElementById('rw-typ').onclick=function(){ if(confirm('Diese Texte als Vorgabe für alle Räume dieses Typs speichern? Dieser Raum übernimmt die Vorgabe; andere Räume mit eigenen Texten behalten ihre.')) senden('typ'); };
  document.getElementById('rw-reset').onclick=function(){ if(confirm('Eigene Texte dieses Raums entfernen? Danach gilt wieder die Vorgabe.')) senden('weg'); };
  document.getElementById('rw-druck').onclick=function(){ window.print(); };
})();</script>`;
}

// Auswahl fuer die Gemeinschaft im Schildkopf (kopf-name) und das passende Wappen.
// Aus site-config.json (im Image /app/site-config.json, im Repo im Wurzelverzeichnis):
//   «STWEG-Kooperation Rosenweg»            -> Rosenweg-Wappen
//   «STWEG <n> · Rosenweg <a/b/c>»          -> STWEG-Wappen logo-stweg<n>-rosenweg<a-b-c>.png
//   «STWEG <n> · Rosenweg <a>» (je Haus)    -> Hauswappen logo-stweg<n>-rosenweg<a>.png
//   «MEG Rosenweg»                          -> logo-meg-rosenweg.png
// Die Wappen liegen im Website-Docroot (erzeugt mit scripts/wappen/erzeuge.py).
const ROSENWEG_LOGO = 'https://www.rosenweg4303.ch/logo-rosenweg.png';
function gemeinschaften() {
  let stwegen = [];
  for (const p of [path.join(__dirname, '..', 'site-config.json'), path.join(__dirname, '..', '..', 'site-config.json')]) {
    try { stwegen = JSON.parse(fs.readFileSync(p, 'utf-8')).stwegen || []; break; } catch {}
  }
  const liste = ['STWEG-Kooperation Rosenweg'];
  const logos = {};
  for (const st of stwegen) {
    if (st.typ === 'Tiefgarage' || /^MEG/i.test(st.name)) continue;
    const m = String(st.adressen || '').match(/^Rosenweg\s+([\d/]+)$/);
    if (!m) { liste.push(st.name); continue; }
    const haeuser = m[1].split('/');
    const ganz = `${st.name} · Rosenweg ${haeuser.join('/')}`;
    liste.push(ganz);
    logos[ganz] = `logo-stweg${st.nr}-rosenweg${haeuser.join('-')}.png`;
    if (haeuser.length > 1) for (const h of haeuser) {
      const eins = `${st.name} · Rosenweg ${h}`;
      liste.push(eins);
      logos[eins] = `logo-stweg${st.nr}-rosenweg${h}.png`;
    }
  }
  liste.push('MEG Rosenweg');
  logos['MEG Rosenweg'] = 'logo-meg-rosenweg.png';
  return { liste, logos: Object.fromEntries(Object.entries(logos).map(([k, v]) => [k, `${SITE_URL}/${v}`])) };
}
const { liste: GEMEINSCHAFTEN, logos: WAPPEN } = gemeinschaften();
function logoFuer(kopfName) {
  const t = String(kopfName || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
  return WAPPEN[t] || null;
}

const qrUrl = token => `${SITE_URL}/raum.html?t=${token}`;
const ESC = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GET /api/raum-qr/info/:token — oeffentlich, aber nur mit gueltigem Token.
router.get('/info/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').toLowerCase();
    if (!/^[a-z0-9]{16}$/.test(token)) return res.status(404).json({ error: 'Ungültiger Code' });
    await tabelle();
    const r = await pool.query(
      `SELECT q.thema, o.typ, o.kurz, o.standort FROM raum_qr q
         JOIN raum_orte o ON o.aktiv AND q.raum = o.typ || '-' || o.kurz
        WHERE q.token = $1 AND q.aktiv`, [token]);
    const row = r.rows[0];
    if (!row || !TYPEN[row.typ]) return res.status(404).json({ error: 'Ungültiger Code' });
    const { titel, org, teile } = TYPEN[row.typ];
    const halter = await schluesselhalter(gruppeVon(row));
    const mitHaltern = teile.map(t => ({ ...t, bloecke: t.bloecke.map(bl => bl.t === 'schluessel' ? { t: 'personen', titel: '🔑 Schlüsselhalter', personen: halter } : bl) }));
    res.set('Cache-Control', 'no-store');
    res.json({ thema: row.thema, titel, sub: row.standort, org: org || null, teile: mitHaltern });
  } catch (e) { console.error('[raum-qr-info]', e); res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/raum-qr — Typen, angelegte Raeume und Vorlagen (ohne Tokens).
router.get('/', authMiddleware, requirePermission('reklamationen', 'read'), async (req, res) => {
  try {
    await tabelle();
    const r = await pool.query(`
      SELECT o.id, o.typ, o.kurz, o.standort, o.created_at,
             (SELECT MIN(q.created_at) FROM raum_qr q WHERE q.aktiv AND q.raum = o.typ || '-' || o.kurz) AS codes_seit
        FROM raum_orte o WHERE o.aktiv ORDER BY o.typ, o.standort`);
    res.json({
      typen: Object.entries(TYPEN).map(([k, v]) => ({ typ: k, titel: v.titel })),
      raeume: r.rows.map(o => ({ ...o, titel: TYPEN[o.typ]?.titel || o.typ, gruppe: gruppeVon(o) })),
      vorlagen: Object.entries(VORLAGEN).map(([k, v]) => ({ vorlage: k, ...v })),
    });
  } catch (e) { console.error('[raum-qr-list]', e); res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/raum-qr/orte {typ, kurz, standort} — Raum anlegen.
router.post('/orte', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const b = req.body || {};
    const typ = String(b.typ || '');
    const kurz = String(b.kurz || '').trim().toLowerCase();
    const standort = String(b.standort || '').trim().slice(0, 200);
    if (!TYPEN[typ]) return res.status(400).json({ error: 'Unbekannter Typ' });
    if (!/^[a-z0-9]{1,12}$/.test(kurz)) return res.status(400).json({ error: 'Kurzname: 1–12 Kleinbuchstaben/Ziffern, z. B. r9' });
    if (!standort) return res.status(400).json({ error: 'Standort erforderlich' });
    await tabelle();
    const ex = await pool.query('SELECT 1 FROM raum_orte WHERE typ=$1 AND kurz=$2 AND aktiv', [typ, kurz]);
    if (ex.rows.length) return res.status(409).json({ error: `Raum ${typ}-${kurz} gibt es schon` });
    const r = await pool.query('INSERT INTO raum_orte (typ, kurz, standort, erstellt_von) VALUES ($1,$2,$3,$4) RETURNING id',
      [typ, kurz, standort, req.user?.email || null]);
    res.json({ ok: true, id: r.rows[0].id, gruppe: gruppeVon({ typ, kurz }) });
  } catch (e) { console.error('[raum-qr-ort-neu]', e); res.status(500).json({ error: 'Fehler' }); }
});

// DELETE /api/raum-qr/orte/:id — Raum stilllegen, seine Codes werden ungueltig.
router.delete('/orte/:id', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const o = await ortById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Unbekannter Raum' });
    await pool.query('UPDATE raum_qr SET aktiv = false, deaktiviert_at = NOW() WHERE raum = $1 AND aktiv', [slugVon(o)]);
    await pool.query('UPDATE raum_orte SET aktiv = false WHERE id = $1', [o.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[raum-qr-ort-weg]', e); res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/raum-qr/orte/:id/erneuern — alte Tokens ungueltig (alte Ausdrucke gehen nicht mehr), neue anlegen.
router.post('/orte/:id/erneuern', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const o = await ortById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Unbekannter Raum' });
    await pool.query('UPDATE raum_qr SET aktiv = false, deaktiviert_at = NOW() WHERE raum = $1 AND aktiv', [slugVon(o)]);
    await tokensFuer(o, req.user?.email);
    res.json({ ok: true });
  } catch (e) { console.error('[raum-qr-erneuern]', e); res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/raum-qr/druck/:id/:vorlage — fertige Druckvorlage mit Token-QR (lokal erzeugt).
router.get('/druck/:id/:vorlage', authMiddleware, requirePermission('reklamationen', 'read'), async (req, res) => {
  try {
    const o = await ortById(req.params.id);
    const v = VORLAGEN[req.params.vorlage];
    if (!o || !v || v.typ !== o.typ) return res.status(404).json({ error: 'Unbekannter Raum oder Vorlage' });
    let html = fs.readFileSync(path.join(VORLAGEN_DIR, `${req.params.vorlage}.html`), 'utf-8');
    const tokens = await tokensFuer(o, req.user?.email);
    const qr = {};
    for (const [thema, token] of Object.entries(tokens)) qr[thema] = await QRCode.toDataURL(qrUrl(token), { width: 400, margin: 1, errorCorrectionLevel: 'M' });
    html = html.replace(/\{\{QR:([a-z]+)\}\}/g, (m, thema) => qr[thema] || '').replace(/\{\{ORT\}\}/g, ESC(o.standort));
    const inhalt = await inhaltFuer(o, req.params.vorlage);
    for (const k of Object.keys(inhalt.wirksam)) if (typeof inhalt.wirksam[k] === 'string') inhalt.wirksam[k] = inhalt.wirksam[k].replace(/\{\{ORT\}\}/g, ESC(o.standort));
    const kopfName = inhalt.wirksam['kopf-name'] ?? (html.match(/data-feld="kopf-name">([^<]*)</) || [])[1];
    const logo = logoFuer(kopfName);
    if (logo) html = html.replace(`<img src="${ROSENWEG_LOGO}" alt="Rosenweg">`, `<img src="${logo}" alt="Wappen">`);
    const bearbeiten = req.query.bearbeiten === '1';
    if (bearbeiten || Object.keys(inhalt.wirksam).length) {
      const skript = inhaltSkript(inhalt.wirksam, bearbeiten,
        { id: o.id, vorlage: req.params.vorlage, raum: `${TYPEN[o.typ].titel.replace(/^\S+\s/, '')} ${o.standort}`, typ: TYPEN[o.typ].titel.replace(/^\S+\s/, ''), eigen: inhalt.eigen.length > 0,
          gemeinschaften: GEMEINSCHAFTEN, logos: WAPPEN, standardLogo: ROSENWEG_LOGO });
      html = html.includes('</body>') ? html.replace('</body>', skript + '</body>') : html + skript;
    }
    // <base>, damit relative Pfade (Logo) auch im Druckfenster laden.
    html = html.replace('<head>', `<head><base href="${SITE_URL}/">`);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) { console.error('[raum-qr-druck]', e); res.status(500).json({ error: 'Fehler' }); }
});

// PUT /api/raum-qr/inhalt {ort_id, vorlage, ebene: 'ort'|'typ', felder} — Texte speichern.
// DELETE /api/raum-qr/inhalt {ort_id, vorlage} — eigene Texte des Raums entfernen.
router.put('/inhalt', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const b = req.body || {};
    const o = await ortById(b.ort_id);
    const v = VORLAGEN[b.vorlage];
    if (!o || !v || v.typ !== o.typ) return res.status(404).json({ error: 'Unbekannter Raum oder Vorlage' });
    if (!['ort', 'typ'].includes(b.ebene)) return res.status(400).json({ error: 'Ebene ort oder typ' });
    const felder = saeubereFelder(b.felder);
    if ('kopf-name' in felder && !GEMEINSCHAFTEN.includes(felder['kopf-name'].replace(/&amp;/g, '&'))) {
      return res.status(400).json({ error: 'Gemeinschaft bitte aus der Liste wählen' });
    }
    // Standort wieder als Platzhalter speichern, damit eine Vorgabe je Typ in jedem
    // Raum den eigenen Standort zeigt (wird beim Druck ersetzt).
    const ortHtml = ESC(o.standort);
    if (ortHtml) for (const k of Object.keys(felder)) if (typeof felder[k] === 'string') felder[k] = felder[k].split(ortHtml).join('{{ORT}}');
    const ziel = b.ebene === 'ort' ? String(o.id) : o.typ;
    await pool.query(
      `INSERT INTO raum_inhalt (ebene, ziel, vorlage, felder, geaendert_von, updated_at) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (ebene, ziel, vorlage) DO UPDATE SET felder = EXCLUDED.felder, geaendert_von = EXCLUDED.geaendert_von, updated_at = NOW()`,
      [b.ebene, ziel, b.vorlage, JSON.stringify(felder), req.user?.email || null]);
    if (b.ebene === 'typ') {
      // Wer als Vorgabe speichert, will das Ergebnis auch in diesem Raum sehen.
      await pool.query(`DELETE FROM raum_inhalt WHERE ebene = 'ort' AND ziel = $1 AND vorlage = $2`, [String(o.id), b.vorlage]);
    }
    res.json({ ok: true });
  } catch (e) { console.error('[raum-qr-inhalt]', e); res.status(500).json({ error: 'Fehler' }); }
});
router.delete('/inhalt', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const b = req.body || {};
    const o = await ortById(b.ort_id);
    if (!o || !VORLAGEN[b.vorlage]) return res.status(404).json({ error: 'Unbekannter Raum oder Vorlage' });
    await pool.query(`DELETE FROM raum_inhalt WHERE ebene = 'ort' AND ziel = $1 AND vorlage = $2`, [String(o.id), b.vorlage]);
    res.json({ ok: true });
  } catch (e) { console.error('[raum-qr-inhalt-weg]', e); res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
module.exports.TYPEN = TYPEN;
module.exports.VORLAGEN = VORLAGEN;
