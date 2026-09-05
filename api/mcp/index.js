// MCP-Server für das Portal — eine dünne Schicht über der REST-API.
//
// Ein Agent (Claude, die Stations-App, der WhatsApp-Bot) spricht MCP über
// Streamable HTTP mit mcp.rosenweg4303.ch. Er weist sich mit demselben
// persönlichen Zugangstoken aus, das im Profil angelegt wird (rw_pat_…).
// Damit erbt er die Rechte der Person — jede Zugangsregel der API gilt
// weiter, denn jedes Werkzeug ruft die API über die Loopback-Adresse mit
// genau diesem Token auf. Es gibt hier keine zweite Rechteverwaltung und
// kein Dienstgeheimnis, das man verlieren könnte.
//
// Zustandslos: Pro Anfrage entsteht ein Server mit genau den Werkzeugen,
// die die Scopes des Tokens erlauben. Ein Token mit wasch:* sieht die
// Waschküche und sonst nichts. Erzwungen wird der Scope aber nicht hier,
// sondern in authMiddleware beim Loopback-Aufruf — die Liste hier ist die
// Höflichkeit, die Middleware der Riegel.
//
// Schreibende Werkzeuge sind nach Wirkung eingeteilt (Entscheid 5.9.2026):
// Umkehrbares, Eigenes und Anträge laufen frei. Was nach draussen sendet,
// etwas öffnet, löscht, Zugangsdaten erzeugt oder woran die Anmeldung
// hängt, verlangt bestaetigt=true — ohne den Parameter kommt nur eine
// Vorschau zurück, und nichts geschieht.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { authMiddleware, scopeErlaubt } = require('../middleware/auth');

const PORT = process.env.PORT || 3000;
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const MCP_HOST = (process.env.MCP_HOST || 'mcp.rosenweg4303.ch').toLowerCase();
const VERSION = '0.1.0';
const MAX_TEXT = 60_000;

const ANLEITUNG = `Rosenweg-Portal (Siedlung Rosenweg, 4303 Kaiseraugst). Du handelst im Namen der angemeldeten Person, mit ihren Rechten.
Werkzeuge mit "frei" führen sofort aus. Werkzeuge mit "bestätigt" liefern ohne bestaetigt=true nur eine Vorschau — frag die Person, bevor du bestaetigt=true setzt.
Zeiten sind ISO-8601 in Europa/Zürich. STWEG = Stockwerkeigentümergemeinschaft; Haus 9 ist STWEG 3, Haus 1 ist STWEG 6, MEG ist STWEG 8.`;

