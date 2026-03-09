/**
 * Waschküche API Client - Authentik SSO Implementation
 * Verwendet AuthentikAuth für Anmeldung, API-Backend für Daten
 */

const WaschkuecheAPI = {
    API_DEVICE_CONTROL: '/api/devices',

    /** Start SSO login */
    login(redirectPath) {
        AuthentikAuth.login(redirectPath || window.location.pathname);
    },

    /** Check if logged in */
    isLoggedIn() {
        return AuthentikAuth.isLoggedIn();
    },

    /** Get current user */
    getUser() {
        return AuthentikAuth.getUser();
    },

    /** Check admin status */
    isAdmin() {
        return AuthentikAuth.isAdmin();
    },

    /** Get auth token */
    getToken() {
        return AuthentikAuth.getToken();
    },

    /** Logout */
    logout() {
        AuthentikAuth.logout();
    },

    /** Authenticated API fetch */
    async apiFetch(url, options = {}) {
        return AuthentikAuth.apiFetch(url, options);
    },

    /** Shelly API - Get device status via API backend */
    async getDeviceStatus(deviceId) {
        try {
            const resp = await this.apiFetch(`/api/devices/${deviceId}/status`);
            return await resp.json();
        } catch (error) {
            console.error('Device status error:', error);
            return null;
        }
    },

    /** Shelly API - Control device via API backend */
    async controlDevice(deviceId, action) {
        try {
            const resp = await this.apiFetch(`/api/devices/${deviceId}/control`, {
                method: 'POST',
                body: { action },
            });
            return await resp.json();
        } catch (error) {
            console.error('Device control error:', error);
            return null;
        }
    },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WaschkuecheAPI;
}
