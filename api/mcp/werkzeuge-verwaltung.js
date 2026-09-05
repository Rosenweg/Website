// Werkzeuge für Eigentümer, Ausschuss, Verwaltung und Technik — Phase 2.
//
// Dieselbe Bauart wie in index.js: jedes Werkzeug ruft die API über Loopback
// mit dem Token der Person auf. Die Rolle hier ('eigentuemer', 'ausschuss',
// 'technik') entscheidet nur, ob das Werkzeug in der Liste erscheint — damit
// ein Bewohner nicht fünfzig Werkzeuge sieht, die ihm 403 antworten würden.
// Erzwungen werden die Rechte in den Handlern der API, wie im Portal.
//
// frei / bestätigt nach Wirkung (Entscheid 5.9.2026): Stammdaten, Zuweisungen,
// Termine und interne Vermerke sind frei — umkehrbar und protokolliert. Was
// Mail oder WhatsApp nach draussen sendet, Türen öffnet, Abrechnungen
// auslöst, Konten oder Gruppen ändert oder Anträge entscheidet, ist bestätigt.
const { z } = require('zod');

const vorschau = (was) => ({ content: [{ type: 'text', text: `Vorschau — nichts ausgeführt.\n${was}\nZum Ausführen: bestaetigt=true setzen, nachdem die Person zugestimmt hat.` }] });
const fehler = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const STWEG = z.number().int().min(1).max(8);

