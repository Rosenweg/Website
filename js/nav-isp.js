/**
 * Rosenweg ISP — dedizierte Nav für isp.rosenweg4303.ch
 *
 * Wird im Dockerfile.isp als /js/nav.js ueberlagert, damit alle ISP-html
 * weiterhin `<script src="/js/nav.js">` referenzieren koennen aber im ISP-
 * Container eine ISP-only-Navigation bekommen.
 *
 * Exportiert das gleiche `RosenwegNav.init(...)` Interface wie das normale
 * nav.js, damit bestehende Pages unveraendert bleiben.
 */
const RosenwegNav = {
  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  init({ active } = {}) {
    const a = (key) => 'nav-link ' + (active === key
      ? 'text-cyan-300 border-b-2 border-cyan-300'
      : 'text-slate-200 hover:text-white');
    const aMobile = (key) => 'block px-3 py-2 rounded text-sm ' + (active === key
      ? 'bg-cyan-500/20 text-cyan-200'
      : 'text-slate-200 hover:bg-white/10');

    const html = `
      <div class="bg-gradient-to-r from-slate-900 to-slate-800 text-white shadow-lg">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="flex justify-between items-center h-14">
            <!-- Brand -->
            <a href="/" class="flex items-center gap-2 text-white">
              <img src="/logo-rosenweg-isp.png" alt="Rosenweg ISP" class="w-8 h-8 rounded-full bg-white p-0.5">
              <span class="font-bold tracking-tight">Rosenweg ISP</span>
            </a>

            <!-- Desktop Nav -->
            <div class="hidden lg:flex items-center gap-1">
              <a href="/" class="${a('isp')} px-3 py-2 text-sm">Übersicht</a>
              <a href="/isp-mein-zugang.html" class="${a('mein-zugang')} px-3 py-2 text-sm">Mein Zugang</a>
              <a href="/wlan.html" class="${a('wlan')} px-3 py-2 text-sm">WLAN</a>
              <a href="/tv.html" class="${a('tv')} px-3 py-2 text-sm">TV7</a>
              <a href="/dmarc.html" data-perm-any="technik,praesident" class="${a('dmarc')} px-3 py-2 text-sm">DMARC</a>
              <a href="/isp-admin.html" data-perm-any="technik,praesident" class="${a('isp-admin')} px-3 py-2 text-sm">ISP-Admin</a>
            </div>

            <!-- Auth + Mobile-Toggle -->
            <div class="flex items-center gap-3">
              <a href="https://www.rosenweg4303.ch/" class="hidden sm:inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white" title="Hauptseite Rosenweg">↗ Hauptseite</a>
              <div id="nav-auth" class="hidden sm:flex items-center gap-2">
                <span id="nav-user-name" class="text-sm text-slate-200 hidden"></span>
                <button id="nav-login-btn" class="text-sm bg-cyan-600 hover:bg-cyan-500 text-white px-3 py-1.5 rounded transition hidden">Anmelden</button>
                <button id="nav-logout-btn" class="text-sm text-slate-300 hover:text-rose-300 transition hidden">Abmelden</button>
              </div>
              <button id="nav-mobile-toggle" class="lg:hidden text-slate-200 hover:text-white p-2">
                <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
            </div>
          </div>

          <!-- Mobile Nav -->
          <div id="nav-mobile-menu" class="lg:hidden hidden border-t border-white/10 py-2">
            <a href="/" class="${aMobile('isp')}">🏠 Übersicht</a>
            <a href="/isp-mein-zugang.html" class="${aMobile('mein-zugang')}">📋 Mein Zugang</a>
            <a href="/wlan.html" class="${aMobile('wlan')}">📶 WLAN</a>
            <a href="/tv.html" class="${aMobile('tv')}">📺 TV7</a>
            <a href="/dmarc.html" data-perm-any="technik,praesident" class="${aMobile('dmarc')}">🛡 DMARC</a>
            <a href="/isp-admin.html" data-perm-any="technik,praesident" class="${aMobile('isp-admin')}">⚙ ISP-Admin</a>
            <hr class="my-2 border-white/10">
            <a href="https://www.rosenweg4303.ch/" class="block px-3 py-2 text-sm text-slate-400 hover:text-white">↗ Hauptseite Rosenweg</a>
            <div class="px-3 py-2 mt-2 border-t border-white/10">
              <button id="nav-login-btn-mobile" class="w-full text-left text-sm bg-cyan-600 text-white px-3 py-2 rounded hidden">Anmelden</button>
              <button id="nav-logout-btn-mobile" class="w-full text-left text-sm text-slate-300 hover:text-rose-300 py-2 hidden">Abmelden</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const navEl = document.getElementById('main-nav');
    if (navEl) navEl.innerHTML = html;

    document.getElementById('nav-mobile-toggle')?.addEventListener('click', () => {
      document.getElementById('nav-mobile-menu')?.classList.toggle('hidden');
    });

    this._wireAuth();
    this._wirePermissions();
  },

  _wireAuth() {
    if (typeof AuthentikAuth === 'undefined') return;
    const user = AuthentikAuth.getUser();
    const showFor = (sel, show) => document.querySelectorAll(sel).forEach(el => el.classList.toggle('hidden', !show));
    showFor('#nav-login-btn,#nav-login-btn-mobile', !user);
    showFor('#nav-logout-btn,#nav-logout-btn-mobile', !!user);
    showFor('#nav-auth', true);
    if (user) {
      const name = document.getElementById('nav-user-name');
      if (name) { name.textContent = user.name || user.email || ''; name.classList.remove('hidden'); }
    }
    document.querySelectorAll('#nav-login-btn,#nav-login-btn-mobile').forEach(b => {
      b.addEventListener('click', () => AuthentikAuth.login && AuthentikAuth.login());
    });
    document.querySelectorAll('#nav-logout-btn,#nav-logout-btn-mobile').forEach(b => {
      b.addEventListener('click', () => AuthentikAuth.logout && AuthentikAuth.logout());
    });
  },

  _wirePermissions() {
    if (typeof AuthentikAuth === 'undefined') return;
    const user = AuthentikAuth.getUser();
    const groups = (user?.groups || []).map(g => g.toLowerCase());
    const isAdmin = user?.isAdmin || groups.includes('technik') || groups.includes('präsident') || groups.includes('praesident');

    document.querySelectorAll('[data-perm-any]').forEach(el => {
      const need = el.dataset.permAny.split(',').map(s => s.trim().toLowerCase());
      const ok = isAdmin || need.some(g => groups.includes(g));
      if (!ok) el.classList.add('hidden');
    });
  },
};

window.RosenwegNav = RosenwegNav;
