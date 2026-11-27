/**
 * Hilfe-Seite: Anleitungen als PDF (Befund H1, Entscheid Stefan 27.11.2026).
 *
 * Die PDFs liegen im Dokumenten-Repo unter allgemein/anleitungen/<gruppe>/ und
 * technik/anleitungen/ (nur Technik/Präsident lesbar). hilfe.html zeigt oben
 * eine Kachelreihe je Gruppe und in jedem Abschnitt eine Zeile
 * „Schritt für Schritt: PDF öffnen“. Geöffnet wird über downloadDoc() der
 * Hilfe-Seite (Dokumenten-API, braucht die Anmeldung).
 *
 * Neue Anleitung: Datei hier in ANLEITUNGEN eintragen, bei Bedarf dem
 * Abschnitt in ABSCHNITT_PDF zuordnen. Der Test api/test/hilfe-anleitungen.test.js
 * prüft, dass jeder Abschnitt in hilfe.html existiert.
 */
const ANLEITUNGEN = {
  bewohner: {
    titel: 'Für Bewohner',
    ordner: 'allgemein/anleitungen/bewohner/',
    dateien: {
      'rosenweg-konto-anmelden.pdf': 'Mit dem Rosenweg-Konto anmelden',
      'rosenweg-karte-anmelden.pdf': 'Anmelden mit der Rosenweg-Karte',
      'rosenweg-apps-installieren.pdf': 'Rosenweg-Apps installieren',
      'wlan-verbinden.pdf': 'Ins WLAN im Haus',
      'schaden-melden.pdf': 'Schaden melden',
      'mein-telefon.pdf': 'Mein Telefon',
      'geteilte-telefone-benutzen.pdf': 'Geteilte Telefone im Haus',
      'telefonbuch.pdf': 'Telefonbuch der Siedlung',
      'mein-profil.pdf': 'Mein Profil',
      'whatsapp-benachrichtigungen.pdf': 'WhatsApp-Benachrichtigungen',
      'dokumente-finden.pdf': 'Dokumente finden',
      'scannen-in-den-persoenlichen-ordner.pdf': 'Scannen in den persönlichen Ordner',
      'computer-im-haus.pdf': 'Computer im Haus',
      'waschkueche-reservieren.pdf': 'Waschküche reservieren',
      'vollmacht-erteilen.pdf': 'Vollmacht erteilen',
      'terminumfragen.pdf': 'Terminumfragen',
      'tv-fernsehen.pdf': 'Fernsehen',
      'internet-mein-zugang.pdf': 'Internet – Mein Zugang',
      'salzvorrat.pdf': 'Salzvorrat',
      'zutritt-tueren-karten.pdf': 'Türen, Karten und Kennzeichen',
      'qr-codes-im-haus.pdf': 'QR-Codes im Haus',
      'rosenweg-9-strom-heizung.pdf': 'Rosenweg 9: Strom, Zähler, Heizung',
      'fuer-eigentuemer.pdf': 'Für Eigentümer: Projekte und Grundbuch',
    },
  },
  ausschuss: {
    titel: 'Für Ausschuss, Technik, Präsident',
    ordner: 'allgemein/anleitungen/ausschuss-technik-praesident/',
    dateien: {
      'ueberblick-ausschuss-technik.pdf': 'Überblick',
      'wohnungen-und-kontakte-pflegen.pdf': 'Wohnungen und Kontakte pflegen',
      'personen-stammdaten.pdf': 'Personen (Stammdaten)',
      'konto-fuer-bewohner-anlegen.pdf': 'Konto für Bewohner anlegen',
      'reklamationen-bearbeiten.pdf': 'Reklamationen bearbeiten',
      'tuerschilder-und-aushaenge.pdf': 'Türschilder und Aushänge',
      'handwerker-und-lieferanten.pdf': 'Handwerker und Lieferanten',
      'auslagen.pdf': 'Auslagen',
      'projekte-pflegen.pdf': 'Projekte pflegen',
      'vollmachten-verwalten.pdf': 'Vollmachten verwalten',
      'unterschriftenlisten.pdf': 'Unterschriftenlisten und Rückläufe',
      'mails-schreiben-und-freigeben.pdf': 'Mails schreiben und freigeben',
      'mail-archiv-und-empfaenger.pdf': 'Mail-Archiv und Empfänger',
      'hausverwaltung-und-briefe.pdf': 'Hausverwaltung und Briefe',
      'dokumente-hochladen-und-ordnen.pdf': 'Dokumente hochladen und ordnen',
      'stweg-seite-bearbeiten.pdf': 'STWEG-Seite bearbeiten',
      'terminumfragen.pdf': 'Terminumfragen',
      'zev-rechnungen-zuordnen.pdf': 'ZEV-Stromrechnungen zuordnen (Rosenweg 9)',
      'meg-einstellplaetze-verwalten.pdf': 'MEG: Einstellplätze verwalten',
      'rosenweg-konto-anmelden.pdf': 'Mit dem Rosenweg-Konto anmelden',
      'rosenweg-karte-anmelden.pdf': 'Anmelden mit der Rosenweg-Karte',
    },
  },
  hausverwaltung: {
    titel: 'Für die Hausverwaltung',
    ordner: 'allgemein/anleitungen/hausverwaltung/',
    dateien: {
      'hausverwaltung-ueberblick.pdf': 'Überblick',
      'rosenweg-konto-anmelden.pdf': 'Mit dem Rosenweg-Konto anmelden',
      'objektverwaltung-felder-und-knoepfe.pdf': 'Objektverwaltung: Felder und Knöpfe',
      'wohnungen-und-kontakte-pflegen.pdf': 'Wohnungen und Kontakte pflegen',
      'reklamationen-bearbeiten.pdf': 'Reklamationen bearbeiten',
      'handwerker-und-lieferanten.pdf': 'Handwerker und Lieferanten',
      'auslagen.pdf': 'Auslagen',
      'projekte-pflegen.pdf': 'Projekte pflegen',
      'vollmachten-verwalten.pdf': 'Vollmachten verwalten',
      'unterschriftenlisten.pdf': 'Unterschriftenlisten und Rückläufe',
    },
  },
  technik: {
    titel: 'Für Technik und Präsident',
    ordner: 'technik/anleitungen/',
    nurGruppen: 'technik,praesident',
    dateien: {
      'rechte-und-kontoloeschungen.pdf': 'Rechte und Konto-Löschungen',
      'stationen-verwalten.pdf': 'Stationen',
      'smartphones-verwalten.pdf': 'Smartphones',
      'telefonanlage-verwalten.pdf': 'Telefonanlage',
      'whatsapp-gateway.pdf': 'WhatsApp-Gateway',
      'mail-betrieb.pdf': 'Mail-Betrieb',
      'proxmox-und-ssh-zugang.pdf': 'Proxmox und SSH-Zugang',
      'sicherungen.pdf': 'Sicherungen',
      'scanner-konten.pdf': 'Scanner-Konten',
      'isp-verwalten-und-noc.pdf': 'ISP und NOC',
      'zaehler-und-mqtt-verwalten.pdf': 'Zähler und MQTT',
      'haustechnik-verwalten.pdf': 'Haustechnik',
      'anzeigen-und-ankuendigungen.pdf': 'Anzeigen und Ankündigungen',
      'windows-domain-join.pdf': 'Windows-PC der Domäne beitreten',
    },
  },
};

