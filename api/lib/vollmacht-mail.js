// E-Mails zu Vollmachten (Entscheid Stefan 28.11.2026: ja, mit eigenem Absender
// vollmachten@, Gateway-User „vollmachten“ in lib/mailgateway.js).
// Rein funktional – Datenbank, Versand und Zeitplan bleiben in server.js.
//
//   vollmacht-bevollmaechtigt  an die bevollmaechtigte Person („Du wurdest bevollmächtigt“)
//   vollmacht-miteigentuemer   an die Miteigentuemer der Wohnung („Neue Vollmacht für deine Wohnung“)
//   vollmacht-eingegangen      an die Verwaltung der STWEG („Vollmacht eingegangen“)
//   vollmacht-ablauf           an Bevollmaechtigte und Geber, ABLAUF_VORLAUF_TAGE vorher
//
// Abmelden: Personen (Bevollmaechtigte, Miteigentuemer, Geber) schalten die
// Vollmachten-Mails mit einem Link in jeder Mail ab (Tabelle vollmachten_mail_aus,
// wieder einschaltbar). Die Verwaltung ist eine Firma: ihre Mail schaltet die
// Technik im Vorlagen-Editor ab (Vorlage deaktivieren).
const { GEBER_ROLLEN } = require('./vollmacht-rechte');

const ABLAUF_VORLAUF_TAGE = 7;

const klein = (s) => String(s || '').trim().toLowerCase();
const ISO = /^\d{4}-\d{2}-\d{2}/;

function datumText(d) {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
  if (!ISO.test(s)) return s;
  const [j, m, t] = s.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}

const ART_TEXT = { generell: 'allgemeine Vollmacht', spezifisch: 'Vollmacht für ein Geschäft', auskunft: 'Vollmacht für Auskünfte' };

// Ende der Vollmacht als Text; ohne Datum gilt sie bis zum Widerruf.
const gueltigBisText = (v) => (v && v.gueltig_bis ? datumText(v.gueltig_bis) : 'bis auf Widerruf');

const FUSS_PERSON =
  '\n\nDiese Nachricht kommt automatisch von Rosenweg. '
  + 'Mails zu Vollmachten abstellen: {{abmelden_url}}';
const FUSS_VERWALTUNG =
  '\n\nDiese Nachricht kommt automatisch von Rosenweg (Vollmachten).';

