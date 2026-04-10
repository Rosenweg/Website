/**
 * Shared Navigation Component for Rosenweg Website
 * Loads STWEG data from /site-config.json (single source of truth)
 * Include via: <script src="/js/nav.js"></script>
 * Then call: RosenwegNav.init({ active: 'services' })
 */
const RosenwegNav = {
  _config: null,

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  async init(opts = {}) {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const active = opts.active || '';
    const basePath = opts.basePath || this._detectBasePath();

    await this._loadConfig(basePath);
    nav.innerHTML = this._render(active, basePath);
    this._setupMobile();
    this._setupDropdowns();
    this._setupAuth(basePath);
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

  _render(active, base) {
    const a = (key) => active === key ? 'text-blue-600 font-semibold' : 'text-gray-700 hover:text-blue-600';
    const dropA = (key) => active === key ? 'bg-blue-50 text-blue-600' : 'text-gray-700 hover:bg-gray-50';
    const stwegen = this._config?.stwegen || [];

    const desktopLinks = stwegen.map(s => {
      const label = s.typ === 'Tiefgarage' ? `${this._esc(s.name)} – TG ${this._esc(s.adressen)}` : `${this._esc(s.name)} – ${this._esc(s.adressen)}`;
      const sep = s.nr === 8 ? '<hr class="my-1">' : '';
      return `${sep}<a href="${base}stweg${parseInt(s.nr)}/" class="${dropA('stweg' + s.nr)} block px-4 py-2 text-sm">${label}</a>`;
    }).join('\n              ');

    const mobileLinks = stwegen.map(s =>
      `<a href="${base}stweg${s.nr}/" class="text-sm text-gray-700 hover:bg-gray-100 rounded px-2 py-1">STWEG ${s.nr}</a>`
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

          <!-- Services Dropdown -->
          <div class="relative nav-dropdown nav-perm-group" data-perm-group="services">
            <button class="${a('services')} px-3 py-2 text-sm transition flex items-center gap-1">
              Services
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="nav-dropdown-menu hidden absolute left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border py-1 z-50">
              <a href="${base}energie-monitor.html" data-perm="energie-monitor" class="${dropA('energie')} block px-4 py-2 text-sm">Energie-Monitor</a>
              <a href="${base}zaehler.html" data-perm="zaehler" class="${dropA('zaehler')} block px-4 py-2 text-sm">Zähler & Verbrauch</a>
              <a href="${base}email-verteiler.html" data-perm="email-verteiler" class="${dropA('verteiler')} block px-4 py-2 text-sm">E-Mail-Verteiler</a>
              <a href="${base}email-archiv.html" data-perm="email-archiv" class="${dropA('archiv')} block px-4 py-2 text-sm">E-Mail-Archiv</a>
              <a href="${base}wohnungsverwaltung.html" data-perm-any="wohnungsverwaltung,bewohner-verwaltung,verwaltung" class="${dropA('verwaltung')} block px-4 py-2 text-sm">Verwaltung</a>
              <a href="${base}proxmox-verwaltung.html" data-perm="proxmox-verwaltung" class="${dropA('proxmox')} block px-4 py-2 text-sm">Proxmox</a>
            </div>
          </div>

          <!-- Infos Dropdown -->
          <div class="relative nav-dropdown">
            <button class="${a('infos')} px-3 py-2 text-sm transition flex items-center gap-1">
              Infos
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="nav-dropdown-menu hidden absolute left-0 mt-1 w-48 bg-white rounded-lg shadow-lg border py-1 z-50">
              <a href="${base}projekte.html" data-perm-any="eigentuemer" class="${dropA('projekte')} block px-4 py-2 text-sm">Projekte</a>
              <a href="${base}entsorgung.html" class="${dropA('entsorgung')} block px-4 py-2 text-sm">Entsorgung</a>
              <a href="${base}isp.html" class="${dropA('isp')} block px-4 py-2 text-sm">ISP / WLAN</a>
              <a href="${base}#dokumente" class="${dropA('dokumente')} block px-4 py-2 text-sm">Dokumente</a>
            </div>
          </div>

          <a href="${base}rechteverwaltung.html" data-perm="rechteverwaltung" class="${a('rechte')} px-3 py-2 text-sm transition">Rechte</a>
          <a href="${base}hilfe.html" class="${a('hilfe')} px-3 py-2 text-sm transition">Hilfe</a>
          <a href="${base}#kontakt" class="${a('kontakt')} px-3 py-2 text-sm transition">Kontakt</a>
        </div>

        <!-- Auth + Mobile -->
        <div class="flex items-center gap-2">
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

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase">Gebäude</div>
        <div class="grid grid-cols-2 gap-1 px-3">
          ${mobileLinks}
        </div>

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase nav-perm-section" data-perm-section="services">Services</div>
        <a href="${base}energie-monitor.html" data-perm="energie-monitor" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Energie-Monitor</a>
        <a href="${base}zaehler.html" data-perm="zaehler" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Zähler & Verbrauch</a>
        <a href="${base}email-verteiler.html" data-perm="email-verteiler" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">E-Mail-Verteiler</a>
        <a href="${base}email-archiv.html" data-perm="email-archiv" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">E-Mail-Archiv</a>
        <a href="${base}wohnungsverwaltung.html" data-perm-any="wohnungsverwaltung,bewohner-verwaltung,verwaltung" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Verwaltung</a>
        <a href="${base}proxmox-verwaltung.html" data-perm="proxmox-verwaltung" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Proxmox</a>

        <div class="px-3 py-2 text-xs font-semibold text-gray-400 uppercase">Infos</div>
        <a href="${base}entsorgung.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Entsorgung</a>
        <a href="${base}isp.html" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">ISP / WLAN</a>
        <a href="${base}#dokumente" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Dokumente</a>

        <hr class="my-2">
        <a href="${base}rechteverwaltung.html" data-perm="rechteverwaltung" class="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm">Rechte</a>
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
      if (user.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) return true;
      const perms = user.permissions || {};
      return (perms[page] === 'read' || perms[page] === 'write');
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

    // Hide "Services" dropdown entirely if no service links are visible
    document.querySelectorAll('[data-perm-group="services"]').forEach(group => {
      const visibleLinks = group.querySelectorAll('[data-perm]:not([style*="display: none"])');
      const unpermLinks = group.querySelectorAll('a:not([data-perm])');
      if (visibleLinks.length === 0 && unpermLinks.length === 0) {
        group.style.display = 'none';
      }
    });

    // Hide mobile "Services" section header if no service links visible
    document.querySelectorAll('[data-perm-section="services"]').forEach(header => {
      let next = header.nextElementSibling;
      let anyVisible = false;
      while (next && !next.classList?.contains('nav-perm-section') && next.tagName !== 'HR' && !next.textContent.includes('Infos')) {
        if (next.tagName === 'A' && next.style.display !== 'none') {
          anyVisible = true;
          break;
        }
        next = next.nextElementSibling;
      }
      if (!anyVisible) header.style.display = 'none';
    });
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

        if (mobileAuth) {
          mobileAuth.innerHTML = `
            <a href="${base}profil.html" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded">${this._esc(user.name || user.email)}</a>
            <button onclick="AuthentikAuth.logout()" class="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded">Abmelden</button>`;
        }

        this._applyPermissions(user);
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