// Abschnitt (id in hilfe.html) -> PDFs als [gruppe, datei]
const ABSCHNITT_PDF = {
  'anmelden': [['bewohner', 'rosenweg-konto-anmelden.pdf'], ['bewohner', 'rosenweg-karte-anmelden.pdf']],
  'passwort': [['bewohner', 'rosenweg-konto-anmelden.pdf']],
  'waschküche': [['bewohner', 'waschkueche-reservieren.pdf']],
  'dokumente': [['bewohner', 'dokumente-finden.pdf'], ['ausschuss', 'dokumente-hochladen-und-ordnen.pdf']],
  'energie': [['bewohner', 'rosenweg-9-strom-heizung.pdf'], ['ausschuss', 'zev-rechnungen-zuordnen.pdf']],
  'wlan': [['bewohner', 'wlan-verbinden.pdf']],
  'kontakte-sync': [['bewohner', 'telefonbuch.pdf']],
  'verwaltung': [['hausverwaltung', 'objektverwaltung-felder-und-knoepfe.pdf'], ['ausschuss', 'wohnungen-und-kontakte-pflegen.pdf']],
  'profil': [['bewohner', 'mein-profil.pdf']],
  'whatsapp': [['bewohner', 'whatsapp-benachrichtigungen.pdf']],
  'telefonbuch': [['bewohner', 'telefonbuch.pdf'], ['bewohner', 'mein-telefon.pdf']],
  'reklamationen': [['bewohner', 'schaden-melden.pdf'], ['ausschuss', 'reklamationen-bearbeiten.pdf']],
  'auslagen': [['ausschuss', 'auslagen.pdf']],
  'vollmachten': [['bewohner', 'vollmacht-erteilen.pdf'], ['ausschuss', 'vollmachten-verwalten.pdf']],
  'handwerker': [['ausschuss', 'handwerker-und-lieferanten.pdf']],
  'mein-zugang': [['bewohner', 'internet-mein-zugang.pdf']],
  'projekte': [['bewohner', 'fuer-eigentuemer.pdf'], ['ausschuss', 'projekte-pflegen.pdf']],
  'doodle': [['bewohner', 'terminumfragen.pdf']],
  'brief-tracking': [['ausschuss', 'hausverwaltung-und-briefe.pdf']],
  'email-verteiler': [['hausverwaltung', 'hausverwaltung-ueberblick.pdf'], ['ausschuss', 'mails-schreiben-und-freigeben.pdf']],
  'zutritt': [['bewohner', 'zutritt-tueren-karten.pdf']],
  'berechtigungen': [['technik', 'rechte-und-kontoloeschungen.pdf']],
  'loeschungen': [['technik', 'rechte-und-kontoloeschungen.pdf']],
};

