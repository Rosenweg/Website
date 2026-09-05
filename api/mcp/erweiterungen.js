// Ressourcen und Prompts — was der Agent lesen darf und wie Abläufe gehen.
//
// Ressourcen sind die Dokumentation aus docs/ (im Image unter ./docs/).
// Der Agent antwortet dann aus dem, was wirklich gilt, statt aus Vermutung.
// Betriebsinterna (Netz, Adressen, Datenbank, SSH) sehen nur Technik und
// Präsidium; der Rest steht jeder angemeldeten Person offen.
//
// Prompts sind vorbereitete Abläufe: die richtigen Rückfragen in der
// richtigen Reihenfolge, bevor ein Werkzeug gerufen wird.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const DOCS_DIR = path.join(__dirname, '..', 'docs');

// Dokumente, die Betriebsinterna enthalten — nur Technik und Präsidium.
const NUR_TECHNIK = new Set([
  'infrastruktur', 'ip-zuordnung', 'netzwerk', 'routing', 'unifi', 'active-directory', 'cloudflare',
  'datenbank', 'api', 'ssh-zugang', 'systemuebersicht', 'website', 'deswarm-plan', 'mqtt-authentik-login',
  'technik-bot-konzept', 'energie-api', 'mcp',
]);

const TITEL = {
  'Home': 'Hilfe: Startseite', 'README': 'Über das Portal', 'verwaltung-anleitung': 'Anleitung für die Verwaltung',
  'email': 'E-Mail: Adressen und Weiterleitungen', 'energie': 'Energie, Zähler und ZEV', 'pwa-konzept': 'Die App (PWA)',
  'mqtt-display': 'Displays und MQTT', 'aufwand-erfassung-konzept': 'Aufwanderfassung',
};

function docsListe(technik) {
  let dateien = [];
  try { dateien = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')); } catch { return []; }
  return dateien
    .map(f => f.replace(/\.md$/, ''))
    .filter(n => technik || !NUR_TECHNIK.has(n))
    .sort()
    .map(n => ({ name: n, uri: `rosenweg://docs/${n}`, titel: TITEL[n] || n, datei: path.join(DOCS_DIR, n + '.md') }));
}

function registriereRessourcen(server, technik) {
  for (const d of docsListe(technik)) {
    server.registerResource(
      `docs-${d.name}`, d.uri,
      { title: d.titel, description: `Dokumentation: ${d.titel}`, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fs.readFileSync(d.datei, 'utf8') }] }),
    );
  }
}

// ── Prompts ─────────────────────────────────────────────────────────────
const nutzer = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

const PROMPTS = [
  {
    name: 'reklamation_melden',
    titel: 'Schaden melden',
    beschreibung: 'Führt durch eine Schadensmeldung: Was, wo, seit wann, Foto — und legt sie mit reklamation_melden an.',
    args: { was: z.string().optional().describe('Erste Beschreibung, falls schon bekannt') },
    text: (a) => `Ich möchte einen Schaden melden${a.was ? `: ${a.was}` : ''}.
Frag mich der Reihe nach, was noch fehlt — und nur das:
1. Was ist kaputt oder stört? (kurz, konkret)
2. Wo genau? Haus/STWEG, Stockwerk, Raum — z. B. «Treppenhaus R13, Abgang Garage UG».
3. Seit wann, und ist etwas gefährlich (Wasser, Strom, Tür geht nicht zu)?
4. Hast du ein Foto?
Ordne die Kategorie selbst zu (aufzug, heizung, wasser, tuer, reinigung, licht, strom, netzwerk, salz, sonstige).
Fass zusammen, was du anlegen wirst, und rufe dann reklamation_melden. Nenn mir am Ende die Nummer der Meldung.`,
  },
  {
    name: 'adresse_aendern',
    titel: 'Adresse oder Kontakt ändern',
    beschreibung: 'Erklärt, was sich sofort ändert (Telefon) und was ein Antrag ist (Postadresse), und führt beides aus.',
    args: {},
    text: () => `Ich möchte meine Kontaktdaten ändern.
Zeig mir zuerst mit profil_lesen, was hinterlegt ist. Dann:
– Telefonnummern und WhatsApp-Opt-in kannst du direkt mit profil_aendern setzen.
– Eine neue Postadresse oder ein neuer Name ist ein Antrag an die Verwaltung: adresse_melden. Sag mir, dass ein Mensch das prüft.
– E-Mail-Adressen änderst du nur, wenn ich es ausdrücklich bestätige — daran hängt die Anmeldung.
Frag nach, was ich ändern will, und führe es aus.`,
  },
  {
    name: 'waschkueche_reservieren',
    titel: 'Waschküche reservieren',
    beschreibung: 'Findet einen freien Termin und reserviert ihn.',
    args: { wunsch: z.string().optional().describe('z. B. «Samstag Vormittag» oder ein Datum') },
    text: (a) => `Ich möchte die Waschküche reservieren${a.wunsch ? `, am liebsten ${a.wunsch}` : ''}.
Hol mit wasch_raeume die Räume und Regeln (Zeitfenster, Stornofrist), dann mit wasch_belegung die Belegung im gewünschten Zeitraum.
Schlag mir höchstens drei freie Fenster vor, die zu meinem Wunsch passen. Reserviere erst, wenn ich eines gewählt habe — mit wasch_reservieren.
Sag mir danach, bis wann ich stornieren kann.`,
  },
  {
    name: 'vpn_einrichten',
    titel: 'VPN auf dem Handy einrichten',
    beschreibung: 'Zeigt die eigenen VPN-Profile und erklärt die Einrichtung mit QR-Code.',
    args: {},
    text: () => `Ich möchte das Rosenweg-VPN auf meinem Gerät einrichten.
Wenn du das Werkzeug vpn_konten hast, zeig mir meine Profile. Sonst erklär mir: Im Portal unter ISP → Mein Zugang gibt es die VPN-Profile mit QR-Code für die WireGuard-App.
Erklär in drei Schritten: WireGuard-App installieren, QR-Code scannen, Tunnel einschalten. Weise darauf hin, dass der Tunnel nur ins Rosenweg-Netz führt, nicht ins ganze Internet.`,
  },
  {
    name: 'vollmacht_versammlung',
    titel: 'Vollmacht für die Versammlung',
    beschreibung: 'Legt eine Vollmacht als Entwurf an und erklärt Unterschrift und Abgabe.',
    args: { bevollmaechtigte: z.string().optional().describe('Wer soll vertreten?') },
    text: (a) => `Ich kann nicht an die Versammlung und möchte eine Vollmacht erteilen${a.bevollmaechtigte ? ` an ${a.bevollmaechtigte}` : ''}.
Frag mich: für welche Versammlung (STWEG, Datum), wen ich bevollmächtige, und ob es eine Weisung gibt (wie abzustimmen ist).
Leg den Entwurf mit vollmacht_erstellen an, falls du das Werkzeug hast — sonst verweise auf Portal → Vollmachten.
Erklär den Rest: digital signieren oder ausdrucken, unterschreiben und hochladen; die Verwaltung prüft die Echtheit.`,
  },
];

function registrierePrompts(server) {
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.titel, description: p.beschreibung, argsSchema: p.args }, (args) => nutzer(p.text(args || {})));
  }
}

module.exports = { registriereRessourcen, registrierePrompts, docsListe, PROMPTS };
