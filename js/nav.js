/**
 * Shared Navigation Component for Rosenweg Website
 * Loads STWEG data from /site-config.json (single source of truth)
 * Include via: <script src="/js/nav.js"></script>
 * Then call: RosenwegNav.init({ active: 'services' })
 */
// Services-Menu: kategorisierte Gruppen. Wird identisch für Desktop-Mega-Menu
// und Mobile-Akkordion gerendert. Permissions: perm = data-perm, permAny = data-perm-any.
const SERVICES_GROUPS = [
  {
    title: 'Verwaltung & Objekte',
    icon: '🏠',
    items: [
      { label: 'Objektverwaltung', href: 'objektverwaltung.html', activeKey: 'verwaltung', permAny: 'wohnungsverwaltung,bewohner-verwaltung,verwaltung' },
      { label: 'Personen (Stammdaten)', href: 'personen.html', activeKey: 'personen', permAny: 'wohnungsverwaltung' },
      { label: 'Grundbuch erfassen', href: 'grundbuch.html', activeKey: 'grundbuch', permAny: 'eigentuemer' },
      { label: 'Verwaltung', href: 'verwaltung-admin.html', activeKey: 'verwaltungadmin', permAny: 'ausschuss,technik,praesident' },
      { label: 'Brief-Tracking', href: 'brief-tracking.html', activeKey: 'brief-tracking', permAny: 'ausschuss,technik,praesident' },
      { label: 'Vollmachten', href: 'vollmachten.html', activeKey: 'vollmachten', permAny: 'eigentuemer,ausschuss,technik,praesident,verwaltung,bewohner' },
    ],
  },
  {
    title: 'E-Mail',
    icon: '✉',
    items: [
      { label: 'E-Mail-Verteiler', href: 'email-verteiler.html', activeKey: 'verteiler', perm: 'email-verteiler' },
      { label: 'E-Mail-Archiv', href: 'email-archiv.html', activeKey: 'archiv', perm: 'email-archiv' },
      { label: 'E-Mail-Log', href: 'email-log.html', activeKey: 'emaillog', permAny: 'technik,praesident,ausschuss' },
    ],
  },
  {
    title: 'Mail-Outbox (Genehmigung)',
    icon: '🟡',
    items: [
      { label: 'Mail Outbox', href: 'verwaltung-mail-outbox.html', activeKey: 'verwaltung-mail-outbox', permAny: 'technik,praesident', badgeIds: ['nav-vmq-badge', 'nav-vmq-badge-mobile'] },
      { label: 'Mail schreiben (Ad-hoc)', href: 'mail-compose.html', activeKey: 'mail-compose', perm: 'mail-compose' },
      { label: 'Empfänger-Stammdaten', href: 'mail-empfaenger-admin.html', activeKey: 'mail-empfänger', perm: 'mail-empfänger' },
      { label: 'Freigabe-Regeln', href: 'mail-approval-config.html', activeKey: 'mail-approval-config', permAny: 'technik,praesident' },
      { label: 'Templates', href: 'mail-templates.html', activeKey: 'mail-templates', permAny: 'technik,praesident' },
    ],
  },
  {
    title: 'WhatsApp & Meldungen',
    icon: '💬',
    items: [
      { label: 'WhatsApp', href: 'https://whatsapp.rosenweg4303.ch/', activeKey: 'whatsapp-bot', perm: 'whatsapp-bot' },
      { label: 'PBX (Telefonanlage)', href: 'https://pbx.rosenweg4303.ch', activeKey: 'pbx-admin', perm: 'pbx-admin' },
      { label: 'Reklamationen', href: 'reklamationen.html', activeKey: 'reklamationen', perm: 'reklamationen' },
    ],
  },
  {
    title: 'Betrieb & Admin',
    icon: '⚙',
    items: [
      { label: 'Energie-Monitor', href: 'energie-monitor.html', activeKey: 'energie', perm: 'energie-monitor' },
      { label: 'Zähler & Verbrauch', href: 'zaehler.html', activeKey: 'zähler', perm: 'zähler' },
      { label: 'Auslagen / Vorschüsse', href: 'auslagen.html', activeKey: 'auslagen', perm: 'auslagen' },
      { label: 'Stundensatz (Auslagen)', href: 'auslagen-stundensatz.html', activeKey: 'auslagen-stundensatz', perm: 'auslagen-stundensatz' },
      { label: 'Handwerker & Lieferanten', href: 'handwerker.html', activeKey: 'handwerker', perm: 'handwerker' },
      { label: 'Proxmox', href: 'proxmox-verwaltung.html', activeKey: 'proxmox', perm: 'proxmox-verwaltung' },
      { label: 'Konto-Loeschungen', href: 'loeschungen.html', activeKey: 'loeschungen', perm: 'loeschungen' },
    ],
  },
];

