/**
 * Waschküche API Client - JSON-basierte Static Site Implementation
 * Verwendet N8N-Webhook für OTP-Versand und lokale JSON-Dateien
 */

const WaschkuecheAPI = {
    // Konfiguration
    dataPath: 'waschkueche-data',
    N8N_WEBHOOK_URL: 'https://n8n.juroct.net/webhook/stweg3-otp',
    N8N_DEVICE_WEBHOOK_URL: 'https://n8n.juroct.net/webhook/stweg3-waschkueche-device',

    // E-Mail-Whitelisten
    USER_EMAILS: [
        'max.mustermann@example.com',
        'anna.schmidt@example.com',
        'peter.weber@example.com',
        'maria.mueller@example.com',
        'stefan.meier@example.com'
    ],

    ADMIN_EMAILS: [
        'stefan+rosenweg@juroct.ch',
        'fersztand.basil@teleport.ch',
        'hello@langpartners.ch'
    ],

    // OTP-Storage (für Session-Management)
    currentOTP: null,
    otpTimestamp: null,

    /**
     * Generiert einen 6-stelligen OTP-Code
     */
    generateOTP() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    },

    /**
     * Prüft, ob eine E-Mail berechtigt ist
     */
    isEmailAuthorized(email) {
        return this.USER_EMAILS.includes(email) || this.ADMIN_EMAILS.includes(email);
    },

    /**
     * Prüft, ob eine E-Mail Admin-Rechte hat
     */
    isAdmin(email) {
        return this.ADMIN_EMAILS.includes(email);
    },

    /**
     * Lädt JSON-Datei
     */
    async loadJSON(filename) {
        try {
            const response = await fetch(`${this.dataPath}/${filename}`);
            if (!response.ok) throw new Error(`Failed to load ${filename}`);
            return await response.json();
        } catch (error) {
            console.error(`Error loading ${filename}:`, error);
            throw error;
        }
    },

    /**
     * Sendet OTP-Code via N8N-Webhook
     */
    async sendOTP(email) {
        if (!this.isEmailAuthorized(email)) {
            throw new Error('E-Mail-Adresse nicht berechtigt');
        }

        const otpCode = this.generateOTP();
        this.currentOTP = otpCode;
        this.otpTimestamp = Date.now();

        try {
            const response = await fetch(this.N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: email,
                    otp_code: otpCode  // N8N erwartet "otp_code" (mit Unterstrich)
                })
            });

            if (!response.ok) {
                throw new Error('Fehler beim Senden des OTP-Codes');
            }

            return { success: true, message: 'OTP wurde per E-Mail gesendet' };
        } catch (error) {
            console.error('N8N Webhook Fehler:', error);
            throw new Error('Fehler beim Senden der E-Mail. Bitte versuchen Sie es erneut.');
        }
    },

    /**
     * Verifiziert OTP-Code
     */
    async verifyOTP(email, code) {
        // Prüfe ob Code existiert
        if (!this.currentOTP) {
            throw new Error('Kein OTP gefunden. Bitte fordern Sie einen neuen Code an.');
        }

        // Prüfe ob Code abgelaufen (10 Minuten)
        const OTP_VALIDITY = 10 * 60 * 1000; // 10 Minuten
        if (Date.now() - this.otpTimestamp > OTP_VALIDITY) {
            this.currentOTP = null;
            throw new Error('OTP-Code ist abgelaufen. Bitte fordern Sie einen neuen Code an.');
        }

        // Prüfe Code
        if (this.currentOTP !== code) {
            throw new Error('Ungültiger OTP-Code');
        }

        // Code ist gültig - lösche ihn (Einmalverwendung)
        this.currentOTP = null;

        // Erstelle Session-Token
        const sessionToken = btoa(JSON.stringify({
            email,
            isAdmin: this.isAdmin(email),
            loginTime: new Date().toISOString()
        }));

        localStorage.setItem('waschkueche_session', sessionToken);

        return {
            success: true,
            token: sessionToken,
            isAdmin: this.isAdmin(email)
        };
    },

    /**
     * Lädt aktuelle Session
     */
    getSession() {
        const sessionToken = localStorage.getItem('waschkueche_session');
        if (!sessionToken) return null;

        try {
            return JSON.parse(atob(sessionToken));
        } catch {
            return null;
        }
    },

    /**
     * Beendet Session
     */
    logout() {
        localStorage.removeItem('waschkueche_session');
    },

    /**
     * Lädt alle Benutzer
     */
    async getUsers() {
        const data = await this.loadJSON('users.json');
        return data.users;
    },

    /**
     * Findet Benutzer anhand der E-Mail
     */
    async getUserByEmail(email) {
        const users = await this.getUsers();
        return users.find(u => u.email === email);
    },

    /**
     * Lädt alle Geräte
     */
    async getDevices() {
        const data = await this.loadJSON('devices.json');
        return data.devices;
    },

    /**
     * Lädt alle Sessions
     */
    async getSessions(userId = null) {
        const data = await this.loadJSON('sessions.json');
        let sessions = data.sessions;

        if (userId) {
            sessions = sessions.filter(s => s.user_id === userId);
        }

        // Lade zusätzliche Informationen
        const users = await this.getUsers();
        const devices = await this.getDevices();

        return sessions.map(session => {
            const user = users.find(u => u.id === session.user_id);
            const device = devices.find(d => d.id === session.device_id);

            return {
                ...session,
                user_name: user ? user.name : 'Unbekannt',
                user_wohnung: user ? user.wohnung : '-',
                device_name: device ? device.device_name : 'Unbekannt',
                device_location: device ? device.location : '-'
            };
        });
    },

    /**
     * Lädt Transaktionen
     */
    async getTransactions(userId = null) {
        const data = await this.loadJSON('transactions.json');
        let transactions = data.transactions;

        if (userId) {
            transactions = transactions.filter(t => t.user_id === userId);
        }

        return transactions.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
        );
    },

    /**
     * Berechnet Statistiken
     */
    async getStatistics(userId = null) {
        const sessions = await this.getSessions(userId);
        const transactions = await getTransactions(userId);
        const users = userId ? [await this.getUserByEmail(userId)] : await this.getUsers();

        const completedSessions = sessions.filter(s => s.status === 'completed');

        const totalEnergy = completedSessions.reduce((sum, s) => sum + (s.energy_consumed || 0), 0);
        const totalCost = completedSessions.reduce((sum, s) => sum + (s.cost || 0), 0);
        const balance = users.reduce((sum, u) => sum + (u.balance || 0), 0);

        return {
            totalSessions: completedSessions.length,
            totalEnergy: totalEnergy.toFixed(2),
            totalCost: totalCost.toFixed(2),
            balance: balance.toFixed(2),
            activeSessions: sessions.filter(s => s.status === 'active').length
        };
    },

    /**
     * Shelly API - Holt Gerätestatus
     */
    async getShellyStatus(ip) {
        try {
            // HINWEIS: Dies funktioniert nur im lokalen Netzwerk
            // Alternativ: Shelly Cloud API verwenden
            const response = await fetch(`http://${ip}/rpc/Switch.GetStatus?id=0`);
            return await response.json();
        } catch (error) {
            console.error('Shelly API Fehler:', error);
            return null;
        }
    },

    /**
     * Shelly API - Schaltet Gerät ein/aus
     */
    async setShellySwitch(ip, state) {
        try {
            const response = await fetch(`http://${ip}/rpc/Switch.Set?id=0&on=${state}`);
            return await response.json();
        } catch (error) {
            console.error('Shelly API Fehler:', error);
            return null;
        }
    },

    /**
     * Shelly API - Holt Energiedaten
     */
    async getShellyEnergy(ip) {
        try {
            const response = await fetch(`http://${ip}/rpc/Switch.GetStatus?id=0`);
            const data = await response.json();

            return {
                power: data.apower || 0,
                voltage: data.voltage || 0,
                current: data.current || 0,
                totalEnergy: (data.aenergy?.total || 0) / 1000, // Wh -> kWh
                isOn: data.output || false
            };
        } catch (error) {
            console.error('Shelly API Fehler:', error);
            return null;
        }
    }
};

// Export für Module
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WaschkuecheAPI;
}