const WERKZEUGE_VERWALTUNG = [
  // ── Eigentümer ──────────────────────────────────────────────────────
  {
    name: 'projekte', rolle: 'eigentuemer', pfad: 'projects', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Projekte',
    beschreibung: 'Projekte der Siedlung (Sanierungen, Anschaffungen) mit Stand, Budget, Zeitachse. Mit slug ein einzelnes Projekt samt Auslagen.',
    eingabe: { slug: z.string().optional() },
    async lauf(api, a) {
      if (!a.slug) return api('GET', '/api/projects');
      const [p, auslagen] = await Promise.all([api('GET', `/api/projects/${encodeURIComponent(a.slug)}`), api('GET', `/api/projects/${encodeURIComponent(a.slug)}/auslagen`).catch(() => null)]);
      return { projekt: p, auslagen };
    },
  },
  {
    name: 'projekt_kommentieren', rolle: 'eigentuemer', pfad: 'projects', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Projekt kommentieren',
    beschreibung: 'Einen Kommentar zu einem Projekt hinterlassen. Frei — sichtbar für Eigentümer, vom Ausschuss löschbar.',
    eingabe: { slug: z.string(), text: z.string().min(2).max(4000) },
    async lauf(api, a) { return api('POST', `/api/projects/${encodeURIComponent(a.slug)}/comments`, { body: { text: a.text } }); },
  },
  {
    name: 'grundbuch_anteile', rolle: 'eigentuemer', pfad: 'grundbuch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Grundbuch: Anteile',
    beschreibung: 'Wertquoten und Anteile je Parzelle, wie im Grundbuch erfasst. Mit nur_meine die eigenen.',
    eingabe: { parzelle: z.string().optional(), nur_meine: z.boolean().optional(), status: z.string().optional() },
    async lauf(api, a) { return api('GET', '/api/grundbuch/anteile', { query: { parzelle: a.parzelle, mine: a.nur_meine ? 1 : undefined, status: a.status } }); },
  },
  {
    name: 'einstellplaetze', rolle: 'eigentuemer', pfad: 'meg', methode: 'GET', frei: true, nurLesen: true,
    titel: 'MEG-Einstellplätze',
    beschreibung: 'Einstellplätze der Miteigentümergemeinschaft und welche frei sind.',
    eingabe: {},
    async lauf(api) {
      const [alle, frei] = await Promise.all([api('GET', '/api/meg/einstellplaetze'), api('GET', '/api/meg/einstellplaetze/verfuegbar').catch(() => null)]);
      return { plaetze: alle, verfuegbar: frei };
    },
  },

  // ── Ausschuss · Präsidium · Verwaltung ──────────────────────────────
  {
    name: 'wohnungen', rolle: 'ausschuss', pfad: 'wohnungen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Wohnungen einer STWEG',
    beschreibung: 'Wohnungen mit Bewohnern und Eigentümern einer STWEG; mit id die Historie einer Wohnung; mit statistik die Kennzahlen.',
    eingabe: { stweg: STWEG, id: z.number().int().optional(), statistik: z.boolean().optional() },
    async lauf(api, a) {
      if (a.id) {
        const [w, h] = await Promise.all([api('GET', `/api/wohnungen/${a.stweg}/${a.id}`), api('GET', `/api/wohnungen/${a.stweg}/${a.id}/historie`).catch(() => null)]);
        return { wohnung: w, historie: h };
      }
      if (a.statistik) return api('GET', `/api/wohnungen/${a.stweg}/stats`);
      return api('GET', `/api/wohnungen/${a.stweg}`);
    },
  },
  {
    name: 'personen_suchen', rolle: 'ausschuss', pfad: 'personen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Personen suchen',
    beschreibung: 'Stammdaten: Personen nach Name, E-Mail oder Telefon suchen. Mit id eine Person vollständig.',
    eingabe: { suche: z.string().optional(), id: z.number().int().optional() },
    async lauf(api, a) { return a.id ? api('GET', `/api/personen/${a.id}`) : api('GET', '/api/personen', { query: { search: a.suche } }); },
  },
  {
    name: 'personen_aendern', rolle: 'ausschuss', pfad: 'personen', methode: 'PUT', frei: true, nurLesen: false,
    titel: 'Person ändern',
    beschreibung: 'Stammdaten einer Person anpassen. Frei — jede Änderung ist in der Historie und umkehrbar. Nur die übergebenen Felder ändern sich.',
    eingabe: {
      id: z.number().int(), anrede: z.string().optional(), vorname: z.string().optional(), nachname: z.string().optional(),
      email: z.string().optional(), telefon: z.string().optional(), mobile: z.string().optional(), telefone: z.array(z.string()).optional(),
      adresse: z.string().optional(), geburtsdatum: z.string().optional(), notiz: z.string().optional(), review_needed: z.boolean().optional(),
    },
    async lauf(api, a) { const { id, ...felder } = a; return api('PUT', `/api/personen/${id}`, { body: felder }); },
  },
  {
    name: 'verwaltungen', rolle: 'ausschuss', pfad: 'verwaltungen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Hausverwaltungen',
    beschreibung: 'Die Hausverwaltungen je STWEG (z. B. Immosense seit 1.6.2026) und ihre Kontaktpersonen.',
    eingabe: {},
    async lauf(api) {
      const [v, k] = await Promise.all([api('GET', '/api/verwaltungen'), api('GET', '/api/verwaltungen/kontakte').catch(() => null)]);
      return { verwaltungen: v, kontakte: k };
    },
  },
  {
    name: 'reklamationen_liste', rolle: 'ausschuss', pfad: 'reklamationen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Alle Reklamationen',
    beschreibung: 'Reklamationen aller Bewohner, filterbar nach Status; mit id Verlauf und Details einer Meldung. Zum Triagieren und Zuweisen.',
    eingabe: { status: z.string().optional().describe('offen, in_arbeit, erledigt …'), archivierte: z.boolean().optional(), id: z.number().int().optional() },
    async lauf(api, a) {
      const liste = await api('GET', '/api/reklamationen', { query: { status: a.status, archiviert: a.archivierte ? 1 : undefined } });
      if (!a.id) return liste;
      const verlauf = await api('GET', `/api/reklamationen/${a.id}/history`).catch(() => null);
      const alle = Array.isArray(liste) ? liste : liste?.reklamationen || [];
      return { meldung: alle.find(r => r.id === a.id) || null, verlauf };
    },
  },
  {
    name: 'reklamation_bearbeiten', rolle: 'ausschuss', pfad: 'reklamationen', methode: 'PUT', frei: true, nurLesen: false,
    titel: 'Reklamation bearbeiten',
    beschreibung: 'Status, Kategorie, Zuweisung (Name aus der Technik), Handwerker oder Notiz setzen; mit vermerk einen Eintrag in den Verlauf schreiben. Frei — alles protokolliert und umkehrbar. Der Zugewiesene bekommt eine interne Meldung.',
    eingabe: {
      id: z.number().int(), status: z.string().optional(), kategorie: z.string().optional(), zugewiesen_an: z.string().optional(),
      handwerker_id: z.number().int().optional(), notiz: z.string().optional(), archiviert: z.boolean().optional(),
      vermerk: z.string().max(500).optional().describe('Text für den Verlauf'),
    },
    async lauf(api, a) {
      const { id, vermerk, ...felder } = a; const out = {};
      if (Object.keys(felder).length) out.aenderung = await api('PUT', `/api/reklamationen/${id}`, { body: felder });
      if (vermerk) out.verlauf = await api('POST', `/api/reklamationen/${id}/history`, { body: { text: vermerk } });
      if (!Object.keys(out).length) return fehler('Nichts angegeben.');
      return out;
    },
  },
  {
    name: 'handwerker', rolle: 'ausschuss', pfad: 'handwerker', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Handwerker & Lieferanten',
    beschreibung: 'Firmen nach Kategorie, Notfallnummern, anstehende Vertragsverlängerungen; mit id Aufträge und Verträge einer Firma.',
    eingabe: { kategorie: z.string().optional(), id: z.number().int().optional(), notfall: z.boolean().optional(), archivierte: z.boolean().optional() },
    async lauf(api, a) {
      if (a.notfall) return api('GET', '/api/handwerker-notfall');
      if (a.id) {
        const [auf, ver] = await Promise.all([api('GET', `/api/handwerker/${a.id}/aufträge`).catch(() => null), api('GET', `/api/handwerker/${a.id}/verträge`).catch(() => null)]);
        return { auftraege: auf, vertraege: ver };
      }
      const [liste, anstehend] = await Promise.all([api('GET', '/api/handwerker', { query: { kategorie: a.kategorie, include_archived: a.archivierte ? 1 : undefined } }), api('GET', '/api/handwerker-verträge/anstehend').catch(() => null)]);
      return { handwerker: liste, vertraege_anstehend: anstehend };
    },
  },
  {
    name: 'handwerker_auftrag', rolle: 'ausschuss', pfad: 'handwerker', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Auftrag erfassen',
    beschreibung: 'Einen Auftrag bei einer Firma als Datensatz erfassen (Datum, Beschreibung, Kosten). Frei — es ist ein Eintrag, keine Bestellung; die Firma erfährt davon nichts.',
    eingabe: { handwerker_id: z.number().int(), beschreibung: z.string(), datum: z.string().optional(), kosten: z.number().optional(), notiz: z.string().optional(), stweg: STWEG.optional(), vertrag_id: z.number().int().optional() },
    async lauf(api, a) { const { handwerker_id, ...b } = a; return api('POST', `/api/handwerker/${handwerker_id}/aufträge`, { body: b }); },
  },
  {
    name: 'auslagen', rolle: 'ausschuss', pfad: 'auslagen', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Auslagen & Vorschüsse',
    beschreibung: 'Auslagen nach Status, STWEG oder Projekt; mit id die Positionen und Belege einer Auslage; Stundensatz aktuell.',
    eingabe: { status: z.string().optional(), stweg: STWEG.optional(), projekt: z.string().optional(), id: z.number().int().optional() },
    async lauf(api, a) {
      if (a.id) {
        const [pos, belege] = await Promise.all([api('GET', `/api/auslagen/${a.id}/positionen`).catch(() => null), api('GET', `/api/auslagen/${a.id}/belege`).catch(() => null)]);
        return { positionen: pos, belege };
      }
      const [liste, satz] = await Promise.all([api('GET', '/api/auslagen', { query: { status: a.status, stweg: a.stweg, projekt: a.projekt } }), api('GET', '/api/auslagen-stundensatz/aktuell').catch(() => null)]);
      return { auslagen: liste, stundensatz: satz };
    },
  },
  {
    name: 'auslage_erfassen', rolle: 'ausschuss', pfad: 'auslagen', methode: 'POST', frei: true, nurLesen: false,
    titel: 'Auslage erfassen',
    beschreibung: 'Eine Auslage oder einen Vorschuss erfassen, optional mit Beleg (Base64) und Projekt. Frei — bleibt als Entwurf, bis sie freigegeben wird.',
    eingabe: {
      datum: z.string(), kategorie: z.string(), beschreibung: z.string(), betrag_chf: z.number(), stweg: STWEG.optional(),
      iban: z.string().optional(), bemerkung_eigentuemer: z.string().optional(), projekt_slug: z.string().optional(),
      beleg_base64: z.string().optional(), beleg_filename: z.string().optional(),
    },
    async lauf(api, a) { return api('POST', '/api/auslagen', { body: a }); },
  },
  {
    name: 'zev_verwalten', rolle: 'ausschuss', pfad: 'zev', methode: 'GET', frei: true, nurLesen: true,
    titel: 'ZEV verwalten',
    beschreibung: 'ZEV-Konfiguration einer STWEG, Wohnungen mit Zählern, und Rechnungen von smart-me, die noch keiner Wohnung zugeordnet sind.',
    eingabe: { stweg: STWEG },
    async lauf(api, a) {
      const [cfg, wohnungen, unzugeordnet] = await Promise.all([
        api('GET', `/api/zev/config/${a.stweg}`).catch(() => null), api('GET', `/api/zev/wohnungen/${a.stweg}`).catch(() => null), api('GET', '/api/zev/unzugeordnet').catch(() => null),
      ]);
      return { konfiguration: cfg, wohnungen, unzugeordnet };
    },
  },
  {
    name: 'zev_abgleich', rolle: 'ausschuss', pfad: 'zev', methode: 'POST', frei: true, nurLesen: false,
    titel: 'ZEV mit smart-me abgleichen',
    beschreibung: 'Rechnungen und Zählerstände einer STWEG von smart-me holen. Frei — nur lesend gegenüber smart-me, idempotent.',
    eingabe: { stweg: STWEG },
    async lauf(api, a) { return api('POST', `/api/zev/sync/${a.stweg}`); },
  },
  {
    name: 'zev_zuordnen', rolle: 'ausschuss', pfad: 'zev', methode: 'POST', frei: true, nurLesen: false,
    titel: 'ZEV-Rechnung zuordnen',
    beschreibung: 'Eine unzugeordnete Rechnung einer Wohnung und Person zuweisen. Frei — umkehrbar.',
    eingabe: { rechnung_id: z.number().int(), wohnung_id: z.number().int().optional(), bewohner_email: z.string().optional(), bewohner_name: z.string().optional() },
    async lauf(api, a) { const { rechnung_id, ...b } = a; return api('POST', `/api/zev/rechnung/${rechnung_id}/zuordnen`, { body: b }); },
  },
  {
    name: 'mail_ausgangskorb', rolle: 'ausschuss', pfad: 'verwaltung-mail-queue', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Mail-Ausgangskorb der Verwaltung',
    beschreibung: 'Mails, die auf Freigabe warten; mit id eine einzelne mit Inhalt.',
    eingabe: { id: z.number().int().optional() },
    async lauf(api, a) { return a.id ? api('GET', `/api/verwaltung-mail-queue/${a.id}`) : api('GET', '/api/verwaltung-mail-queue'); },
  },
  {
    name: 'mail_freigeben', rolle: 'ausschuss', pfad: 'verwaltung-mail-queue', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Mail freigeben oder ablehnen',
    beschreibung: 'Eine wartende Mail freigeben (sie geht dann hinaus) oder mit Grund ablehnen. Bestätigt.',
    eingabe: { id: z.number().int(), entscheid: z.enum(['freigeben', 'ablehnen']), grund: z.string().optional(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`Mail #${a.id} würde ${a.entscheid === 'freigeben' ? 'freigegeben und versendet' : 'abgelehnt' + (a.grund ? ` (Grund: ${a.grund})` : '')}.`);
      return a.entscheid === 'freigeben' ? api('POST', `/api/verwaltung-mail-queue/${a.id}/freigeben`) : api('POST', `/api/verwaltung-mail-queue/${a.id}/ablehnen`, { body: { grund: a.grund } });
    },
  },
  {
    name: 'mail_verlauf', rolle: 'ausschuss', pfad: 'email-log', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Mail-Verlauf',
    beschreibung: 'Was die Anwendung versendet hat: Empfänger, Auslöser, Zustellstatus. Filter nach Text, Zeit, Status, Auslöser.',
    eingabe: { suche: z.string().optional(), seit: z.string().optional().describe('ISO-Datum'), status: z.string().optional(), ausloeser: z.string().optional() },
    async lauf(api, a) { return api('GET', '/api/email-log', { query: { q: a.suche, since: a.seit, status: a.status, trigger: a.ausloeser } }); },
  },
  {
    name: 'mail_archiv', rolle: 'ausschuss', pfad: 'email-archive', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Mail-Archiv',
    beschreibung: 'Das Archiv der eingegangenen Post durchsuchen; mit id eine Mail vollständig.',
    eingabe: { suche: z.string().optional(), seite: z.number().int().optional(), limit: z.number().int().max(100).optional(), id: z.number().int().optional() },
    async lauf(api, a) { return a.id ? api('GET', `/api/email-archive/${a.id}`) : api('GET', '/api/email-archive', { query: { search: a.suche, page: a.seite, limit: a.limit } }); },
  },
  {
    name: 'verteiler', rolle: 'ausschuss', pfad: 'verteiler', methode: 'GET', frei: true, nurLesen: true,
    titel: 'E-Mail-Verteiler',
    beschreibung: 'Verteiler mit Mitgliedern; mit id ein einzelner.',
    eingabe: { id: z.number().int().optional() },
    async lauf(api, a) { return a.id ? api('GET', `/api/verteiler/${a.id}`) : api('GET', '/api/verteiler'); },
  },
  {
    name: 'verteiler_senden', rolle: 'ausschuss', pfad: 'verteiler', methode: 'POST', frei: false, nurLesen: false,
    titel: 'An Verteiler senden',
    beschreibung: 'Eine Mail an einen Verteiler senden — geht an alle Mitglieder hinaus. Bestätigt.',
    eingabe: { verteiler_id: z.number().int(), betreff: z.string(), text: z.string(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`An Verteiler #${a.verteiler_id}: «${a.betreff}» (${a.text.length} Zeichen) würde an alle Mitglieder gesendet.`);
      return api('POST', '/api/verteiler/send', { body: { verteiler_id: a.verteiler_id, subject: a.betreff, body: a.text } });
    },
  },
  {
    name: 'mail_schreiben', rolle: 'ausschuss', pfad: 'mail-compose', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Mail schreiben',
    beschreibung: 'Eine Ad-hoc-Mail im Namen der Verwaltung an eine Adresse oder einen Empfänger aus den Stammdaten. Bestätigt. Mit freigabe=true landet sie zuerst im Ausgangskorb statt direkt zu gehen.',
    eingabe: { an: z.string().optional(), empfaenger_id: z.number().int().optional(), betreff: z.string(), text: z.string(), cc: z.string().optional(), antwort_an: z.string().optional(), freigabe: z.boolean().optional(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.an && !a.empfaenger_id) return fehler('an oder empfaenger_id angeben.');
      if (!a.bestaetigt) return vorschau(`Mail an ${a.an || 'Empfänger #' + a.empfaenger_id}: «${a.betreff}» (${a.text.length} Zeichen)${a.freigabe ? ', zuerst in den Ausgangskorb' : ', direkt'}.`);
      return api('POST', '/api/mail-compose', { body: { mail_to: a.an, empfaenger_id: a.empfaenger_id, subject: a.betreff, body_text: a.text, mail_cc: a.cc, mail_reply_to: a.antwort_an, requires_approval: !!a.freigabe } });
    },
  },
  {
    name: 'mail_vorlagen', rolle: 'ausschuss', pfad: 'mail-templates', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Mail-Vorlagen',
    beschreibung: 'Die Vorlagen der Verwaltung und die Empfänger-Stammdaten.',
    eingabe: {},
    async lauf(api) {
      const [t, e] = await Promise.all([api('GET', '/api/mail-templates'), api('GET', '/api/mail-empfänger').catch(() => null)]);
      return { vorlagen: t, empfaenger: e };
    },
  },
  {
    name: 'briefe', rolle: 'ausschuss', pfad: 'briefe', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Brief-Tracking',
    beschreibung: 'Versandte Briefe und ihr Stand.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/briefe'); },
  },
  {
    name: 'wasch_abrechnung', rolle: 'ausschuss', pfad: 'wasch', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Waschküche: Abrechnung',
    beschreibung: 'Abrechnungsläufe, Kosten, Statistik und Waschgänge aller Bewohner.',
    eingabe: {},
    async lauf(api) {
      const [b, s, st] = await Promise.all([api('GET', '/api/wasch/admin/billing'), api('GET', '/api/wasch/admin/stats').catch(() => null), api('GET', '/api/wasch/admin/costs').catch(() => null)]);
      return { abrechnungen: b, statistik: s, kosten: st };
    },
  },
  {
    name: 'wasch_abrechnung_starten', rolle: 'ausschuss', pfad: 'wasch', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Abrechnungslauf starten',
    beschreibung: 'Den Abrechnungslauf der Waschküche jetzt ausführen (läuft sonst am 1. um 08:00). Bestätigt — erzeugt Rechnungen.',
    eingabe: { bestaetigt: z.boolean().optional() },
    async lauf(api, a) { return a.bestaetigt ? api('POST', '/api/wasch/admin/billing/run') : vorschau('Der Abrechnungslauf würde jetzt gestartet und Rechnungen erzeugen.'); },
  },
  {
    name: 'zutritt_admin', rolle: 'ausschuss', pfad: 'access', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Zutritt: Türen, Personen, Protokoll',
    beschreibung: 'Türen mit Berechtigungen, Zutrittsbenutzer, Besucher und das Protokoll.',
    eingabe: { was: z.enum(['tueren', 'personen', 'besucher', 'protokoll']).optional() },
    async lauf(api, a) {
      const pfad = { tueren: '/api/access/doors', personen: '/api/access/users', besucher: '/api/access/visitors', protokoll: '/api/access/logs' }[a.was || 'tueren'];
      return api('GET', pfad);
    },
  },
  {
    name: 'zutritt_tuer_oeffnen_admin', rolle: 'ausschuss', pfad: 'access', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Tür öffnen (Verwaltung)',
    beschreibung: 'Eine beliebige Tür der Siedlung öffnen. Bestätigt — physische Wirkung.',
    eingabe: { tuer_id: z.string(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) { return a.bestaetigt ? api('POST', `/api/access/doors/${encodeURIComponent(a.tuer_id)}/unlock`) : vorschau(`Tür ${a.tuer_id} würde geöffnet.`); },
  },
  {
    name: 'benutzer', rolle: 'ausschuss', pfad: 'admin', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Benutzerkonten und Gruppen',
    beschreibung: 'Bewohnerkonten (Authentik) und Gruppen; mit gruppe die Mitglieder einer Gruppe.',
    eingabe: { gruppe: z.string().optional() },
    async lauf(api, a) {
      if (a.gruppe) return api('GET', `/api/admin/groups/${encodeURIComponent(a.gruppe)}`);
      const [u, g] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/groups').catch(() => null)]);
      return { benutzer: u, gruppen: g };
    },
  },
  {
    name: 'benutzer_gruppe', rolle: 'ausschuss', pfad: 'admin', methode: 'PUT', frei: false, nurLesen: false,
    titel: 'Gruppenmitgliedschaft ändern',
    beschreibung: 'Eine Person in eine Gruppe aufnehmen oder entfernen — Gruppen sind Rechte. Bestätigt.',
    eingabe: { gruppe: z.string(), benutzer_pk: z.number().int(), aktion: z.enum(['aufnehmen', 'entfernen']), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`Benutzer ${a.benutzer_pk} würde ${a.aktion === 'aufnehmen' ? 'in' : 'aus'} Gruppe ${a.gruppe} ${a.aktion}.`);
      return api('PUT', `/api/admin/groups/${encodeURIComponent(a.gruppe)}/${a.aktion === 'aufnehmen' ? 'add_user' : 'remove_user'}`, { body: { pk: a.benutzer_pk } });
    },
  },
  {
    name: 'stweg_termin', rolle: 'ausschuss', pfad: 'stweg', methode: 'POST', frei: true, nurLesen: false,
    titel: 'STWEG-Termin eintragen',
    beschreibung: 'Einen Termin auf der STWEG-Seite eintragen (Versammlung, Reinigung, Sperrung). Frei — löschbar.',
    eingabe: { stweg: STWEG, titel: z.string(), beginn: z.string(), ende: z.string().optional(), ganztags: z.boolean().optional(), ort: z.string().optional(), beschreibung: z.string().optional(), kategorie: z.string().optional() },
    async lauf(api, a) { return api('POST', `/api/stweg/${a.stweg}/events`, { body: { title: a.titel, description: a.beschreibung, start_date: a.beginn, end_date: a.ende, all_day: a.ganztags, location: a.ort, category: a.kategorie } }); },
  },
  {
    name: 'whatsapp_status', rolle: 'ausschuss', pfad: 'whatsapp', methode: 'GET', frei: true, nurLesen: true,
    titel: 'WhatsApp: Status, Gruppen, Empfänger',
    beschreibung: 'Ob der Bot gekoppelt ist, welche Gruppen er kennt und wer Meldungen erhält.',
    eingabe: {},
    async lauf(api) {
      const [s, g, r] = await Promise.all([api('GET', '/api/whatsapp/admin/status'), api('GET', '/api/whatsapp/admin/groups').catch(() => null), api('GET', '/api/whatsapp/admin/recipients').catch(() => null)]);
      return { status: s, gruppen: g, empfaenger: r };
    },
  },
  {
    name: 'whatsapp_senden', rolle: 'ausschuss', pfad: 'whatsapp', methode: 'POST', frei: false, nurLesen: false,
    titel: 'WhatsApp senden',
    beschreibung: 'Eine Nachricht an eine Nummer oder einen Rundruf an eine Gruppe/Zielgruppe. Bestätigt — geht nach draussen.',
    eingabe: { text: z.string().min(1), nummer: z.string().optional().describe('Einzelne Nummer, international'), ziel: z.string().optional().describe('Rundruf-Ziel: Gruppen-ID oder Zielgruppe'), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.nummer && !a.ziel) return fehler('nummer oder ziel angeben.');
      if (!a.bestaetigt) return vorschau(`WhatsApp an ${a.nummer || 'Rundruf ' + a.ziel}: «${a.text.slice(0, 200)}»`);
      return a.nummer ? api('POST', '/api/whatsapp/admin/send', { body: { phone: a.nummer, body: a.text } }) : api('POST', '/api/whatsapp/admin/broadcast', { body: { target: a.ziel, body: a.text } });
    },
  },
  {
    name: 'telefonanlage', rolle: 'ausschuss', pfad: 'pbx', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Telefonanlage',
    beschreibung: 'Letzte Anrufe, Klingelgruppe, Öffnungszeiten-Konfiguration, Trunk-Status.',
    eingabe: { anrufe_limit: z.number().int().max(200).optional() },
    async lauf(api, a) {
      const [c, r, k, t] = await Promise.all([
        api('GET', '/api/pbx/calls', { query: { limit: a.anrufe_limit } }), api('GET', '/api/pbx/ring-members').catch(() => null),
        api('GET', '/api/pbx/config').catch(() => null), api('GET', '/api/pbx/trunk-status').catch(() => null),
      ]);
      return { anrufe: c, klingelgruppe: r, konfiguration: k, trunk: t };
    },
  },
  {
    name: 'pbx_testanruf', rolle: 'ausschuss', pfad: 'pbx', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Testanruf auslösen',
    beschreibung: 'Die Anlage ruft eine Nummer an. Bestätigt — ein Telefon klingelt wirklich.',
    eingabe: { nummer: z.string(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) { return a.bestaetigt ? api('POST', '/api/pbx/test-call', { body: { phone: a.nummer } }) : vorschau(`${a.nummer} würde angerufen.`); },
  },
  {
    name: 'isp_antraege', rolle: 'ausschuss', pfad: 'isp', methode: 'GET', frei: true, nurLesen: true,
    titel: 'ISP: Anträge und Störungen',
    beschreibung: 'Offene Postfach- und VLAN-Anträge sowie aktuelle und geplante Störungen.',
    eingabe: {},
    async lauf(api) {
      const [m, v, s] = await Promise.all([api('GET', '/api/isp/mailbox-requests'), api('GET', '/api/isp/vlan-requests').catch(() => null), api('GET', '/api/isp/maintenance').catch(() => null)]);
      return { postfach_antraege: m, vlan_antraege: v, stoerungen: s };
    },
  },
  {
    name: 'isp_antrag_entscheiden', rolle: 'ausschuss', pfad: 'isp', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Postfach-Antrag entscheiden',
    beschreibung: 'Einen Postfach-Antrag genehmigen (legt das Postfach an) oder mit Grund ablehnen. Bestätigt.',
    eingabe: { id: z.number().int(), entscheid: z.enum(['genehmigen', 'ablehnen']), grund: z.string().optional(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`Antrag #${a.id} würde ${a.entscheid === 'genehmigen' ? 'genehmigt und das Postfach angelegt' : 'abgelehnt'}.`);
      return a.entscheid === 'genehmigen' ? api('POST', `/api/isp/mailbox-requests/${a.id}/approve`) : api('POST', `/api/isp/mailbox-requests/${a.id}/reject`, { body: { reason: a.grund } });
    },
  },
  {
    name: 'stoerung_anlegen', rolle: 'ausschuss', pfad: 'isp', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Störung / Wartung ankündigen',
    beschreibung: 'Eine Störung oder geplante Wartung anlegen, optional mit Benachrichtigung per Mail und WhatsApp an die Betroffenen. Bestätigt, weil Benachrichtigungen hinausgehen.',
    eingabe: {
      titel: z.string(), beschreibung: z.string().optional(), schwere: z.string().optional().describe('info, minor, major, critical'),
      beginn: z.string().optional(), ende: z.string().optional(), alle: z.boolean().optional().describe('alle Bewohner'), haeuser: z.array(z.number().int()).optional(), vlans: z.array(z.number().int()).optional(),
      mail: z.boolean().optional(), whatsapp: z.boolean().optional(), bestaetigt: z.boolean().optional(),
    },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`Störung «${a.titel}» (${a.schwere || 'info'}) ${a.beginn ? 'ab ' + a.beginn : ''}${a.mail || a.whatsapp ? ' — mit Benachrichtigung' : ''}.`);
      return api('POST', '/api/isp/maintenance', { body: { title: a.titel, description: a.beschreibung, severity: a.schwere, start_at: a.beginn, end_at: a.ende, scope: { all: !!a.alle, houses: a.haeuser, vlans: a.vlans }, notify_email: !!a.mail, notify_whatsapp: !!a.whatsapp } });
    },
  },
  {
    name: 'rechte', rolle: 'ausschuss', pfad: 'permissions', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Rechte',
    beschreibung: 'Wer darf welche Seite — die Rechtematrix und die Seitenliste.',
    eingabe: {},
    async lauf(api) {
      const [p, s] = await Promise.all([api('GET', '/api/permissions'), api('GET', '/api/permissions/pages').catch(() => null)]);
      return { rechte: p, seiten: s };
    },
  },

  // ── Technik ─────────────────────────────────────────────────────────
  {
    name: 'noc', rolle: 'technik', pfad: 'isp', methode: 'GET', frei: true, nurLesen: true,
    titel: 'NOC',
    beschreibung: 'Der Wandbildschirm als Daten: Dienste, Container, Netz, Zähler, Nextcloud — was rot ist.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/isp/noc/dashboard'); },
  },
  {
    name: 'dienstwacht', rolle: 'technik', pfad: 'ssh', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Dienstwacht',
    beschreibung: 'Fehlgeschlagene und hängende Dienste je Knoten und Container, wie von rw-dienstwacht gemeldet.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/ssh/dienste'); },
  },
  {
    name: 'ssh_matrix', rolle: 'technik', pfad: 'ssh', methode: 'GET', frei: true, nurLesen: true,
    titel: 'SSH-Hosts und Zugriffsmatrix',
    beschreibung: 'Registrierte Hosts, wer wohin darf, laufende Stations-Sitzungen.',
    eingabe: {},
    async lauf(api) {
      const [h, m, s] = await Promise.all([api('GET', '/api/ssh/hosts'), api('GET', '/api/ssh/matrix').catch(() => null), api('GET', '/api/ssh/sitzungen').catch(() => null)]);
      return { hosts: h, matrix: m, sitzungen: s };
    },
  },
  {
    name: 'stationen', rolle: 'technik', pfad: 'stations', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Stationen',
    beschreibung: 'Registrierte Stationen und Laptops; mit id Protokolle und Ereignisse einer Station.',
    eingabe: { id: z.string().optional() },
    async lauf(api, a) {
      if (!a.id) return api('GET', '/api/stations/admin/list');
      const [l, e] = await Promise.all([api('GET', `/api/stations/admin/${encodeURIComponent(a.id)}/logs`).catch(() => null), api('GET', `/api/stations/admin/${encodeURIComponent(a.id)}/events`).catch(() => null)]);
      return { protokolle: l, ereignisse: e };
    },
  },
  {
    name: 'pve_meldungen', rolle: 'technik', pfad: 'pve-messages', methode: 'GET', frei: true, nurLesen: false,
    titel: 'Meldungen der Proxmox-Hosts',
    beschreibung: 'Meldungen, die die PVE-Hosts an die Anwendung schicken; mit gelesen=true werden die ungelesenen quittiert. Frei.',
    eingabe: { nur_ungelesene: z.boolean().optional(), gelesen: z.boolean().optional() },
    async lauf(api, a) {
      const m = await api('GET', '/api/pve-messages', { query: { unread: a.nur_ungelesene ? 1 : undefined } });
      if (a.gelesen) await api('POST', '/api/pve-messages/read', { body: {} });
      return m;
    },
  },
  {
    name: 'whatsapp_kopplung', rolle: 'technik', pfad: 'whatsapp', methode: 'GET', frei: true, nurLesen: true,
    titel: 'WhatsApp-Kopplung',
    beschreibung: 'Ob der Bot gekoppelt ist oder auf einen QR-Scan wartet. Das Bild liegt unter /api/whatsapp/qr.png im Portal.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/whatsapp/qr-status'); },
  },
  {
    name: 'zaehler_technik', rolle: 'technik', pfad: 'zaehler-technik', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Zähler (Technik)',
    beschreibung: 'Alle Zähler mit Zustand und Frische, dazu die MQTT-Zählerliste.',
    eingabe: {},
    async lauf(api) {
      const [z1, z2] = await Promise.all([api('GET', '/api/zaehler-technik'), api('GET', '/api/mqtt/meters').catch(() => null)]);
      return { zaehler: z1, mqtt: z2 };
    },
  },
  {
    name: 'proxmox', rolle: 'technik', pfad: 'proxmox', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Proxmox-Ressourcen',
    beschreibung: 'Knoten, Container und VMs mit Zustand, wie Proxmox sie meldet.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/proxmox/resources'); },
  },
  {
    name: 'loeschungen', rolle: 'technik', pfad: 'admin', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Konto-Löschungen',
    beschreibung: 'Anstehende Konto-Löschungen mit Frist.',
    eingabe: {},
    async lauf(api) { return api('GET', '/api/admin/pending-deletions'); },
  },
  {
    name: 'anzeige', rolle: 'technik', pfad: 'display', methode: 'GET', frei: true, nurLesen: true,
    titel: 'Anzeigen (Displays)',
    beschreibung: 'Zustand der Displays und laufende Ankündigungen.',
    eingabe: {},
    async lauf(api) {
      const [s, a] = await Promise.all([api('GET', '/api/display/state'), api('GET', '/api/display/ankuendigungen').catch(() => null)]);
      return { zustand: s, ankuendigungen: a };
    },
  },
  {
    name: 'anzeige_ankuendigen', rolle: 'technik', pfad: 'display', methode: 'POST', frei: false, nurLesen: false,
    titel: 'Ankündigung auf die Displays',
    beschreibung: 'Einen Text auf den Displays der Siedlung anzeigen. Bestätigt — alle sehen es.',
    eingabe: { text: z.string(), kanal: z.string().optional(), laufschrift: z.boolean().optional(), aktiv: z.boolean().optional(), bestaetigt: z.boolean().optional() },
    async lauf(api, a) {
      if (!a.bestaetigt) return vorschau(`Auf den Displays erschiene: «${a.text.slice(0, 200)}»`);
      return api('POST', '/api/display/announce', { body: { text: a.text, channel: a.kanal, scroll: a.laufschrift, active: a.aktiv !== false } });
    },
  },
];

module.exports = { WERKZEUGE_VERWALTUNG };
