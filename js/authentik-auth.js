/**
 * Authentik SSO Authentication Module
 * Shared across all Rosenweg pages
 */
const AuthentikAuth = {
  SESSION_KEY: 'rosenweg_session',
  USER_KEY: 'rosenweg_user',

  /** Start login - redirect to Authentik via API */
  login(redirectPath) {
    const redirect = redirectPath || window.location.pathname;
    window.location.href = `/api/auth/login?redirect=${encodeURIComponent(redirect)}`;
  },

  /** Process auth callback from URL hash (after Authentik redirect) */
  handleCallback() {
    const hash = window.location.hash;
    if (!hash.startsWith('#auth=')) return false;

    try {
      const data = JSON.parse(decodeURIComponent(hash.substring(6)));
      if (data.token && data.user) {
        localStorage.setItem(this.SESSION_KEY, data.token);
        localStorage.setItem(this.USER_KEY, JSON.stringify(data.user));
        // Clean URL hash
        history.replaceState(null, '', window.location.pathname + window.location.search);
        return true;
      }
    } catch (e) {
      console.error('Auth callback parse error:', e);
    }
    return false;
  },

  /** Check if user is logged in (has valid session) */
  isLoggedIn() {
    return !!localStorage.getItem(this.SESSION_KEY);
  },

  /** Get stored user data */
  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.USER_KEY));
    } catch {
      return null;
    }
  },

  /** Get session token for API calls */
  getToken() {
    return localStorage.getItem(this.SESSION_KEY);
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
    const token = localStorage.getItem(this.SESSION_KEY);
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.USER_KEY);
    if (redirectTo !== false) {
      // Redirect through Authentik's end-session endpoint to fully log out
      const postLogoutRedirect = redirectTo || window.location.origin + window.location.pathname;
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      window.location.href = `/api/auth/logout?redirect=${encodeURIComponent(postLogoutRedirect)}${tokenParam}`;
    }
  },

  /** Validate session against server */
  async validateSession() {
    const token = this.getToken();
    if (!token) return false;

    try {
      const resp = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        localStorage.setItem(this.USER_KEY, JSON.stringify(data.user));
        return true;
      }
      this.logout(false);
      return false;
    } catch {
      return false;
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
    // NUR diese beiden Faelle triggern logout, NICHT pauschal HTML.
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
  async init({ requireAuth = true, requireAdmin = false, onLogin, onLogout } = {}) {
    // Handle OAuth callback
    if (this.handleCallback()) {
      if (onLogin) onLogin(this.getUser());
      return this.getUser();
    }

    // Check existing session
    if (this.isLoggedIn()) {
      const valid = await this.validateSession();
      if (valid) {
        const user = this.getUser();
        if (requireAdmin && !user.isAdmin) {
          if (onLogout) onLogout('no-admin');
          return null;
        }
        if (onLogin) onLogin(user);
        return user;
      }
    }

    // Not logged in
    if (requireAuth) {
      if (onLogout) onLogout('not-logged-in');
      // Auto-redirect to Authentik login
      this.login();
      return null;
    }
    return null;
  },

  /** Create a standard login button element */
  createLoginButton(container) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    container.innerHTML = `
      <div class="text-center">
        <button onclick="AuthentikAuth.login()"
          class="inline-flex items-center gap-3 bg-blue-600 text-white px-8 py-4 rounded-lg hover:bg-blue-700 transition font-semibold text-lg shadow-lg">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"></path>
          </svg>
          Mit Rosenweg-Konto anmelden
        </button>
        <p class="text-gray-500 mt-4 text-sm">Sichere Anmeldung über Authentik SSO</p>
      </div>
    `;
  },
};