// Vorlagen fuer den Vorlagen-Editor (MAIL_TEMPLATE_DEFAULTS in server.js).
const VORLAGEN = [
  {
    source_type: 'vollmacht-bevollmaechtigt', empfaenger_kategorie: null,
    subject_template: 'Du wurdest bevollmächtigt: {{vollmachtgeber}}',
    body_template:
      'Hallo {{empfaenger_name}},\n\n'
      + '{{vollmachtgeber}} hat dich bevollmächtigt ({{art_text}}).\n\n'
      + '{{#if wohnung}}Wohnung: {{wohnung}}\n{{/if}}'
      + '{{#if geltungsbereich}}Gilt für: {{geltungsbereich}}\n{{/if}}'
      + '{{#if versammlung}}Versammlung: {{versammlung}}\n{{/if}}'
      + 'Gültig: ab {{gueltig_ab}}, {{gueltig_bis}}\n\n'
      + 'Die Vollmacht ansehen: {{url}}'
      + FUSS_PERSON,
    notiz: 'An die bevollmächtigte Person, sobald die Vollmacht aktiv ist (alle Geber haben unterschrieben). '
      + 'Absender vollmachten@. Variablen: empfaenger_name, vollmachtgeber, art_text, wohnung, geltungsbereich, '
      + 'versammlung, gueltig_ab, gueltig_bis (Text, z. B. „bis auf Widerruf“), url, abmelden_url',
  },
  {
    source_type: 'vollmacht-miteigentuemer', empfaenger_kategorie: null,
    subject_template: 'Neue Vollmacht für deine Wohnung{{#if wohnung}} ({{wohnung}}){{/if}}',
    body_template:
      'Hallo {{empfaenger_name}},\n\n'
      + 'für {{#if wohnung}}die Wohnung {{wohnung}}{{/if}}{{#if kein_wohnung}}deine Wohnung{{/if}} ist eine neue Vollmacht aktiv:\n\n'
      + 'Erteilt von: {{vollmachtgeber}}\n'
      + 'Bevollmächtigt: {{bevollmaechtigter}}\n'
      + 'Art: {{art_text}}\n'
      + '{{#if geltungsbereich}}Gilt für: {{geltungsbereich}}\n{{/if}}'
      + 'Gültig: ab {{gueltig_ab}}, {{gueltig_bis}}\n\n'
      + 'Alle Vollmachten ansehen (und widerrufen, wenn du dazu berechtigt bist): {{url}}'
      + FUSS_PERSON,
    notiz: 'An die übrigen Eigentümer der Wohnung (nicht an die Geber und nicht an die bevollmächtigte Person), '
      + 'sobald die Vollmacht aktiv ist. Absender vollmachten@. Variablen: empfaenger_name, vollmachtgeber, bevollmaechtigter, '
      + 'art_text, wohnung, geltungsbereich, gueltig_ab, gueltig_bis, url, abmelden_url',
  },
  {
    source_type: 'vollmacht-eingegangen', empfaenger_kategorie: null,
    subject_template: 'Vollmacht eingegangen: {{vollmachtgeber}} an {{bevollmaechtigter}} ({{stweg_label}})',
    body_template:
      'Guten Tag\n\n'
      + 'für {{stweg_label}} ist eine Vollmacht aktiv geworden.\n\n'
      + 'Erteilt von: {{vollmachtgeber}}\n'
      + 'Bevollmächtigt: {{bevollmaechtigter}}\n'
      + 'Art: {{art_text}}\n'
      + '{{#if wohnung}}Wohnung: {{wohnung}}\n{{/if}}'
      + '{{#if versammlung}}Versammlung: {{versammlung}}\n{{/if}}'
      + 'Kennzeichen: {{doc_hash}}\n'
      + 'Gültig: ab {{gueltig_ab}}, {{gueltig_bis}}\n\n'
      + 'Zur Vollmacht: {{url}}'
      + FUSS_VERWALTUNG,
    notiz: 'An die Verwaltung der STWEG (E-Mail der Verwaltungsfirma, sonst Ausschuss + Technik), sobald eine Vollmacht aktiv ist. '
      + 'Zum Abstellen die Vorlage deaktivieren. Absender vollmachten@. Variablen: stweg_label, vollmachtgeber, bevollmaechtigter, '
      + 'art_text, wohnung, versammlung, doc_hash, gueltig_ab, gueltig_bis, url',
  },
  {
    source_type: 'vollmacht-ablauf', empfaenger_kategorie: null,
    subject_template: 'Vollmacht läuft ab am {{gueltig_bis_datum}}: {{vollmachtgeber}} an {{bevollmaechtigter}}',
    body_template:
      'Hallo {{empfaenger_name}},\n\n'
      + 'die Vollmacht von {{vollmachtgeber}} an {{bevollmaechtigter}} ({{art_text}}) läuft in {{tage}} {{tage_wort}} '
      + 'am {{gueltig_bis_datum}} ab.\n\n'
      + 'Soll sie weiter gelten, erteilt {{vollmachtgeber}} eine neue Vollmacht: {{url}}'
      + FUSS_PERSON,
    notiz: 'An die bevollmächtigte Person und die Geber, ' + ABLAUF_VORLAUF_TAGE + ' Tage vor dem Ablauf (einmal je Ablaufdatum). '
      + 'Absender vollmachten@. Variablen: empfaenger_name, vollmachtgeber, bevollmaechtigter, art_text, tage, '
      + 'tage_wort („Tag“/„Tagen“), gueltig_bis_datum, url, abmelden_url',
  },
];

function namenListe(namen) {
  const n = namen.filter(Boolean);
  if (n.length <= 1) return n.join('');
  return n.slice(0, -1).join(', ') + ' und ' + n[n.length - 1];
}

/**
 * Gemeinsamer Kontext der Vorlagen.
 * v: Zeile aus vollmachten (+ vollmachtgeber_liste, wohnung_bezeichnung, versammlung_titel)
 */
function kontext(v, { siteUrl = '', empfaengerName = '', abmeldenUrl = '', heute = null } = {}) {
  const geber = Array.isArray(v.vollmachtgeber_liste) && v.vollmachtgeber_liste.length
    ? v.vollmachtgeber_liste.map((g) => g && g.name)
    : [v.vollmachtgeber_name];
  const bis = v.gueltig_bis ? String(v.gueltig_bis instanceof Date ? v.gueltig_bis.toISOString() : v.gueltig_bis).slice(0, 10) : null;
  const tage = bis && heute ? tageBis(bis, heute) : null;
  const wohnung = v.wohnung_bezeichnung || '';
  return {
    empfaenger_name: empfaengerName || '',
    vollmachtgeber: namenListe(geber),
    bevollmaechtigter: v.bevollmaechtigter_name || '',
    art_text: ART_TEXT[v.art] || 'Vollmacht',
    wohnung,
    kein_wohnung: !wohnung,
    geltungsbereich: v.geltungsbereich ? String(v.geltungsbereich).slice(0, 500) : '',
    versammlung: v.versammlung_titel || '',
    gueltig_ab: datumText(v.gueltig_ab),
    gueltig_bis: gueltigBisText(v),
    gueltig_bis_datum: datumText(bis),
    stweg_label: v.stweg ? `STWEG ${v.stweg}` : 'der Siedlung',
    doc_hash: v.doc_hash || '',
    tage: tage === null ? '' : tage,
    tage_wort: tage === 1 ? 'Tag' : 'Tagen',
    url: `${siteUrl}/vollmachten.html`,
    abmelden_url: abmeldenUrl || `${siteUrl}/vollmachten.html`,
  };
}

