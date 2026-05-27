#!/usr/bin/env node
/**
 * Rosenweg MCP Server
 * Stellt der KI typisierte Tools zur Verfuegung um im Namen eines Users
 * mit der Rosenweg-API zu interagieren. Auth via Personal Access Token.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API = (process.env.ROSENWEG_API || 'https://www.rosenweg4303.ch').replace(/\/$/, '');
const TOKEN = process.env.ROSENWEG_TOKEN;
if (!TOKEN) {
  console.error('FATAL: ROSENWEG_TOKEN env var fehlt. Token im Profil erstellen: ' + API + '/profil.html');
  process.exit(1);
}

async function api(method, path, body) {
  const headers = { 'Authorization': 'Bearer ' + TOKEN };
  let bodyInit;
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) {
      bodyInit = body;
      headers['Content-Type'] = 'application/octet-stream';
    } else {
      bodyInit = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }
  const r = await fetch(API + path, { method, headers, body: bodyInit });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = data?.error || `HTTP ${r.status}`;
    throw new Error(`${method} ${path} → ${err}`);
  }
  return data;
}

function ok(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}
function err(message) {
  return { content: [{ type: 'text', text: 'FEHLER: ' + message }], isError: true };
}

// ─── Tool-Definitionen ──────────────────────────────────────────────
// inputSchema folgt JSON-Schema-Spec, der MCP-Client validiert.

const TOOLS = [
  // ─── Generic / Discovery ───
  {
    name: 'whoami',
    description: 'Wer bin ich? Liefert Email, Name, Gruppen, isAdmin, PAT-Info. Erste Anlaufstelle wenn KI klaeren muss was sie tun darf.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/me'),
  },
  {
    name: 'api_call',
    description: 'Generischer Fallback: ruft beliebigen API-Endpoint auf. Nur verwenden wenn kein spezifisches Tool passt. method = GET|POST|PUT|DELETE, path beginnt mit /api/. body als Object (wird JSON-serialisiert).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        path: { type: 'string', description: 'Pfad ab /api/, z.B. /api/handwerker' },
        body: { type: 'object', description: 'Request-Body (JSON)', additionalProperties: true },
      },
      required: ['method', 'path'],
    },
    handler: (args) => api(args.method, args.path, args.body),
  },

  // ─── Vollmachten ───
  {
    name: 'vollmachten_list',
    description: 'Liste alle Vollmachten die dem User zugaenglich sind (eigene + erhaltene, fuer Admins alle).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/vollmachten'),
  },
  {
    name: 'vollmachten_create_draft',
    description: 'Neue Vollmacht als Entwurf anlegen. art = generell|spezifisch|auskunft. bevollmaechtigter_typ = eigentuemer|verwaltung|mieter|extern. vollmachtgeber-Array fuer Miteigentuemer (alle muessen separat signieren).',
    inputSchema: {
      type: 'object',
      properties: {
        vollmachtgeber: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, adresse: { type: 'string' } }, required: ['name'] } },
        bevollmaechtigter_name: { type: 'string' },
        bevollmaechtigter_email: { type: 'string' },
        bevollmaechtigter_typ: { type: 'string', enum: ['eigentuemer','verwaltung','mieter','extern'] },
        bevollmaechtigter_adresse: { type: 'string' },
        bevollmaechtigter_telefon: { type: 'string' },
        art: { type: 'string', enum: ['generell','spezifisch','auskunft'] },
        geltungsbereich: { type: 'string' },
        wohnung_id: { type: 'number' },
        stweg: { type: 'number' },
        gueltig_ab: { type: 'string', description: 'ISO-Date (YYYY-MM-DD)' },
        gueltig_bis: { type: 'string' },
      },
      required: ['vollmachtgeber','bevollmaechtigter_name','bevollmaechtigter_typ','art'],
    },
    handler: (args) => {
      const body = { ...args };
      if (Array.isArray(args.vollmachtgeber) && args.vollmachtgeber.length > 0) {
        body.vollmachtgeber_name = args.vollmachtgeber[0].name;
        body.vollmachtgeber_email = args.vollmachtgeber[0].email || null;
        body.vollmachtgeber_adresse = args.vollmachtgeber[0].adresse || null;
      }
      return api('POST', '/api/vollmachten', body);
    },
  },
  {
    name: 'vollmachten_sign_digital',
    description: 'Eigene Vollmachtgeber-Zeile digital signieren (per Authentik-Login = einfache el. Signatur ZertES Art.2). Nur fuer Vollmachten wo eingeloggter User Vollmachtgeber ist. Vollmacht wird aktiv sobald ALLE Vollmachtgeber signiert haben.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('POST', `/api/vollmachten/${args.id}/sign-digital`),
  },
  {
    name: 'vollmachten_revoke',
    description: 'Vollmacht widerrufen. Nur fuer Vollmachtgeber oder Admin. Grund optional.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, grund: { type: 'string' } },
      required: ['id'],
    },
    handler: (args) => api('POST', `/api/vollmachten/${args.id}/revoke`, { grund: args.grund }),
  },
  {
    name: 'vollmachten_delete',
    description: 'Vollmacht-Entwurf loeschen. Nur Entwuerfe, nicht aktive (dafuer revoke).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('DELETE', `/api/vollmachten/${args.id}`),
  },
  {
    name: 'vollmachten_verify_ai',
    description: 'Eine signierte (papier-)PDF einer Vollmacht durch KI verifizieren lassen — prueft ob Doc-Hash + alle Vollmachtgeber-Namen drauf sind + Unterschriften-Indikatoren.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('POST', `/api/vollmachten/${args.id}/verify-ai`),
  },
  {
    name: 'vollmachten_templates_list',
    description: 'Liste der Vollmacht-Vorlagen (vorgefertigte Geltungsbereich-Texte).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/vollmachten/templates'),
  },
  {
    name: 'vollmachten_templates_create',
    description: 'Neue Vorlage erstellen (nur technik/praesident/ausschuss).',
    inputSchema: {
      type: 'object',
      properties: {
        titel: { type: 'string' }, beschreibung: { type: 'string' },
        art: { type: 'string', enum: ['generell','spezifisch','auskunft'] },
        geltungsbereich: { type: 'string' },
      },
      required: ['titel','art','geltungsbereich'],
    },
    handler: (args) => api('POST', '/api/vollmachten/templates', args),
  },
  {
    name: 'vollmachten_lookup_my_kontakte',
    description: 'Liste der Kontakte (Eigentuemer/Mieter/Verwalter) aus den Wohnungen des Users — fuer Bevollmaechtigter-Auswahl. Optional rolle-gefiltert.',
    inputSchema: {
      type: 'object',
      properties: { rolle: { type: 'string', enum: ['eigentuemer','mieter','verwalter','bewohner'] } },
    },
    handler: (args) => api('GET', '/api/vollmachten/lookup/my-kontakte' + (args.rolle ? '?rolle=' + args.rolle : '')),
  },
  {
    name: 'vollmachten_lookup_verwaltungen',
    description: 'Liste aktiver Verwaltungs-Firmen (langPartners etc.) — fuer Bevollmaechtigter=Verwaltung.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/vollmachten/lookup/verwaltungen'),
  },
  {
    name: 'vollmachten_lookup_my_wohnungen',
    description: 'Wohnungen des aktuellen Users — fuer Wohnungs-Bezug einer Vollmacht.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/vollmachten/lookup/my-wohnungen'),
  },

  // ─── Auslagen ───
  {
    name: 'auslagen_list',
    description: 'Liste aller Auslagen die der User sehen darf (eigene + Ausschuss-STWEG fuer Reviewer).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['eingereicht','genehmigt','ausbezahlt','abgelehnt'] } },
    },
    handler: (args) => api('GET', '/api/auslagen' + (args.status ? '?status=' + args.status : '')),
  },
  {
    name: 'auslagen_get',
    description: 'Eine Auslage im Detail (inkl. Positionen + Belege).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('GET', `/api/auslagen/${args.id}`),
  },
  {
    name: 'auslagen_create',
    description: 'Neue Auslage erfassen. positionen optional als Array fuer Detail-Aufschluesselung.',
    inputSchema: {
      type: 'object',
      properties: {
        datum: { type: 'string', description: 'YYYY-MM-DD' },
        stweg: { type: 'number' },
        kategorie: { type: 'string' },
        beschreibung: { type: 'string' },
        betrag_chf: { type: 'number' },
        projekt_id: { type: 'number' },
        positionen: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['datum','beschreibung','betrag_chf'],
    },
    handler: (args) => api('POST', '/api/auslagen', args),
  },
  {
    name: 'auslagen_update_status',
    description: 'Status einer Auslage aendern (Reviewer-Aktion). Nur fuer Ausschuss/Technik/Praesident.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string', enum: ['eingereicht','genehmigt','ausbezahlt','abgelehnt'] },
        notiz: { type: 'string' },
      },
      required: ['id','status'],
    },
    handler: (args) => api('PUT', `/api/auslagen/${args.id}`, { status: args.status, notiz: args.notiz }),
  },
  {
    name: 'auslagen_stundensatz_list',
    description: 'Stundensaetze pro STWEG (fuer Auslagen-Berechnung Eigenleistung).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/auslagen-stundensatz'),
  },

  // ─── Reklamationen ───
  {
    name: 'reklamationen_list',
    description: 'Liste der Reklamationen/Schadensmeldungen.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['offen','weitergeleitet','erledigt','abgewiesen'] } },
    },
    handler: (args) => api('GET', '/api/reklamationen' + (args.status ? '?status=' + args.status : '')),
  },
  {
    name: 'reklamationen_update',
    description: 'Reklamations-Status / Handwerker-Zuweisung / Notiz aendern.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string', enum: ['offen','weitergeleitet','erledigt','abgewiesen'] },
        kategorie: { type: 'string' },
        handwerker_id: { type: 'number' },
        zugewiesen_an: { type: 'string' },
        notiz: { type: 'string' },
      },
      required: ['id'],
    },
    handler: (args) => api('PUT', `/api/reklamationen/${args.id}`, args),
  },

  // ─── Personen / Wohnungen ───
  {
    name: 'personen_list',
    description: 'Liste aller Personen (nur fuer wohnungsverwaltung-permission). Suche via q-Parameter (Name oder Email).',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    handler: (args) => api('GET', '/api/personen' + (args.q ? '?q=' + encodeURIComponent(args.q) : '')),
  },
  {
    name: 'personen_get',
    description: 'Person im Detail (inkl. verknuepfter Wohnungen).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('GET', `/api/personen/${args.id}`),
  },
  {
    name: 'wohnungen_list_for_stweg',
    description: 'Alle Wohnungen einer STWEG (1-8). Nur fuer wohnungsverwaltung-permission.',
    inputSchema: { type: 'object', properties: { stweg: { type: 'number' } }, required: ['stweg'] },
    handler: (args) => api('GET', `/api/wohnungen/${args.stweg}`),
  },
  {
    name: 'wohnungen_get',
    description: 'Wohnung im Detail (inkl. aller Kontakte mit Rollen).',
    inputSchema: {
      type: 'object',
      properties: { stweg: { type: 'number' }, id: { type: 'number' } },
      required: ['stweg','id'],
    },
    handler: (args) => api('GET', `/api/wohnungen/${args.stweg}/${args.id}`),
  },

  // ─── Handwerker ───
  {
    name: 'handwerker_list',
    description: 'Liste aller Handwerker und Lieferanten.',
    inputSchema: {
      type: 'object',
      properties: { kategorie: { type: 'string' }, archiviert: { type: 'boolean' } },
    },
    handler: (args) => {
      const params = new URLSearchParams();
      if (args.kategorie) params.set('kategorie', args.kategorie);
      if (args.archiviert) params.set('archiviert', 'true');
      const q = params.toString();
      return api('GET', '/api/handwerker' + (q ? '?' + q : ''));
    },
  },
  {
    name: 'handwerker_get',
    description: 'Handwerker im Detail (Vertrag, Kontakte, Auftraege, Events).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('GET', `/api/handwerker/${args.id}`),
  },
  {
    name: 'handwerker_create',
    description: 'Neuen Handwerker erfassen (nur Ausschuss/Technik).',
    inputSchema: {
      type: 'object',
      properties: {
        kategorie: { type: 'string' }, firma: { type: 'string' },
        ansprechpartner: { type: 'string' }, telefon: { type: 'string' },
        mobile: { type: 'string' }, email: { type: 'string' },
        website: { type: 'string' }, adresse: { type: 'string' },
        plz: { type: 'string' }, ort: { type: 'string' },
        notiz: { type: 'string' }, bewertung: { type: 'number' },
        empfohlen_von: { type: 'string' },
      },
      required: ['kategorie','firma'],
    },
    handler: (args) => api('POST', '/api/handwerker', args),
  },
  {
    name: 'handwerker_events_list',
    description: 'Wiederkehrende Termine bei Handwerkern (z.B. Brandschutz-Inspektion jaehrlich).',
    inputSchema: { type: 'object', properties: { offen_nur: { type: 'boolean' } } },
    handler: (args) => api('GET', '/api/handwerker-events' + (args.offen_nur ? '?offen=true' : '')),
  },

  // ─── Mail / Verteiler ───
  {
    name: 'verteiler_list',
    description: 'Alle E-Mail-Verteiler (z.B. bewohner@, ausschuss@, technik@).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/verteiler'),
  },
  {
    name: 'verteiler_send',
    description: 'E-Mail ueber einen Verteiler verschicken. recipient = Verteiler-Email-Adresse (z.B. bewohner@rosenweg4303.ch).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Verteiler-Email' },
        subject: { type: 'string' },
        text: { type: 'string', description: 'Plain-Text Body' },
        html: { type: 'string', description: 'HTML Body (optional, ueberschreibt text)' },
      },
      required: ['to','subject','text'],
    },
    handler: (args) => api('POST', '/api/verteiler/send', args),
  },
  {
    name: 'email_archive_list',
    description: 'Liste archivierter E-Mails (verteiler-archiv). Pagination via limit/offset.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
    },
    handler: (args) => {
      const p = new URLSearchParams();
      if (args.q) p.set('q', args.q);
      if (args.limit) p.set('limit', String(args.limit));
      if (args.offset) p.set('offset', String(args.offset));
      return api('GET', '/api/email-archive' + (p.toString() ? '?' + p.toString() : ''));
    },
  },
  {
    name: 'mail_templates_list',
    description: 'E-Mail-Templates (vorgefertigte Texte) listen.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/mail-templates'),
  },

  // ─── Dokumente ───
  {
    name: 'documents_list',
    description: 'Liste der Dokumente in einem Ordner. path z.B. "allgemein", "stweg3/protokolle", "archiv".',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    handler: (args) => api('GET', '/api/documents' + (args.path ? '?path=' + encodeURIComponent(args.path) : '')),
  },

  // ─── Grundbuch ───
  {
    name: 'grundbuch_my',
    description: 'Eigene Grundbuch-Eintraege (Wertquoten pro Wohnung).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/grundbuch/me'),
  },
  {
    name: 'grundbuch_anteile',
    description: 'Alle Wertquoten einer STWEG (admin/eigentuemer).',
    inputSchema: { type: 'object', properties: { stweg: { type: 'number' } }, required: ['stweg'] },
    handler: (args) => api('GET', `/api/grundbuch/anteile?stweg=${args.stweg}`),
  },

  // ─── Waschkueche ───
  {
    name: 'wasch_list_rooms',
    description: 'Verfuegbare Waschraeume (mit Geraeten, Energy-Meter).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/wasch/rooms'),
  },
  {
    name: 'wasch_my_reservations',
    description: 'Eigene Waschkueche-Reservationen.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/wasch/my'),
  },
  {
    name: 'wasch_reserve',
    description: 'Waschmaschine reservieren. start/end im ISO-Format (YYYY-MM-DDTHH:MM).',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'number' },
        start_time: { type: 'string' },
        end_time: { type: 'string' },
        recurring: { type: 'boolean' },
        recurring_until: { type: 'string' },
      },
      required: ['room_id','start_time','end_time'],
    },
    handler: (args) => api('POST', '/api/wasch/reservations', args),
  },
  {
    name: 'wasch_cancel',
    description: 'Reservation stornieren.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('DELETE', `/api/wasch/reservations/${args.id}`),
  },

  // ─── WhatsApp ───
  {
    name: 'whatsapp_send_to_person',
    description: 'WhatsApp-Nachricht an Person (per_id oder per_email). Funktioniert nur wenn Person Opt-In hat.',
    inputSchema: {
      type: 'object',
      properties: { person_id: { type: 'number' }, email: { type: 'string' }, body: { type: 'string' } },
      required: ['body'],
    },
    handler: (args) => api('POST', '/api/whatsapp/admin/send', args),
  },

  // ─── PBX ───
  {
    name: 'pbx_status',
    description: 'PBX-Status (Trunk-Registrierung, aktive Anrufe).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/pbx/trunk-status'),
  },
  {
    name: 'pbx_list_calls',
    description: 'Letzte PBX-Anrufe (mit Voicemail-Transkripten).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    handler: (args) => api('GET', '/api/pbx/calls' + (args.limit ? '?limit=' + args.limit : '')),
  },
  {
    name: 'pbx_list_ring_members',
    description: 'Aktive Ring-Member-Konfiguration (wer wird angerufen).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/pbx/ring-members'),
  },

  // ─── Verwaltungen / STWEG ───
  {
    name: 'verwaltungen_list',
    description: 'Alle Hausverwaltungs-Firmen mit Kontaktdaten.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/verwaltungen'),
  },
  {
    name: 'stweg_info',
    description: 'Info zu einer STWEG (1-8): Hausnummern, Statistik, aktuelle Verwaltung.',
    inputSchema: { type: 'object', properties: { stweg: { type: 'number' } }, required: ['stweg'] },
    handler: (args) => api('GET', `/api/stweg/${args.stweg}`),
  },

  // ─── Projekte ───
  {
    name: 'projects_list',
    description: 'Liste der STWEG-Projekte (Sanierung, Erneuerung, etc.).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/projects'),
  },
  {
    name: 'projects_get',
    description: 'Projekt im Detail (Status, Kandidaten, Vergleich, Auslagen, Kommentare).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    handler: (args) => api('GET', `/api/projects/${args.slug}`),
  },

  // ─── Energie ───
  {
    name: 'energie_my_consumption',
    description: 'Eigener Stromverbrauch (Tag/Woche/Monat). period = day|week|month.',
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['day','week','month'] }, date: { type: 'string' } },
    },
    handler: (args) => {
      const p = new URLSearchParams();
      if (args.period) p.set('period', args.period);
      if (args.date) p.set('date', args.date);
      return api('GET', '/api/energy/my-consumption' + (p.toString() ? '?' + p.toString() : ''));
    },
  },

  // ─── Brief-Tracking ───
  {
    name: 'briefe_list',
    description: 'Versendete Briefe (Tracking via Schweizer Post).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/briefe'),
  },
  {
    name: 'briefe_get',
    description: 'Brief im Detail (Status-Updates, Adresse).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (args) => api('GET', `/api/briefe/${args.id}`),
  },

  // ─── Unterschriftenliste ───
  {
    name: 'unterschriftenliste_history',
    description: 'Generierte Unterschriftenlisten-Snapshots (mit Hash + Rueckläufen).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/unterschriftenliste/history'),
  },

  // ─── Diverses ───
  {
    name: 'handwerker_search_for_problem',
    description: 'Suche Handwerker fuer ein konkretes Problem. Liefert passende Handwerker (Kategorie-Match) sortiert nach Bewertung.',
    inputSchema: { type: 'object', properties: { problem: { type: 'string' } }, required: ['problem'] },
    handler: async (args) => {
      const all = await api('GET', '/api/handwerker');
      const list = all.handwerker || all || [];
      const lower = args.problem.toLowerCase();
      const keywords = {
        sanitaer: ['wasser','leck','toilette','dusche','wasch','sanit','heizung warm','rohr'],
        elektriker: ['strom','steckdose','licht','sicherung','elektr'],
        schreiner: ['holz','tuer','tür','fenster','moebel','schreiner'],
        maler: ['farbe','malen','tapete'],
        gartenbau: ['garten','rasen','hecke','baum'],
        reinigung: ['putzen','sauber','dreck','schmutz'],
        aufzug: ['aufzug','lift'],
        schluessel: ['schluessel','schlüssel','schloss'],
        heizung: ['heizung','kalt','warm','radiator'],
      };
      let match = null;
      for (const [kat, kws] of Object.entries(keywords)) {
        if (kws.some(k => lower.includes(k))) { match = kat; break; }
      }
      const filtered = match
        ? list.filter(h => h.kategorie?.toLowerCase().includes(match))
        : list;
      return { detected_category: match, count: filtered.length, handwerker: filtered.slice(0, 5) };
    },
  },
];

// ─── MCP-Server-Setup ───────────────────────────────────────────────
const server = new Server({ name: 'rosenweg-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  if (!tool) return err('Unbekanntes Tool: ' + req.params.name);
  try {
    const result = await tool.handler(req.params.arguments || {});
    return ok(result);
  } catch (e) {
    return err(e.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[rosenweg-mcp] verbunden mit ${API} (${TOOLS.length} Tools)`);