const RosenwegNav = {
  _config: null,

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  _renderServiceItem(item, base, active, isMobile) {
    const permAttr = item.perm
      ? `data-perm="${this._esc(item.perm)}"`
      : item.permAny ? `data-perm-any="${this._esc(item.permAny)}"` : '';
    const activeClass = active === item.activeKey
      ? (isMobile ? 'bg-blue-50 text-blue-700 font-medium' : 'bg-blue-50 text-blue-600')
      : 'text-gray-700 hover:bg-gray-50 hover:text-blue-600';
    const cls = isMobile
      ? `block px-3 py-2 rounded text-sm ${activeClass}`
      : `block px-3 py-1.5 rounded text-sm ${activeClass}`;
    const badge = (item.badgeIds || []).length > 0
      ? `<span id="${item.badgeIds[isMobile ? 1 : 0] || item.badgeIds[0]}" class="hidden bg-amber-100 text-amber-800 text-xs px-1.5 py-0.5 rounded-full font-semibold ml-2"></span>`
      : '';
    const flex = badge ? 'flex items-center justify-between' : '';
    return `<a href="${base}${item.href}" ${permAttr} class="${cls} ${flex}"><span>${this._esc(item.label)}</span>${badge}</a>`;
  },

  _renderServicesMegaMenu(active, base) {
    const cols = SERVICES_GROUPS.map(g => `
      <div class="nav-mega-col" data-mega-col="${this._esc(g.title)}">
        <h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-3 flex items-center gap-1.5">
          <span class="text-base">${g.icon}</span>${this._esc(g.title)}
        </h3>
        <div class="space-y-0.5">
          ${g.items.map(it => this._renderServiceItem(it, base, active, false)).join('\n          ')}
        </div>
      </div>`).join('');
    return `
      <div class="nav-dropdown-menu hidden absolute left-0 mt-1 bg-white rounded-xl shadow-2xl border border-gray-200 p-5 z-50" style="width: min(1100px, calc(100vw - 2rem));">
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
          ${cols}
        </div>
      </div>`;
  },

  _renderServicesMobile(active, base) {
    return SERVICES_GROUPS.map((g, i) => `
      <details class="nav-mobile-group" data-mobile-group="${this._esc(g.title)}"${i === 0 ? ' open' : ''}>
        <summary class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase cursor-pointer flex items-center gap-1.5 hover:bg-gray-50 rounded">
          <span>${g.icon}</span>${this._esc(g.title)}
        </summary>
        <div class="pl-2 space-y-0.5">
          ${g.items.map(it => this._renderServiceItem(it, base, active, true)).join('\n          ')}
        </div>
      </details>`).join('');
  },

  async init(opts = {}) {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const active = opts.active || '';
    const basePath = opts.basePath || this._detectBasePath();

    // Audience-Subdomains (admin./ausschuss.rosenweg4303.ch): fokussierte Nav,
    // Seiten-Zuordnung live aus den Zugriffsrechten (/api/nav/audience-map).
    const host = (typeof window !== 'undefined' && window.location.hostname) || '';
    const audience = host === 'admin.rosenweg4303.ch' ? 'admin'
      : host === 'ausschuss.rosenweg4303.ch' ? 'ausschuss' : null;
    if (audience) {
      let map = {};
      try { const r = await fetch('/api/nav/audience-map'); if (r.ok) map = await r.json(); } catch {}
      nav.innerHTML = this._renderAudience(audience, map, active);
      this._setupDropdowns();
      this._setupAuth(basePath);
      this._publishNavHeight(nav);
      return;
    }

    // Satelliten-Subdomains (z.B. mqtt.rosenweg4303.ch) setzen window.__NAV_BASE__,
    // damit Logo + Home + Menü auf die Hauptseite (www) zeigen statt relativ auf den
    // eigenen Host. Der site-config-/Auth-Pfad bleibt relativ (same-origin, kein CORS).
    const linkBase = (typeof window !== 'undefined' && window.__NAV_BASE__) || basePath;

    this._injectMobileAssets(linkBase);
    await this._loadConfig(basePath);
    nav.innerHTML = this._render(active, linkBase);
    this._setupMobile();
    this._setupDropdowns();
    this._setupAuth(basePath);
    this._wrapLooseTables();
    this._observeDynamicTables();
    this._publishNavHeight(nav);
  },

  // Nav-Höhe als CSS-Variable veroeffentlichen, damit Seiten mit
  // position:sticky;top:Npx nicht auf hartgecodete Pixel angewiesen sind.
  // Beispiel: .search-bar { position: sticky; top: var(--rosenweg-nav-h, 64px); }
  _publishNavHeight(nav) {
    const set = () => {
      const h = nav.offsetHeight || 64;
      document.documentElement.style.setProperty('--rosenweg-nav-h', h + 'px');
    };
    set();
    // Bei Viewport-Wechsel (Hamburger oeffnen/schliessen) neu messen
    window.addEventListener('resize', set);
    new ResizeObserver(set).observe(nav);
  },

  // MutationObserver: viele Seiten rendern Tabellen dynamisch via
  // el.innerHTML = '&lt;table&gt;...'. Diese werden vom initialen Wrap nicht
  // erfasst. Wir beobachten body für neue Tabellen und wrappen sie
  // nachtraeglich.
  _observeDynamicTables() {
    const obs = new MutationObserver(muts => {
      let hasNewTable = false;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'TABLE' || n.querySelector?.('table')) {
            hasNewTable = true; break;
          }
        }
        if (hasNewTable) break;
      }
      if (hasNewTable) this._wrapLooseTables();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  },

  // Mobile-Optimization Layer: laedt /css/mobile.css einmal global, setzt
  // theme-color und apple-touch-icon damit die Seite als PWA-Vorstufe
  // ordentlich aussieht auf iPhone-Home-Screen.
  _injectMobileAssets(base) {
    if (document.getElementById('rosenweg-mobile-css')) return;
    const head = document.head;
    // CSS
    const link = document.createElement('link');
    link.id = 'rosenweg-mobile-css';
    link.rel = 'stylesheet';
    link.href = base + 'css/mobile.css?v=1';
    head.appendChild(link);
    // theme-color (Browser-UI faerben)
    if (!document.querySelector('meta[name="theme-color"]')) {
      const tc = document.createElement('meta');
      tc.name = 'theme-color';
      tc.content = '#1e40af'; // Tailwind blue-800
      head.appendChild(tc);
    }
    // Apple Touch Icon
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      const ai = document.createElement('link');
      ai.rel = 'apple-touch-icon';
      ai.href = base + 'logo-rosenweg.png';
      head.appendChild(ai);
    }
    // Apple Mobile Web App für 'Add to Home Screen'-Erlebnis
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const am = document.createElement('meta');
      am.name = 'apple-mobile-web-app-capable';
      am.content = 'yes';
      head.appendChild(am);
    }
  },

  // Tabellen ohne overflow-x-auto-Wrapper bekommen automatisch einen,
  // damit sie auf Mobile horizontal scrollen statt das Layout zu sprengen.
  _wrapLooseTables() {
    const tables = document.querySelectorAll('table');
    tables.forEach(t => {
      const parent = t.parentElement;
      if (!parent) return;
      // Hat schon einen Scroll-Wrapper? Dann nichts tun.
      const pc = parent.className || '';
      if (/overflow-x-auto|overflow-auto|table-mobile-wrap/.test(pc)) return;
      // Tabellen in Modal-Dialogen mit fixer Höhe ueberspringen
      if (parent.closest('.fixed.inset-0')) return;
      const wrap = document.createElement('div');
      wrap.className = 'table-mobile-wrap';
      parent.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  },

  async _loadConfig(base) {
    if (this._config) return;
    try {
      const res = await fetch(base + 'site-config.json');
      this._config = await res.json();
    } catch (e) {
      this._config = { stwegen: [] };
    }
  },

  _detectBasePath() {
    const path = window.location.pathname;
    if (path.includes('/stweg')) {
      if (path.includes('/pages/')) return '../../';
      if (path.includes('/stweg')) return '../';
    }
    return '/';
  },

  // Seiten-Registry = nur METADATEN (Datei/Label/Gruppe/perm-Schlüssel).
  // Die AUDIENCE pro Seite wird NICHT hier festgelegt, sondern live aus den
  // Zugriffsrechten abgeleitet (api /api/nav/audience-map, Schlüssel = perm):
  //   *-ausschuss-Gruppe -> ausschuss · nur technik/Präsident -> admin.
  // Seite ohne Rechte-Eintrag = nur technik = admin.
  _pages() {
    return [
      { href: 'https://isp.rosenweg4303.ch/', label: 'ISP / Netzwerk', group: 'Infrastruktur', perm: 'isp' },
      { href: 'proxmox-verwaltung.html', label: 'Proxmox', group: 'Infrastruktur', perm: 'proxmox-verwaltung' },
      { href: 'energie-config.html', label: 'Zählerverwaltung', group: 'Infrastruktur', perm: 'energie-config' },
      { href: 'https://mqtt.rosenweg4303.ch/', label: 'MQTT-Browser', group: 'Infrastruktur', perm: 'mqtt' },
      { href: 'mail-approval-config.html', label: 'Mail-Freigabe-Regeln', group: 'Mail-Betrieb', perm: 'mail-approval-config' },
      { href: 'mail-templates.html', label: 'Vorlagen', group: 'Mail-Betrieb', perm: 'mail-templates' },
      { href: 'email-log.html', label: 'Mail-Log', group: 'Mail-Betrieb', perm: 'email-log' },
      { href: 'email-archiv.html', label: 'Mail-Archiv', group: 'Mail-Betrieb', perm: 'email-archiv' },
      { href: 'mail-empfaenger-admin.html', label: 'Empfänger', group: 'Mail-Betrieb', perm: 'mail-empfaenger' },
      { href: 'verwaltung-mail-outbox.html', label: 'Mail-Outbox', group: 'Mail-Betrieb', perm: 'verwaltung-mail-outbox' },
      { href: 'rechteverwaltung.html', label: 'Rechte', group: 'System', perm: 'rechteverwaltung' },
      { href: 'verwaltung-admin.html', label: 'Hausverwaltung-Admin', group: 'System', perm: 'verwaltung-admin' },
      { href: 'auslagen.html', label: 'Auslagen', group: 'Vorgänge', perm: 'auslagen' },
      { href: 'auslagen-stundensatz.html', label: 'Stundensätze', group: 'Vorgänge', perm: 'auslagen-stundensatz' },
      { href: 'handwerker.html', label: 'Handwerker', group: 'Vorgänge', perm: 'handwerker' },
      { href: 'vollmachten.html', label: 'Vollmachten', group: 'Vorgänge', perm: 'vollmachten' },
      { href: 'projekte.html', label: 'Projekte', group: 'Vorgänge', perm: 'projekte' },
      { href: 'reklamationen.html', label: 'Reklamationen', group: 'Vorgänge', perm: 'reklamationen' },
      { href: 'loeschungen.html', label: 'Löschungen', group: 'Vorgänge', perm: 'loeschungen' },
      { href: 'echtheitspruefung.html', label: 'Echtheitsprüfung', group: 'Vorgänge', perm: 'echtheitspruefung' },
      { href: 'brief-tracking.html', label: 'Brief-Tracking', group: 'Vorgänge', perm: 'brief-tracking' },
      { href: 'wohnungsverwaltung.html', label: 'Wohnungen', group: 'Verwaltung', perm: 'wohnungsverwaltung' },
      { href: 'objektverwaltung.html', label: 'Objektverwaltung', group: 'Verwaltung', perm: 'objektverwaltung', aud: ['admin', 'ausschuss'] },
      { href: 'grundbuch.html', label: 'Grundbuch', group: 'Verwaltung', perm: 'grundbuch' },
      { href: 'mail-compose.html', label: 'Mail schreiben', group: 'Verwaltung', perm: 'mail-compose' },
    ];
  },

  // Fokussierte Audience-Nav (admin./ausschuss.) — Logo->Hauptseite, gruppierte
  // Dropdowns; welche Seite in welche Audience faellt, kommt aus `map` (Rechte).
  _renderAudience(audience, map, active) {
    const home = 'https://www.rosenweg4303.ch/';
    const curr = ((typeof window !== 'undefined' && window.location.pathname.split('/').pop()) || '').toLowerCase();
    const pages = this._pages().filter(p => (p.aud || (map && map[p.perm]) || ['admin']).includes(audience));
    const groups = {};
    pages.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
    const link = (p) => {
      const ext = /^https?:/.test(p.href);
      const href = ext ? p.href : '/' + p.href;
      const act = (!ext && p.href.toLowerCase() === curr) ? 'bg-blue-50 text-blue-600 font-medium' : 'text-gray-700 hover:bg-gray-50';
      return `<a href="${this._esc(href)}" class="${act} block px-4 py-2 text-sm rounded">${this._esc(p.label)}${ext ? ' ↗' : ''}</a>`;
    };
    const dropdowns = Object.entries(groups).map(([g, ps]) => `
      <div class="relative nav-dropdown">
        <button class="text-gray-700 hover:text-blue-600 px-3 py-2 text-sm transition flex items-center gap-1">${this._esc(g)}
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg></button>
        <div class="nav-dropdown-menu hidden absolute left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border py-1 z-50">${ps.map(link).join('')}</div>
      </div>`).join('');
    const labelMap = { admin: 'Admin · Technik / Präsident', ausschuss: 'Ausschuss' };
    return `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between items-center h-16">
        <div class="flex items-center gap-3 min-w-0">
          <a href="${home}" class="flex items-center shrink-0" title="Zur Hauptseite"><img src="${home}logo-rosenweg.png" alt="Rosenweg" class="h-10 w-auto"></a>
          <span class="text-gray-300 hidden sm:inline">/</span>
          <span class="font-semibold text-gray-800 truncate">${this._esc(labelMap[audience] || audience)}</span>
        </div>
        <div class="hidden md:flex items-center gap-1">${dropdowns}</div>
        <div class="flex items-center gap-2">
          <a href="${home}" class="px-3 py-2 text-sm text-gray-500 hover:text-blue-600 transition hidden sm:inline">← Hauptseite</a>
          <div id="nav-auth" class="hidden sm:flex items-center gap-2 pl-2 border-l">
            <a href="${home}profil.html" id="nav-user-link" class="text-sm text-gray-600 hover:text-blue-600 hidden"></a>
            <button id="nav-login-btn" class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition hidden">Anmelden</button>
            <button id="nav-logout-btn" class="text-sm text-gray-500 hover:text-red-600 transition hidden">Abmelden</button>
          </div>
        </div>
      </div>
    </div>`;
  },

  _renderSatellite(cfg, base) {
    const links = (cfg.links || []).map(l => {
      const href = /^https?:/.test(l.href) ? l.href : base + l.href;
      return `<a href="${this._esc(href)}" class="px-3 py-2 text-sm text-gray-600 hover:text-blue-600 transition">${this._esc(l.label)}</a>`;
    }).join('');
    return `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between items-center h-16">
        <div class="flex items-center gap-3 min-w-0">
          <a href="${base}" class="flex items-center shrink-0" title="Zur Hauptseite">
            <img src="${base}logo-rosenweg.png" alt="Rosenweg" class="h-10 w-auto">
          </a>
          ${cfg.title ? `<span class="text-gray-300 hidden sm:inline">/</span><span class="font-semibold text-gray-800 truncate">${this._esc(cfg.title)}</span>` : ''}
        </div>
        <div class="flex items-center gap-1">
          <div class="hidden sm:flex items-center gap-1">${links}</div>
          <a href="${base}" class="px-3 py-2 text-sm text-gray-500 hover:text-blue-600 transition">← Hauptseite</a>
          <div id="nav-auth" class="hidden sm:flex items-center gap-2 ml-2 pl-2 border-l">
            <a href="${base}profil.html" id="nav-user-link" class="text-sm text-gray-600 hover:text-blue-600 hidden"></a>
            <button id="nav-login-btn" class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition hidden">Anmelden</button>
            <button id="nav-logout-btn" class="text-sm text-gray-500 hover:text-red-600 transition hidden">Abmelden</button>
          </div>
        </div>
      </div>
    </div>`;
  },

  _render(active, base) {
    // Satelliten-/Kompakt-Nav (z.B. mqtt.rosenweg4303.ch): nur Logo -> Hauptseite,
    // Seitentitel + wenige passende Links. Verhindert die ueberladene Hauptnav.
    if (typeof window !== 'undefined' && window.__NAV_SATELLITE__) {
      return this._renderSatellite(window.__NAV_SATELLITE__, base);
    }
    const a = (key) => active === key ? 'text-blue-600 font-semibold' : 'text-gray-700 hover:text-blue-600';
    const dropA = (key) => active === key ? 'bg-blue-50 text-blue-600' : 'text-gray-700 hover:bg-gray-50';
    const stwegen = this._config?.stwegen || [];

    // STWEG/MEG leben in eigenen Frontend-Containern auf Subdomains
    // (stwegN.rosenweg4303.ch, meg.rosenweg4303.ch). Links daher absolut
    // ueber den slug aus site-config — nicht mehr ueber den www-Pfad.
    const sub = s => `https://${this._esc(s.slug || ('stweg' + parseInt(s.nr)))}.rosenweg4303.ch/`;

    const desktopLinks = stwegen.map(s => {
      const label = `${this._esc(s.name)} – ${this._esc(s.adressen)}`;
      const sep = s.nr === 8 ? '<hr class="my-1">' : '';
      return `${sep}<a href="${sub(s)}" class="${dropA(s.slug || ('stweg' + parseInt(s.nr)))} block px-4 py-2 text-sm">${label}</a>`;
    }).join('\n              ');

    const mobileLinks = stwegen.map(s =>
      `<a href="${sub(s)}" class="text-sm text-gray-700 hover:bg-gray-100 rounded px-2 py-1">${this._esc(s.name)}</a>`
    ).join('\n          ');

    return `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center">
          <a href="${base}" class="flex items-center">
            <img src="${base}logo-rosenweg.png" alt="Rosenweg" class="h-12 w-auto">
            <span class="ml-2 text-lg font-semibold text-gray-800 hidden sm:block">Rosenweg</span>
          </a>
        </div>

        <!-- Desktop Nav -->
        <div class="hidden lg:flex items-center space-x-1">
          <a href="${base}#home" class="${a('home')} px-3 py-2 text-sm transition">Start</a>
          <a href="${base}dashboard.html" class="${a('dashboard')} px-3 py-2 text-sm transition">📊 Dashboard</a>

          <!-- Gebäude Dropdown -->
          <div class="relative nav-dropdown">
            <button class="${a('gebaeude')} px-3 py-2 text-sm transition flex items-center gap-1">
              Gebäude
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="nav-dropdown-menu hidden absolute left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border py-1 z-50">
              ${desktopLinks}
            </div>
          </div>

          <!-- Services Mega-Menu -->
          <div class="relative nav-dropdown nav-perm-group" data-perm-group="services">
            <button class="${a('services')} px-3 py-2 text-sm transition flex items-center gap-1">
              Services
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            ${this._renderServicesMegaMenu(active, base)}
          </div>

          <!-- Infos Dropdown -->
          <div class="relative nav-dropdown">
            <button class="${a('infos')} px-3 py-2 text-sm transition flex items-center gap-1">
              Infos
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="nav-dropdown-menu hidden absolute left-0 mt-1 w-48 bg-white rounded-lg shadow-lg border py-1 z-50">
              <a href="${base}telefonbuch.html" class="${dropA('telefonbuch')} block px-4 py-2 text-sm">Telefonbuch</a>
              <a href="${base}projekte.html" data-perm-any="eigentuemer" class="${dropA('projekte')} block px-4 py-2 text-sm">Projekte</a>
              <a href="${base}verwaltung.html" class="${dropA('hausverwaltung')} block px-4 py-2 text-sm">Hausverwaltung</a>
              <a href="${base}anfahrt.html" class="${dropA('anfahrt')} block px-4 py-2 text-sm">Anfahrt &amp; Parken</a>
              <a href="${base}entsorgung.html" class="${dropA('entsorgung')} block px-4 py-2 text-sm">Entsorgung</a>
              <a href="https://isp.rosenweg4303.ch/" class="block px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">ISP / WLAN ↗</a>
              <a href="${base}#dokumente" class="${dropA('dokumente')} block px-4 py-2 text-sm">Dokumente</a>
            </div>
          </div>

          <a href="${base}rechteverwaltung.html" data-perm="rechteverwaltung" class="${a('rechte')} px-3 py-2 text-sm transition">Rechte</a>
          <a href="${base}profil.html" id="nav-profil-link" class="${a('profil')} px-3 py-2 text-sm transition hidden items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
            Mein Profil
          </a>
          <a href="${base}hilfe.html" class="${a('hilfe')} px-3 py-2 text-sm transition">Hilfe</a>
          <a href="${base}#kontakt" class="${a('kontakt')} px-3 py-2 text-sm transition">Kontakt</a>
        </div>

        <!-- Auth + Mobile -->
        <div class="flex items-center gap-2">
          <button id="nav-ki-search-btn" onclick="RosenwegSearch.open()" class="hidden p-2 text-gray-600 hover:text-blue-600 rounded-full hover:bg-gray-100" title="KI-Suche (Strg+K)" aria-label="KI-Suche">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 4a7 7 0 100 14 7 7 0 000-14z"/></svg>
          </button>
          <div id="nav-auth" class="hidden sm:flex items-center gap-2">
            <a href="${base}profil.html" id="nav-user-link" class="text-sm text-gray-600 hover:text-blue-600 hidden"></a>
            <button id="nav-login-btn" class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition hidden">Anmelden</button>
            <button id="nav-logout-btn" class="text-sm text-gray-500 hover:text-red-600 transition hidden">Abmelden</button>
          </div>
          <button id="nav-mobile-toggle" class="lg:hidden text-gray-700 hover:text-blue-600 p-2">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Mobile Menu -->
    <div id="nav-mobile-menu" class="hidden lg:hidden bg-white border-t">
      <div class="px-4 py-3 space-y-1">
        <a href="${base}#home" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded">Start</a>
        <a href="${base}dashboard.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded">📊 Dashboard</a>

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase">Gebäude</div>
        <div class="grid grid-cols-2 gap-1 px-3">
          ${mobileLinks}
        </div>

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase nav-perm-section" data-perm-section="services">Services</div>
        <div class="space-y-1 px-1">
          ${this._renderServicesMobile(active, base)}
        </div>

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase">Infos</div>
        <a href="${base}telefonbuch.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Telefonbuch</a>
        <a href="${base}verwaltung.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Hausverwaltung</a>
        <a href="${base}anfahrt.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Anfahrt &amp; Parken</a>
        <a href="${base}entsorgung.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Entsorgung</a>
        <a href="https://isp.rosenweg4303.ch/" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">ISP / WLAN ↗</a>
        <a href="${base}#dokumente" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Dokumente</a>

        <hr class="my-2">
        <a href="${base}rechteverwaltung.html" data-perm="rechteverwaltung" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Rechte</a>
        <a href="${base}profil.html" id="nav-profil-link-mobile" class="px-3 py-2 text-blue-700 font-medium hover:bg-blue-50 rounded text-sm hidden items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
          Mein Profil
        </a>
        <a href="${base}hilfe.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Hilfe</a>
        <a href="${base}#kontakt" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Kontakt</a>

        <div id="nav-mobile-auth" class="pt-2 border-t mt-2"></div>
      </div>
    </div>`;
  },

  _setupMobile() {
    const toggle = document.getElementById('nav-mobile-toggle');
    const menu = document.getElementById('nav-mobile-menu');
    if (toggle && menu) {
      toggle.addEventListener('click', () => menu.classList.toggle('hidden'));
    }
  },

  _setupDropdowns() {
    document.querySelectorAll('.nav-dropdown').forEach(dd => {
      const btn = dd.querySelector('button');
      const menu = dd.querySelector('.nav-dropdown-menu');
      let timeout;

      dd.addEventListener('mouseenter', () => {
        clearTimeout(timeout);
        menu.classList.remove('hidden');
      });
      dd.addEventListener('mouseleave', () => {
        timeout = setTimeout(() => menu.classList.add('hidden'), 150);
      });
      btn.addEventListener('click', () => menu.classList.toggle('hidden'));
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-dropdown')) {
        document.querySelectorAll('.nav-dropdown-menu').forEach(m => m.classList.add('hidden'));
      }
    });
  },

  _applyPermissions(user) {
    const hasPerm = (page) => {
      if (!user) return false;
      const groupsLower = (user.groups || []).map(g => String(g).toLowerCase());
      // Admin-Gruppen sehen alles
      if (groupsLower.some(g => g === 'technik' || g === 'präsident' || g === 'praesident')) return true;
      const perms = user.permissions || {};
      // 1. Permission-basiert (z.B. 'wohnungsverwaltung', 'energie-monitor')
      if (perms[page] === 'read' || perms[page] === 'write') return true;
      // 2. Gruppen-basiert (z.B. data-perm-any="eigentuemer" matcht Gruppe "eigentuemer")
      const pageL = String(page).toLowerCase();
      if (groupsLower.includes(pageL)) return true;
      // 3. STWEG-spezifische Gruppen (z.B. data-perm-any="ausschuss" matcht "stweg2-ausschuss")
      if (groupsLower.some(g => g === pageL || g.endsWith('-' + pageL) || g.startsWith(pageL + '-'))) return true;
      return false;
    };

    // Hide individual links the user has no permission for
    document.querySelectorAll('[data-perm]').forEach(el => {
      const page = el.dataset.perm;
      if (!hasPerm(page)) {
        el.style.display = 'none';
      }
    });

    // Support data-perm-any="page1,page2" (show if user has ANY of the permissions)
    document.querySelectorAll('[data-perm-any]').forEach(el => {
      const pages = el.dataset.permAny.split(',');
      if (!pages.some(page => hasPerm(page.trim()))) {
        el.style.display = 'none';
      }
    });

    // Mega-Menu: pro Spalte prüfen ob alle Links versteckt → Spalte verstecken
    document.querySelectorAll('.nav-mega-col').forEach(col => {
      const links = col.querySelectorAll('a');
      const anyVisible = Array.from(links).some(a => a.style.display !== 'none');
      if (!anyVisible) col.style.display = 'none';
    });
    // Mobile-Akkordion: pro details-Gruppe analog
    document.querySelectorAll('.nav-mobile-group').forEach(grp => {
      const links = grp.querySelectorAll('a');
      const anyVisible = Array.from(links).some(a => a.style.display !== 'none');
      if (!anyVisible) grp.style.display = 'none';
    });

    // Hide "Services" Trigger ganz wenn keine Spalte sichtbar
    document.querySelectorAll('[data-perm-group="services"]').forEach(group => {
      const visibleCols = group.querySelectorAll('.nav-mega-col:not([style*="display: none"])');
      if (visibleCols.length === 0) group.style.display = 'none';
    });

    // Hide mobile "Services" section header wenn keine Gruppe sichtbar
    document.querySelectorAll('[data-perm-section="services"]').forEach(header => {
      const container = header.nextElementSibling;
      if (!container) return;
      const visibleGroups = container.querySelectorAll('.nav-mobile-group:not([style*="display: none"])');
      if (visibleGroups.length === 0) {
        header.style.display = 'none';
        container.style.display = 'none';
      }
    });

    // Pending-Badge für Technik/Präsident: Anzahl Mails in der Verwaltungs-Mail-Queue
    const groupsLower = (user?.groups || []).map(g => String(g).toLowerCase());
    if (groupsLower.some(g => g === 'technik' || g === 'präsident' || g === 'praesident')) {
      // L7: nur pollen wenn Tab sichtbar (spart Strom/Requests bei Hintergrund-Tabs)
      if (!this._vmqInterval) {
        if (typeof window !== 'undefined' && typeof window.intervalWhenVisible === 'function') {
          this._vmqInterval = window.intervalWhenVisible(() => this._updateMailQueueBadge(), 60000);
        } else {
          this._updateMailQueueBadge();
          this._vmqInterval = setInterval(() => this._updateMailQueueBadge(), 60000);
        }
      }
    }
  },

  async _updateMailQueueBadge() {
    try {
      const r = await fetch('/api/verwaltung-mail-queue/pending-count', { credentials: 'include' });
      if (!r.ok) return;
      const data = await r.json();
      const count = data.count || 0;
      ['nav-vmq-badge', 'nav-vmq-badge-mobile'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (count > 0) {
          el.textContent = count;
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });
    } catch {}
  },

  _setupAuth(base) {
    const authDiv = document.getElementById('nav-auth');
    const loginBtn = document.getElementById('nav-login-btn');
    const logoutBtn = document.getElementById('nav-logout-btn');
    const userLink = document.getElementById('nav-user-link');
    const mobileAuth = document.getElementById('nav-mobile-auth');

    if (typeof AuthentikAuth === 'undefined') {
      authDiv?.classList.remove('hidden');
      loginBtn?.classList.remove('hidden');
      loginBtn?.addEventListener('click', () => {
        window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      });
      // No auth available - hide all permission-gated links
      this._applyPermissions(null);
      return;
    }

    AuthentikAuth.init({
      requireAuth: false,
      onLogin: (user) => {
        authDiv?.classList.remove('hidden');
        userLink.textContent = user.name || user.email;
        userLink.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        logoutBtn.addEventListener('click', () => AuthentikAuth.logout());
        // Mein-Profil Eintrag in Hauptnav (Desktop + Mobile) sichtbar machen
        document.getElementById('nav-profil-link')?.classList.replace('hidden', 'inline-flex');
        document.getElementById('nav-profil-link-mobile')?.classList.replace('hidden', 'flex');

        if (mobileAuth) {
          mobileAuth.innerHTML = `
            <a href="${base}profil.html" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded">${this._esc(user.name || user.email)}</a>
            <button onclick="AuthentikAuth.logout()" class="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded">Abmelden</button>`;
        }

        this._applyPermissions(user);
        // KI-Such-Lupe nur für eingeloggte User anzeigen
        document.getElementById('nav-ki-search-btn')?.classList.remove('hidden');
      },
    }).then(user => {
      if (!user) {
        authDiv?.classList.remove('hidden');
        loginBtn?.classList.remove('hidden');
        loginBtn?.addEventListener('click', () => AuthentikAuth.login());
        if (mobileAuth) {
          mobileAuth.innerHTML = `<button onclick="AuthentikAuth.login()" class="block w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded">Anmelden</button>`;
        }
        // Not logged in - hide permission-gated links
        this._applyPermissions(null);
      }
    });
  },
};

