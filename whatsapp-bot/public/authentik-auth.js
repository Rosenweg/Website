/**
 * Authentik SSO Authentication Module
 * Shared across all Rosenweg pages
 */
const AuthentikAuth = {
  SESSION_KEY: 'rosenweg_session',
  USER_KEY: 'rosenweg_user',

  // --- Stiller SSO-Versuch ---------------------------------------------
  //
  // Wer an einer Station angemeldet ist, hat ein Kerberos-Ticket. Der Browser
  // dort gibt es an authentik.rosenweg4303.ch weiter (Richtlinie
  // AuthServerAllowlist, gesetzt von os-stationen). Dann muss sich niemand ein
  // zweites Mal anmelden — die Anmeldeseite kommt gar nicht erst.
  //
  // Warum dieser Umweg und nicht einfach eine Weiterleitung auf die
  // SSO-Adresse: ein misslungener Kerberos-Versuch fällt NICHT auf die
  // Anmeldemaske zurück. Er endet bei HTTP 401 mit 'WWW-Authenticate:
  // Negotiate', und dabei bleibt es. Am 3. August nachgemessen. Wer von
  // auswärts käme, sässe in einer Sackgasse. Als Hintergrundanfrage dagegen
  // ist ein Fehlschlag folgenlos: es passiert einfach nichts Sichtbares, und
  // gleich darauf kommt die gewohnte Anmeldung.
  //
  // Ein unsichtbares Fenster (iframe) ginge auch nicht — Authentik schickt
  // 'X-Frame-Options: DENY'.
  //
  // 'no-cors': die Antwort dürfen wir ohnehin nicht lesen, und wir brauchen
  // sie auch nicht. Es geht allein darum, dass der Browser die Sitzung setzt.
  // Ein Browser ohne Kerberos (jedes Gerät ausserhalb des Hauses) bekommt die
  // 401 zurück, ignoriert die Aufforderung mangels Ticket und fragt NICHT
  // nach — dort kostet das eine Anfrage und sonst nichts.
  SSO_PROBE_URL: 'https://authentik.rosenweg4303.ch/source/kerberos/ad-kerberos/',
  // Der zweite Schritt, ohne den der erste nichts bewirkt.
  //
  // Nach dem Kerberos-Handschlag liegt in Authentik ein fertiger Anmeldeplan,
  // aber die Sitzung steht noch nicht — die entsteht erst, wenn der Flow
  // wirklich durchläuft. Im Browser tut das die Flow-Seite mit ihrem
  // JavaScript; eine Hintergrundanfrage holt nur deren Hülle. Genau daran ist
  // der erste Wurf am 3. August gescheitert: Handschlag angenommen (302 statt
  // 401), und angemeldet war trotzdem niemand.
  //
  // Diese Adresse führt den Flow serverseitig einen Schritt weiter, und dieser
  // eine Schritt ist die Anmeldung.
  SSO_FLOW_URL: 'https://authentik.rosenweg4303.ch/api/v3/flows/executor/default-source-authentication/?query=',
  SSO_PROBE_MS: 2500,
  SSO_PAUSE_KEY: 'rosenweg_sso_pause',
  SSO_PAUSE_MS: 6 * 60 * 60 * 1000,
  // Merker "Anmeldung in diesem Browser gestartet": ein #auth=-Fragment ohne
  // vorherigen login() stammt aus einem fremden Link (Anmeldung unter fremdem
  // Konto unterschieben) und wird verworfen.
  LOGIN_MARKER_KEY: 'rosenweg_login_gestartet',
  LOGIN_MARKER_MS: 15 * 60 * 1000,
  // Schleifensperre: automatische Login-Starts (init ohne Sitzung, 401) je Tab
  // zaehlen. Wird ein Ruecksprung verworfen oder lehnt der Server das Token
  // gleich wieder ab, liefe die Seite sonst endlos zwischen Authentik und hier
  // hin und her (und in die Login-Drossel des Servers).
  AUTO_LOGIN_KEY: 'rosenweg_auto_login',
  AUTO_LOGIN_MAX: 2,
  AUTO_LOGIN_FENSTER_MS: 2 * 60 * 1000,

  async _ssoVersuch() {
    let uhr = null;
    try {
      // Antwortet Authentik gar nicht, soll nicht jede Anmeldung darauf
      // warten. Nach einem Abbruch ein paar Stunden Ruhe.
      const pause = Number(localStorage.getItem(this.SSO_PAUSE_KEY) || 0);
      if (Date.now() < pause) return;

      const abbruch = new AbortController();
      uhr = setTimeout(() => abbruch.abort(), this.SSO_PROBE_MS);
      const holen = (url) => fetch(url, {
        mode: 'no-cors',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: abbruch.signal,
      });
      await holen(this.SSO_PROBE_URL);
      await holen(this.SSO_FLOW_URL);
    } catch (e) {
      try {
        localStorage.setItem(this.SSO_PAUSE_KEY, String(Date.now() + this.SSO_PAUSE_MS));
      } catch (_) { /* privater Modus: dann eben jedes Mal */ }
    } finally {
      if (uhr) clearTimeout(uhr);
    }
  },

  /**
   * Start login - redirect to Authentik via API.
   * opts.reauth: Authentik fragt erneut nach dem Ausweis (Passwortwechsel).
   * opts.auto:   automatischer Start (nicht vom Nutzer geklickt) -> Schleifensperre.
   * Aufruf auch als login({ reauth: true }) moeglich.
   */
  async login(redirectPath, opts = {}) {
    if (redirectPath && typeof redirectPath === 'object') { opts = redirectPath; redirectPath = null; }
    opts = opts || {};
    if (opts.auto && !this._autoLoginErlaubt()) {
      this._meldung('Die automatische Anmeldung wurde angehalten, weil sie mehrmals hintereinander nicht geklappt hat.', true);
      return false;
    }
    const redirect = redirectPath || window.location.pathname;
    // Merker auch fuer reauth noetig, sonst wird der Ruecksprung verworfen
    try { localStorage.setItem(this.LOGIN_MARKER_KEY, String(Date.now())); } catch (_) {}
    // Bei reauth kein stiller Kerberos-Versuch: es soll ja neu gefragt werden
    if (!opts.reauth) await this._ssoVersuch();
    window.location.href = `/api/auth/login?${opts.reauth ? 'reauth=1&' : ''}redirect=${encodeURIComponent(redirect)}`;
    return true;
  },

  // Hoechstens AUTO_LOGIN_MAX automatische Starts je AUTO_LOGIN_FENSTER_MS (je Tab)
  _autoLoginErlaubt() {
    try {
      const jetzt = Date.now();
      let liste = [];
      try { liste = JSON.parse(sessionStorage.getItem(this.AUTO_LOGIN_KEY) || '[]'); } catch (_) {}
      if (!Array.isArray(liste)) liste = [];
      liste = liste.filter(t => typeof t === 'number' && jetzt - t >= 0 && jetzt - t < this.AUTO_LOGIN_FENSTER_MS);
      if (liste.length >= this.AUTO_LOGIN_MAX) return false;
      liste.push(jetzt);
      sessionStorage.setItem(this.AUTO_LOGIN_KEY, JSON.stringify(liste));
    } catch (_) { /* ohne sessionStorage keine Sperre */ }
    return true;
  },

  // Sichtbare Meldung statt stiller Schleife; mitKnopf = Anmelden von Hand anbieten
  _meldung(text, mitKnopf) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return;
      const zeigen = () => {
        let box = document.getElementById('authentik-auth-meldung');
        if (!box) {
          box = document.createElement('div');
          box.id = 'authentik-auth-meldung';
          box.setAttribute('role', 'alert');
          box.style.cssText = 'position:fixed;left:50%;top:1rem;transform:translateX(-50%);z-index:99999;max-width:36rem;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:.5rem;padding:.75rem 1rem;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.15)';
          document.body.appendChild(box);
        }
        box.textContent = text + ' ';
        if (mitKnopf) {
          const b = document.createElement('button');
          b.textContent = 'Jetzt anmelden';
          b.style.cssText = 'margin-left:.5rem;background:#2563eb;color:#fff;border:none;border-radius:.35rem;padding:.3rem .8rem;cursor:pointer;font-weight:600';
          b.onclick = () => this.login();
          box.appendChild(b);
        }
      };
      if (document.body) zeigen();
      else document.addEventListener('DOMContentLoaded', zeigen);
    } catch (_) {}
  },

  // ready aufloesen + Event 'authentik-auth-ready' auf window (nur einmal)
  _fertig(user) {
    if (this._readyErledigt) return;
    this._readyErledigt = true;
    if (this._readyResolve) this._readyResolve(user || null);
    try {
      window.dispatchEvent(new CustomEvent('authentik-auth-ready', { detail: { user: user || null } }));
    } catch (_) {}
  },

  /** Process auth callback from URL hash (after Authentik redirect) */
  // Aus dem Fragment wird nur das Token genommen, und nur wenn die Anmeldung in
  // diesem Browser begonnen wurde. Das Nutzerobjekt im Fragment ist ungeprueft
  // (Rechte/isAdmin frei faelschbar) -> es zaehlt nur, was /api/auth/me liefert.
  // Die Pruefung laeuft im Hintergrund; init() wartet auf _callbackPruefung.
  // Ohne init() (Seiten, die nur handleCallback() rufen) loest ready nach der
  // Pruefung auf, ohne Fragment sofort.
  handleCallback() {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#auth=')) {
      if (!this._inInit) this._fertig(this.getUser());
      return false;
    }
    // Fragment sofort entfernen, egal ob gueltig (Token nicht in Verlauf/Lesezeichen)
    history.replaceState(null, '', window.location.pathname + window.location.search);

    let gestartet = 0;
    try {
      gestartet = Number(localStorage.getItem(this.LOGIN_MARKER_KEY) || 0);
      localStorage.removeItem(this.LOGIN_MARKER_KEY);
    } catch (_) {}
    if (!gestartet || Date.now() - gestartet > this.LOGIN_MARKER_MS) {
      console.warn('Auth-Callback ohne eigene Anmeldung verworfen');
      if (!this._inInit) this._fertig(this.getUser());
      return false;
    }

    try {
      const data = JSON.parse(decodeURIComponent(hash.substring(6)));
      if (data.token && typeof data.token === 'string') {
        localStorage.setItem(this.SESSION_KEY, data.token);
        localStorage.removeItem(this.USER_KEY);
        this._setSharedToken(data.token);
        this._callbackPruefung = this.validateSession();
        if (!this._inInit) this._callbackPruefung.then(() => this._fertig(this.getUser()));
        return true;
      }
    } catch (e) {
      console.error('Auth callback parse error:', e);
    }
    if (!this._inInit) this._fertig(this.getUser());
    return false;
  },

  /** Check if user is logged in (has valid session) */
  isLoggedIn() {
    return !!(localStorage.getItem(this.SESSION_KEY) || this._readSharedToken());
  },

  /** Get stored user data */
  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.USER_KEY));
    } catch {
      return null;
    }
  },

  /** Get session token for API calls (localStorage ODER geteiltes Subdomain-Cookie) */
  getToken() {
    return localStorage.getItem(this.SESSION_KEY) || this._readSharedToken();
  },

  // ── Cross-Subdomain-SSO: Token zusätzlich in einem Cookie auf .rosenweg4303.ch,
  // damit der Login über ALLE Subdomains gilt (www/admin/ausschuss/isp/stweg…). ──
  _cookieDomain() {
    return /rosenweg4303\.ch$/.test(location.hostname) ? '.rosenweg4303.ch' : null; // andere Domains bleiben lokal
  },
  _setSharedToken(token) {
    const dom = this._cookieDomain();
    if (!dom || !token) return;
    const secure = location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${this.SESSION_KEY}=${encodeURIComponent(token)}; domain=${dom}; path=/; max-age=${30 * 24 * 3600}; samesite=lax${secure}`;
  },
  _readSharedToken() {
    const m = document.cookie.match(new RegExp('(?:^|; )' + this.SESSION_KEY + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  },
  _clearSharedToken() {
    const dom = this._cookieDomain();
    const secure = location.protocol === 'https:' ? '; secure' : '';
    if (dom) document.cookie = `${this.SESSION_KEY}=; domain=${dom}; path=/; max-age=0; samesite=lax${secure}`;
  },

  /** Check if current user is admin */
  isAdmin() {
    const user = this.getUser();
    return user?.isAdmin === true;
  },

  /** Check if current user has permission for a page (read/write) */
  hasPermission(page, level = 'read') {
    const user = this.getUser();
    if (!user) return false;
    // Technik and Präsident always have full access
    if (user.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) return true;
    const perms = user.permissions || {};
    const levels = { none: 0, read: 1, write: 2 };
    return (levels[perms[page]] || 0) >= (levels[level] || 0);
  },

  /** Get user's access level for a page (none/read/write) */
  getPermission(page) {
    const user = this.getUser();
    if (!user) return 'none';
    if (user.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) return 'write';
    return user.permissions?.[page] || 'none';
  },

  /** Logout - clear session and end Authentik session */
  logout(redirectTo) {
    const token = this.getToken();
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.USER_KEY);
    this._clearSharedToken();
    if (redirectTo !== false) {
      // Redirect through Authentik's end-session endpoint to fully log out
      const postLogoutRedirect = redirectTo || window.location.origin + window.location.pathname;
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      window.location.href = `/api/auth/logout?redirect=${encodeURIComponent(postLogoutRedirect)}${tokenParam}`;
    }
  },

  /**
   * Validate session against server.
   * true = gueltig, false = abgelehnt (401, Sitzung geloescht),
   * null = nicht pruefbar (5xx/Netz) -> Sitzung bleibt, kein Logout.
   */
  async validateSession() {
    const token = this.getToken();
    if (!token) return false;

    try {
      const resp = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (!data || !data.user) return null;
        localStorage.setItem(this.USER_KEY, JSON.stringify(data.user));
        if (!localStorage.getItem(this.SESSION_KEY)) localStorage.setItem(this.SESSION_KEY, token);
        this._setSharedToken(token); // Cookie-Ablauf mitschieben (Sliding-Session)
        return true;
      }
      // Nur ein klares 401 beendet die Sitzung; ein Serverfehler darf nicht
      // abmelden (sonst login() -> Callback -> 5xx -> Logout -> Schleife).
      if (resp.status === 401) {
        this.logout(false);
        return false;
      }
      return null;
    } catch {
      return null;
    }
  },

  /** Make authenticated API call */
  async apiFetch(url, options = {}) {
    const token = this.getToken();
    const headers = { ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData) && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Uint8Array)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const resp = await fetch(url, { ...options, headers });
    // Session abgelaufen kann sich auf zwei Arten zeigen:
    //   a) API antwortet direkt mit 401 (sauberer Fall)
    //   b) fetch() folgt einem 302 zur Authentik-Login-Seite → resp.url
    //      zeigt dann auf Authentik. resp.redirected ist true.
    // NUR diese beiden Fälle triggern logout, NICHT pauschal HTML.
    const isAuthRedirect = resp.redirected && /authentik|\/application\/o\//i.test(resp.url || '');
    if (resp.status === 401 || isAuthRedirect) {
      this.logout();
      return resp;
    }
    return resp;
  },

  /**
   * Initialize auth on page load.
   * Returns user object if logged in, null otherwise.
   * If requireAuth is true, redirects to login automatically.
   * If requireAdmin is true, shows error for non-admins.
   */
  async init(opts = {}) {
    // Mehrere init()-Aufrufe (nav.js + Seite) teilen sich ready; der erste
    // Abschluss loest auf.
    let user = null;
    this._inInit = (this._inInit || 0) + 1;
    try {
      user = await this._initIntern(opts);
    } finally {
      this._inInit -= 1;
    }
    this._fertig(user);
    return user;
  },

  async _initIntern({ requireAuth = true, requireAdmin = false, onLogin, onLogout } = {}) {
    // Handle OAuth callback (Token wird gegen /api/auth/me geprueft)
    let status = false;
    if (this.handleCallback()) {
      status = await this._callbackPruefung;
    } else if (this.isLoggedIn()) {
      // Check existing session
      status = await this.validateSession();
    }

    if (status === null) {
      // Server/Netz gestoert: Sitzung behalten. Mit bekanntem Nutzer weiterarbeiten,
      // sonst Meldung statt erneuter Anmeldung (die wuerde nichts aendern).
      if (this.getUser() && this.isLoggedIn()) {
        status = true;
      } else {
        this._meldung('Die Anmeldung kann gerade nicht geprüft werden (Serverfehler). Bitte die Seite später neu laden.', false);
        if (onLogout) onLogout('server-error');
        return null;
      }
    }

    if (status === true) {
      const user = this.getUser();
      if (requireAdmin && !user?.isAdmin) {
        if (onLogout) onLogout('no-admin');
        return null;
      }
      if (onLogin) onLogin(user);
      return user;
    }

    // Not logged in
    if (requireAuth) {
      if (onLogout) onLogout('not-logged-in');
      // Auto-redirect to Authentik login (mit Schleifensperre)
      this.login(null, { auto: true });
      return null;
    }
    return null;
  },

  /** Create a standard login button element */
  createLoginButton(container) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    // Inline-Styles (KEIN Tailwind) — der Button muss auch auf Seiten ohne
    // Tailwind-CDN sauber aussehen (sonst der "super hässliche" ungestylte Button).
    container.innerHTML = `
      <div style="text-align:center">
        <button onclick="AuthentikAuth.login()"
          style="display:inline-flex;align-items:center;gap:.6rem;background:#2563eb;color:#fff;border:none;padding:.85rem 1.75rem;border-radius:.6rem;font-weight:600;font-size:1.05rem;cursor:pointer;box-shadow:0 8px 20px rgba(37,99,235,.35);transition:background .15s"
          onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
          <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"></path>
          </svg>
          Mit Rosenweg-Konto anmelden
        </button>
        <p style="color:#6b7280;margin-top:1rem;font-size:.85rem">Sichere Anmeldung über Authentik SSO</p>
      </div>
    `;
  },
};

// AuthentikAuth.ready: loest mit dem Nutzer (oder null) auf, sobald die
// Anmeldung geprueft ist (init() fertig bzw. Callback gegen /api/auth/me
// geprueft). Seiten, die getUser() lesen, warten darauf statt auf Zeitgeber.
AuthentikAuth.ready = new Promise((resolve) => { AuthentikAuth._readyResolve = resolve; });
// Notnagel: ruft eine Seite weder init() noch handleCallback(), haengt ready
// nicht ewig, sondern loest mit dem gespeicherten Stand auf.
setTimeout(() => AuthentikAuth._fertig(AuthentikAuth.getUser()), 15000);