/** Ganze Tage von heute (ISO oder Date) bis zum Datum (ISO). Negativ = vorbei. */
function tageBis(isoDatum, heute) {
  const h = heute instanceof Date ? heute.toISOString().slice(0, 10) : String(heute).slice(0, 10);
  return Math.round((Date.parse(String(isoDatum).slice(0, 10) + 'T00:00:00Z') - Date.parse(h + 'T00:00:00Z')) / 86400000);
}

/**
 * Empfaenger bei einer neu aktiven Vollmacht.
 *   v:       Vollmacht (bevollmaechtigter_email/-name, vollmachtgeber_liste, vollmachtgeber_email)
 *   kontakte: Kontakte der Wohnung [{ email, name, rolle }] (nur aktive)
 *   bevollmaechtigterEmail: E-Mail der bevollmaechtigten Person (Zeile oder Personenstamm)
 *   aus:     Set kleingeschriebener Adressen, die abgemeldet sind
 * -> { bevollmaechtigt: [{email,name}], miteigentuemer: [{email,name}] }
 * Jede Adresse bekommt hoechstens eine Mail: Geber und Bevollmaechtigte sind keine
 * „Miteigentuemer“ (sie wissen es), und wer abgemeldet ist, bekommt nichts.
 */
function empfaengerAktiv(v, { kontakte = [], bevollmaechtigterEmail = null, aus = new Set() } = {}) {
  const bev = klein(bevollmaechtigterEmail || v.bevollmaechtigter_email);
  const geber = new Set([klein(v.vollmachtgeber_email), ...(Array.isArray(v.vollmachtgeber_liste) ? v.vollmachtgeber_liste : []).map((g) => klein(g && g.email))].filter(Boolean));
  const abgemeldet = (e) => aus instanceof Set ? aus.has(e) : false;
  const bevollmaechtigt = bev && !abgemeldet(bev) ? [{ email: bev, name: v.bevollmaechtigter_name || '' }] : [];
  const gesehen = new Set([bev, ...geber]);
  const miteigentuemer = [];
  for (const k of kontakte) {
    const e = klein(k && k.email);
    if (!e || gesehen.has(e)) continue;
    if (!GEBER_ROLLEN.includes(klein(k.rolle))) continue; // nur Eigentuemer (und Wohnungs-Verwalter), keine Mieter
    gesehen.add(e);
    if (!abgemeldet(e)) miteigentuemer.push({ email: e, name: k.name || '' });
  }
  return { bevollmaechtigt, miteigentuemer };
}

/**
 * Welche aktiven Vollmachten brauchen heute die Ablauf-Mail?
 * Innerhalb von ABLAUF_VORLAUF_TAGE (0 = heute noch gueltig) und noch nicht fuer dieses
 * Ablaufdatum gemeldet (ablauf_gemeldet_fuer ist das Datum, fuer das gemeldet wurde).
 */
function ablaufFaellig(rows, heute, vorlauf = ABLAUF_VORLAUF_TAGE) {
  return (rows || []).filter((v) => {
    if (!v || v.status !== 'aktiv' || !v.gueltig_bis) return false;
    const bis = String(v.gueltig_bis instanceof Date ? v.gueltig_bis.toISOString() : v.gueltig_bis).slice(0, 10);
    const t = tageBis(bis, heute);
    if (t < 0 || t > vorlauf) return false;
    const gem = v.ablauf_gemeldet_fuer ? String(v.ablauf_gemeldet_fuer instanceof Date ? v.ablauf_gemeldet_fuer.toISOString() : v.ablauf_gemeldet_fuer).slice(0, 10) : null;
    return gem !== bis;
  });
}

/** Empfaenger der Ablauf-Mail: Bevollmaechtigte und Geber, ohne Doppelte und Abgemeldete. */
function empfaengerAblauf(v, { bevollmaechtigterEmail = null, aus = new Set() } = {}) {
  const liste = [];
  const gesehen = new Set();
  const add = (email, name) => {
    const e = klein(email);
    if (!e || gesehen.has(e)) return;
    gesehen.add(e);
    if (!aus.has(e)) liste.push({ email: e, name: name || '' });
  };
  add(bevollmaechtigterEmail || v.bevollmaechtigter_email, v.bevollmaechtigter_name);
  for (const g of Array.isArray(v.vollmachtgeber_liste) ? v.vollmachtgeber_liste : []) if (g) add(g.email, g.name);
  add(v.vollmachtgeber_email, v.vollmachtgeber_name);
  return liste;
}

module.exports = {
  ABLAUF_VORLAUF_TAGE, VORLAGEN, kontext, tageBis, datumText, gueltigBisText,
  empfaengerAktiv, ablaufFaellig, empfaengerAblauf,
};