// ── Loopback ────────────────────────────────────────────────────────────
// Der Aufruf geht mit dem Token der Person an die eigene API. Die API
// prüft Token, Scope und Rechte genau so, als käme der Aufruf vom Browser.
async function apiAufruf(auth, method, pfad, { body, query } = {}) {
  const url = new URL(pfad, LOOPBACK);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { roh: text.slice(0, 2000) }; }
  if (!r.ok) {
    const e = new Error((data && data.error) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

function alsText(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… (gekürzt, ${s.length} Zeichen)` : s;
}
const ok = (data) => ({ content: [{ type: 'text', text: alsText(data) }] });
const fehler = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const vorschau = (was) => ({ content: [{ type: 'text', text: `Vorschau — nichts ausgeführt.\n${was}\nZum Ausführen: bestaetigt=true setzen, nachdem die Person zugestimmt hat.` }] });

// ── Werkzeuge ───────────────────────────────────────────────────────────
// pfad:     Segment für den Scope-Check (relativ zu /api/)
// methode:  welche HTTP-Methode der Scope-Check annimmt (GET → read, sonst write)
// frei:     true = läuft ohne Rückfrage; false = braucht bestaetigt=true
// eingabe:  zod-Shape der Parameter
// lauf:     (api, args) → Daten oder ein fertiges Resultat
const KATEGORIEN = ['aufzug', 'heizung', 'wasser', 'tuer', 'reinigung', 'licht', 'strom', 'netzwerk', 'salz', 'sonstige'];

const WERKZEUGE = [
  {
    name: 'profil_lesen', pfad: 'me', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Profil lesen',
    beschreibung: 'Wer bin ich: Name, E-Mail, Gruppen, STWEG, Wohnung(en), hinterlegte Telefonnummern und E-Mail-Adressen.',
    eingabe: {},
    async lauf(api) {
      const [me, wohnungen] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/me/wohnungen').catch(() => null)]);
      return { ...me, wohnungen };
    },
  },
  {
    name: 'profil_aendern', pfad: 'me', methode: 'PUT', frei: true, nurLesen: false,
    titel: 'Profil ändern',
    beschreibung: 'Telefonnummern und WhatsApp-Opt-in ändern — frei. E-Mail-Adressen nur mit bestaetigt=true, weil daran die Anmeldung und die Zustellung hängen. Übergibt man ein Feld nicht, bleibt es unverändert.',
    eingabe: {
      telefone: z.array(z.string()).optional().describe('Vollständige neue Liste der Telefonnummern (ersetzt die bisherige)'),
      whatsapp_optin: z.boolean().optional().describe('WhatsApp-Meldungen erhalten'),
      emails: z.array(z.string().email()).optional().describe('Vollständige neue Liste der E-Mail-Adressen — bestätigt'),
      bestaetigt: z.boolean().optional(),
    },
    async lauf(api, a) {
      const out = {};
      if (a.emails && !a.bestaetigt) return vorschau(`E-Mail-Adressen würden ersetzt durch: ${a.emails.join(', ')}`);
      if (a.telefone) out.telefone = await api('PUT', '/api/me/phones', { body: { telefone: a.telefone } });
      if (typeof a.whatsapp_optin === 'boolean') out.whatsapp = await api('PUT', '/api/me/whatsapp-optin', { body: { enabled: a.whatsapp_optin } });
      if (a.emails) out.emails = await api('PUT', '/api/me/emails', { body: { emails: a.emails } });
      if (Object.keys(out).length === 0) return fehler('Nichts angegeben — telefone, whatsapp_optin oder emails übergeben.');
      return out;
    },
  },
  {
    name: 'adresse_melden', pfad: 'me', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Adressmutation melden',
    beschreibung: 'Neue Postadresse, Namen oder Telefonnummer der Verwaltung melden. Das ist ein Antrag — ein Mensch prüft ihn, nichts ändert sich sofort. Derselbe Weg wie adressen@rosenweg4303.ch, nur strukturiert.',
    eingabe: {
      name: z.string().optional(), strasse: z.string().optional(), plz: z.string().optional(),
      ort: z.string().optional(), phone: z.string().optional(),
    },
    async lauf(api, a) {
      if (!Object.values(a).some(v => v)) return fehler('Mindestens ein Feld angeben (name, strasse, plz, ort, phone).');
      return api('POST', '/api/me/mutation', { body: a });
    },
  },
  {
    name: 'uebersicht', pfad: 'dashboard', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Übersicht',
    beschreibung: 'Was für mich gerade ansteht: offene Vorgänge, Freigaben, Projekte, Termine — die Startseite des Portals als Daten.',
    eingabe: {},
    async lauf(api) {
      const [dash, projekte] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/projects-mini').catch(() => null)]);
      return { ...dash, projekte };
    },
  },
  {
    name: 'reklamation_melden', pfad: 'reklamationen', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Schaden melden',
    beschreibung: 'Eine Reklamation (Schadens- oder Reparaturmeldung) anlegen. Frei — die Meldung ist umkehrbar und wird von der Technik triagiert. Beschreibung ist Pflicht; Kategorie wenn erkennbar; Standort so genau wie möglich (z. B. "Treppenhaus R13, Abgang Garage UG").',
    eingabe: {
      beschreibung: z.string().min(5).max(4000),
      kategorie: z.enum(KATEGORIEN).optional().describe('Standard: sonstige'),
      standort: z.string().max(300).optional(),
      stweg: z.number().int().min(1).max(8).optional().describe('STWEG-Nummer, wenn bekannt'),
      foto_base64: z.string().optional().describe('Foto als data:image/…;base64,… — optional'),
    },
    async lauf(api, a) { return api('POST', '/api/reklamationen', { body: a }); },
  },
  {
    name: 'reklamation_meine', pfad: 'reklamationen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Meine Reklamationen',
    beschreibung: 'Meine Meldungen mit Status. Mit id zusätzlich den Verlauf einer einzelnen Meldung.',
    eingabe: {
      id: z.number().int().optional().describe('Verlauf dieser Meldung mitliefern'),
      archivierte: z.boolean().optional().describe('Auch erledigte/archivierte zeigen'),
    },
    async lauf(api, a) {
      const liste = await api('GET', '/api/reklamationen/meine', { query: { archiviert: a.archivierte ? 1 : undefined } });
      if (!a.id) return liste;
      const verlauf = await api('GET', `/api/reklamationen/meine/${a.id}/verlauf`);
      return { meldung: (Array.isArray(liste) ? liste : liste?.reklamationen || []).find(r => r.id === a.id) || null, verlauf };
    },
  },
  {
    name: 'wasch_raeume', pfad: 'wasch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Waschräume',
    beschreibung: 'Waschräume mit Standort und Regeln (Zeitfenster, Tarife, Stornofrist).',
    eingabe: {},
    async lauf(api) {
      const [rooms, settings] = await Promise.all([api('GET', '/api/wasch/rooms'), api('GET', '/api/wasch/settings').catch(() => null)]);
      return { raeume: rooms, regeln: settings };
    },
  },
  {
    name: 'wasch_belegung', pfad: 'wasch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Waschküche: Belegung',
    beschreibung: 'Belegung eines Waschraums im Zeitraum, dazu meine eigenen Reservationen. Ohne Zeitraum: die nächsten Tage.',
    eingabe: {
      room_id: z.number().int().optional(),
      von: z.string().optional().describe('ISO-Datum/Zeit'),
      bis: z.string().optional().describe('ISO-Datum/Zeit'),
    },
    async lauf(api, a) {
      const [alle, meine] = await Promise.all([
        api('GET', '/api/wasch/reservations', { query: { room_id: a.room_id, from: a.von, to: a.bis } }),
        api('GET', '/api/wasch/my/reservations').catch(() => []),
      ]);
      return { belegung: alle, meine };
    },
  },
  {
    name: 'wasch_reservieren', pfad: 'wasch', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Waschküche reservieren',
    beschreibung: 'Einen Waschraum reservieren, auf Wunsch wöchentlich wiederkehrend bis zu einem Datum. Frei — eine Reservation ist mit wasch_stornieren umkehrbar.',
    eingabe: {
      room_id: z.number().int(),
      start_time: z.string().describe('ISO-Datum/Zeit'),
      end_time: z.string().describe('ISO-Datum/Zeit'),
      recurring: z.boolean().optional().describe('Wöchentlich wiederholen'),
      recurring_until: z.string().optional().describe('Letztes Datum der Serie'),
    },
    async lauf(api, a) { return api('POST', '/api/wasch/reservations', { body: a }); },
  },
  {
    name: 'wasch_stornieren', pfad: 'wasch', methode: 'DELETE', frei: true, nurLesen: false,
    titel: 'Reservation stornieren',
    beschreibung: 'Eine eigene Reservation stornieren; mit serie=true die ganze Serie.',
    eingabe: { id: z.number().int(), serie: z.boolean().optional() },
    async lauf(api, a) { return api('DELETE', `/api/wasch/reservations/${a.id}${a.serie ? '/series' : ''}`); },
  },
  {
    name: 'wasch_meine_kosten', pfad: 'wasch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Waschküche: meine Läufe und Kosten',
    beschreibung: 'Meine bisherigen Waschgänge und was sie kosten.',
    eingabe: {},
    async lauf(api) {
      const [kosten, laeufe] = await Promise.all([api('GET', '/api/wasch/my/costs'), api('GET', '/api/wasch/my/sessions').catch(() => null)]);
      return { kosten, laeufe };
    },
  },
  {
    name: 'zaehler_daten', pfad: 'zähler', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Zählerdaten',
    beschreibung: 'Verbrauch eines meiner Zähler im Zeitraum. Die Zähler-ID steht im Profil oder in zev_rechnungen.',
    eingabe: {
      zaehler_id: z.string(),
      von: z.string().optional().describe('ISO-Datum'),
      bis: z.string().optional().describe('ISO-Datum'),
    },
    async lauf(api, a) { return api('GET', `/api/zähler/daten/${encodeURIComponent(a.zaehler_id)}`, { query: { von: a.von, bis: a.bis } }); },
  },
  {
    name: 'zev_rechnungen', pfad: 'zev', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Meine ZEV-Rechnungen',
    beschreibung: 'Meine Stromrechnungen aus dem ZEV (Zusammenschluss zum Eigenverbrauch), mit Status. Das PDF holt man im Portal unter /api/zev/rechnung/{id}/pdf.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/zev/meine-rechnungen'); },
  },
  {
    name: 'dokumente', pfad: 'documents', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Dokumente',
    beschreibung: 'Dokumente, die ich sehen darf (Protokolle, Reglemente, Pläne meiner STWEG). Mit suche nach Namen oder Pfad filtern.',
    eingabe: { suche: z.string().optional() },
    async lauf(api, a) {
      const docs = await api('GET', '/api/documents');
      const liste = Array.isArray(docs) ? docs : (docs?.documents || []);
      if (!a.suche) return liste;
      const q = a.suche.toLowerCase();
      return liste.filter(d => JSON.stringify(d).toLowerCase().includes(q));
    },
  },
  {
    name: 'telefonbuch', pfad: 'telefonbuch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Telefonbuch',
    beschreibung: 'Ansprechpersonen der Siedlung: Ausschuss, Technik, Verwaltung, Hauswartung. Mit stweg zusätzlich die Kontakte dieser STWEG.',
    eingabe: { stweg: z.number().int().min(1).max(8).optional() },
    async lauf(api, a) {
      const [tb, stweg] = await Promise.all([
        api('GET', '/api/telefonbuch'),
        a.stweg ? api('GET', `/api/stweg/${a.stweg}/kontakte`).catch(() => null) : null,
      ]);
      return { telefonbuch: tb, stweg_kontakte: stweg };
    },
  },
  {
    name: 'suche', pfad: 'ki-search', methode: 'POST', frei: true, nurLesen: true,
    titel: 'Suche im Portal',
    beschreibung: 'Die Portalsuche: Personen, Handwerker, Vollmachten, Dokumente — nur, was ich sehen darf. Braucht den Scope ki-search:write, weil die API die Suche als POST führt.',
    eingabe: { q: z.string().min(2) },
    async lauf(api, a) { return api('POST', '/api/ki-search', { body: { q: a.q } }); },
  },
];

// ── Server je Anfrage ───────────────────────────────────────────────────
function baueServer(req) {
  const server = new McpServer({ name: 'rosenweg-portal', version: VERSION }, { instructions: ANLEITUNG });
  const scopes = req.pat ? req.pat.scopes : null;
  const auth = req.headers.authorization;
  const wer = req.user?.email || 'unbekannt';
  const api = (method, pfad, opts) => apiAufruf(auth, method, pfad, opts);

  for (const w of WERKZEUGE) {
    if (!scopeErlaubt(scopes, w.pfad, w.methode)) continue;
    server.registerTool(
      w.name,
      {
        title: w.titel,
        description: `${w.frei ? '[frei]' : '[bestätigt]'} ${w.beschreibung}`,
        inputSchema: w.eingabe,
        annotations: { readOnlyHint: w.nurLesen, destructiveHint: !w.nurLesen && !w.frei, idempotentHint: w.nurLesen, openWorldHint: false },
      },
      async (args) => {
        const t0 = Date.now();
        try {
          const r = await w.lauf(api, args || {});
          console.log(`[MCP] ${wer} ${w.name} ok ${Date.now() - t0}ms`);
          return r && r.content ? r : ok(r);
        } catch (e) {
          console.log(`[MCP] ${wer} ${w.name} fehler ${e.status || ''} ${e.message}`);
          return fehler(`${w.name}: ${e.message}`);
        }
      },
    );
  }
  return server;
}

function mountMcp(app) {
  // mcp.rosenweg4303.ch antwortet an der Wurzel — der Reverse-Proxy leitet
  // den Host unverändert an die API weiter, und ein MCP-Client soll nicht
  // wissen müssen, dass der Pfad intern /mcp heisst.
  app.use((req, _res, next) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
    if (host === MCP_HOST && (req.path === '/' || req.path === '')) req.url = '/mcp' + req.url.slice(1);
    next();
  });

  // Ohne Ausweis nur die Visitenkarte — damit ein Mensch im Browser sieht,
  // was hier läuft und wie man sich verbindet.
  app.get('/mcp', (_req, res) => {
    res.json({
      name: 'rosenweg-portal', version: VERSION, transport: 'streamable-http',
      auth: 'Authorization: Bearer rw_pat_… (Token aus dem Profil auf www.rosenweg4303.ch)',
      werkzeuge: WERKZEUGE.map(w => `${w.name} (${w.frei ? 'frei' : 'bestätigt'}, Scope ${w.pfad}:${w.methode === 'GET' ? 'read' : 'write'})`),
      anleitung: 'claude mcp add rosenweg --transport http https://' + MCP_HOST + ' --header "Authorization: Bearer rw_pat_…"',
    });
  });

  // Scopes prüft nicht der Transport, sondern jeder Loopback-Aufruf eines
  // Werkzeugs — sonst käme ein Token mit wasch:* nie bis zur Waschküche.
  const scopeAmZiel = (req, _res, next) => { req.scopeAmZiel = true; next(); };
  app.post('/mcp', scopeAmZiel, authMiddleware, async (req, res) => {
    const server = baueServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[MCP] Transportfehler:', e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Interner Fehler' }, id: null });
    }
  });

  // Zustandslos: keine Sitzungen, also nichts zu beenden.
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Zustandslos — keine Sitzung' }));

  console.log(`[MCP] Portal-MCP bereit: ${WERKZEUGE.length} Werkzeuge, Host ${MCP_HOST}`);
}

module.exports = { mountMcp, WERKZEUGE };