const HilfeAnleitungen = {
  _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
  _pfad(gruppe, datei) { return ANLEITUNGEN[gruppe].ordner + datei; },
  _knopf(gruppe, datei) {
    const g = ANLEITUNGEN[gruppe];
    const nur = g.nurGruppen ? ` data-perm-any="${g.nurGruppen}"` : '';
    return `<button type="button"${nur} data-pdf="${this._esc(this._pfad(gruppe, datei))}" class="rw-pdf inline-flex items-center gap-1 bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 px-3 py-1 rounded-lg text-xs font-medium">📄 ${this._esc(g.dateien[datei] || datei)}</button>`;
  },
  // Kachelreihe oben: je Gruppe ein aufklappbarer Block mit allen PDFs.
  kacheln(el) {
    if (!el) return;
    el.innerHTML = Object.entries(ANLEITUNGEN).map(([k, g]) => `
      <details class="bg-white rounded-lg border p-3"${g.nurGruppen ? ` data-perm-any="${g.nurGruppen}"` : ''}>
        <summary class="cursor-pointer text-sm font-semibold text-gray-700">📄 ${this._esc(g.titel)}</summary>
        <div class="flex flex-wrap gap-2 mt-3">${Object.keys(g.dateien).map(d => this._knopf(k, d)).join('')}</div>
      </details>`).join('');
  },
  // In jedem zugeordneten Abschnitt eine Zeile „Schritt für Schritt: PDF öffnen“.
  abschnitte(doc) {
    for (const [id, liste] of Object.entries(ABSCHNITT_PDF)) {
      const sec = doc.getElementById(id);
      // Inhalt = zweites <div> der Section (p-6 oder p-8), nach dem farbigen Kopf.
      const body = sec && sec.querySelector(':scope > div.p-6, :scope > div.p-8');
      if (!body) continue;
      const zeile = doc.createElement('div');
      zeile.className = 'rw-pdf-zeile flex flex-wrap items-center gap-2 text-sm text-gray-600';
      zeile.innerHTML = '<span class="font-medium">Schritt für Schritt:</span>' + liste.map(([g, d]) => this._knopf(g, d)).join('');
      body.insertBefore(zeile, body.firstChild);
    }
  },
  init(doc) {
    this.kacheln(doc.getElementById('anleitungen-pdf'));
    this.abschnitte(doc);
    doc.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button.rw-pdf');
      if (b && typeof window.downloadDoc === 'function') window.downloadDoc(b.dataset.pdf);
    });
  },
};

if (typeof window !== 'undefined') window.HilfeAnleitungen = HilfeAnleitungen;