// ─── KI-Suche (globales Modul, über RosenwegSearch.open() aufrufbar) ───
const RosenwegSearch = {
  _modal: null,
  _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  init() {
    if (this._modal) return;
    const wrap = document.createElement('div');
    wrap.id = 'rw-ki-search-modal';
    wrap.className = 'hidden fixed inset-0 z-[100] bg-black/40 flex items-start justify-center pt-12 sm:pt-20 px-4';
    wrap.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" onclick="event.stopPropagation()">
        <div class="px-4 py-3 border-b flex items-center gap-3">
          <svg class="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 4a7 7 0 100 14 7 7 0 000-14z"/></svg>
          <input id="rw-ki-search-input" type="search" placeholder="Suche nach Person, Handwerker, Vollmacht, Mail, ..." autocomplete="off" class="flex-1 outline-none text-sm py-1.5">
          <kbd class="hidden sm:inline text-xs text-gray-400 border rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div id="rw-ki-search-status" class="hidden px-4 py-2 text-xs text-gray-500"></div>
        <div id="rw-ki-search-answer" class="hidden px-4 py-3 bg-blue-50 border-b text-sm text-blue-900"></div>
        <div id="rw-ki-search-hits" class="overflow-y-auto"></div>
        <div class="px-4 py-2 border-t text-xs text-gray-400 flex justify-between">
          <span>Powered by Claude Haiku 4.5</span>
          <span>Strg+K / Cmd+K zum Oeffnen</span>
        </div>
      </div>`;
    wrap.addEventListener('click', () => this.close());
    document.body.appendChild(wrap);
    this._modal = wrap;
    const input = document.getElementById('rw-ki-search-input');
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this._run(input.value), 350);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.open(); }
      if (e.key === 'Escape' && !this._modal.classList.contains('hidden')) this.close();
    });
  },
  open() {
    this.init();
    this._modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('rw-ki-search-input')?.focus(), 20);
  },
  close() {
    this._modal?.classList.add('hidden');
    document.getElementById('rw-ki-search-input').value = '';
    document.getElementById('rw-ki-search-hits').innerHTML = '';
    document.getElementById('rw-ki-search-answer').classList.add('hidden');
    document.getElementById('rw-ki-search-status').classList.add('hidden');
  },
  async _run(q) {
    const stat = document.getElementById('rw-ki-search-status');
    const ans = document.getElementById('rw-ki-search-answer');
    const hits = document.getElementById('rw-ki-search-hits');
    if (!q || q.trim().length < 2) {
      stat.classList.add('hidden'); ans.classList.add('hidden'); hits.innerHTML = '';
      return;
    }
    stat.classList.remove('hidden'); stat.textContent = 'Suche & KI-Auswertung…';
    ans.classList.add('hidden');
    try {
      const r = await AuthentikAuth.apiFetch('/api/ki-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      const d = await r.json();
      stat.classList.add('hidden');
      if (d.answer) {
        ans.textContent = d.answer;
        ans.classList.remove('hidden');
      }
      const typColors = {
        Person: 'bg-blue-100 text-blue-800',
        Handwerker: 'bg-purple-100 text-purple-800',
        Vollmacht: 'bg-amber-100 text-amber-800',
        Reklamation: 'bg-red-100 text-red-800',
        'E-Mail': 'bg-gray-100 text-gray-700',
        Verwaltung: 'bg-emerald-100 text-emerald-800',
        Wohnung: 'bg-indigo-100 text-indigo-800',
        Projekt: 'bg-pink-100 text-pink-800',
      };
      if (!d.hits || d.hits.length === 0) {
        hits.innerHTML = '<div class="p-8 text-center text-gray-400 italic">Keine Treffer.</div>';
        return;
      }
      hits.innerHTML = d.hits.map(h => `
        <a href="${this._esc(h.url)}" class="flex items-start gap-3 px-4 py-3 border-b hover:bg-blue-50 transition">
          <span class="text-xs ${typColors[h.typ] || 'bg-gray-100 text-gray-700'} px-2 py-0.5 rounded shrink-0 mt-0.5">${this._esc(h.typ)}</span>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-gray-900 truncate">${this._esc(h.titel)}</div>
            ${h.sub ? `<div class="text-xs text-gray-500 truncate">${this._esc(h.sub)}</div>` : ''}
          </div>
          <svg class="w-4 h-4 text-gray-300 shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        </a>
      `).join('');
    } catch (e) {
      stat.classList.remove('hidden');
      stat.textContent = 'Fehler: ' + e.message;
    }
  },
};
window.RosenwegSearch = RosenwegSearch;
