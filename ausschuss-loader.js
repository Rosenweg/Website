/**
 * Ausschuss-Loader für STWEG-Kooperation Rosenweg
 * Lädt die Ausschussmitglieder aus der API (mit IP-basierter Zugriffskontrolle)
 * Fallback: Lokale ausschuss-kontakte.json
 */

// Konfiguration
const CONFIG = {
    // API-URL für Cloudflare Worker
    // Nach Deployment: Ersetzen Sie dies mit Ihrer Worker-URL
    // z.B. 'https://ausschuss-api.your-subdomain.workers.dev/ausschuss-kontakte'
    // oder 'https://api.rosenweg4303.ch/ausschuss-kontakte'
    API_URL: 'https://ausschuss-api.rosenweg4303.workers.dev',

    // Fallback zur lokalen JSON (für Entwicklung oder wenn API nicht verfügbar)
    FALLBACK_JSON: 'ausschuss-kontakte.json',

    // API-Timeout in Millisekunden
    API_TIMEOUT: 5000
};

// Ausschussmitglieder aus API oder JSON laden
async function loadAusschuss() {
    try {
        // Versuche zuerst, Daten von der API zu laden
        const data = await loadFromAPI();
        renderAusschuss(data);
        updateLastUpdate(data);
        showAccessLevel(data._meta?.access_level);
    } catch (apiError) {
        console.warn('API nicht verfügbar, verwende Fallback:', apiError.message);

        try {
            // Fallback: Lade lokale JSON-Datei
            const data = await loadFromLocal();
            renderAusschuss(data);
            updateLastUpdate(data);
            showAccessLevel('fallback');
        } catch (localError) {
            console.error('Fehler beim Laden der Ausschuss-Daten:', localError);
            showErrorMessage();
        }
    }
}

// Lädt Daten von der Cloudflare Worker API
async function loadFromAPI() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT);

    try {
        const response = await fetch(CONFIG.API_URL, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json'
            }
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('✅ Daten erfolgreich von API geladen');
        console.log('Zugriffslevel:', data._meta?.access_level);

        return data;
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error('API-Timeout');
        }
        throw error;
    }
}

// Lädt Daten von lokaler JSON-Datei (Fallback)
async function loadFromLocal() {
    const response = await fetch(CONFIG.FALLBACK_JSON);
    if (!response.ok) {
        throw new Error('Lokale JSON-Datei konnte nicht geladen werden');
    }

    console.log('ℹ️  Daten von lokaler JSON-Datei geladen (Fallback)');
    return await response.json();
}

// Zeigt eine Fehlermeldung an
function showErrorMessage() {
    const container = document.getElementById('ausschuss-liste');
    if (container) {
        container.innerHTML = `
            <div class="text-sm text-gray-600 bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
                <p class="font-semibold mb-1">⚠️ Hinweis</p>
                <p>Die Ausschussmitglieder-Liste konnte nicht automatisch geladen werden.</p>
                <p class="mt-2 text-xs">Bitte wenden Sie sich an die Hausverwaltung für aktuelle Kontaktdaten.</p>
            </div>
        `;
    }
}

// Zeigt den Zugriffslevel an (nur in Console, optional im UI)
function showAccessLevel(accessLevel) {
    if (!accessLevel) return;

    const messages = {
        'full': '🔓 Vollzugriff: Sie sehen alle Kontaktdaten inkl. Telefonnummern',
        'public': '🔒 Öffentlicher Zugriff: Telefonnummern sind ausgeblendet',
        'fallback': 'ℹ️  Fallback-Modus: Lokale Daten werden angezeigt'
    };

    console.log(messages[accessLevel] || `Zugriffslevel: ${accessLevel}`);
}

function renderAusschuss(data) {
    const container = document.getElementById('ausschuss-liste');
    if (!container) {
        console.warn('Container "ausschuss-liste" nicht gefunden');
        return;
    }

    let html = '';
    
    // Präsident anzeigen (falls vorhanden)
    if (data.ausschuss.präsident) {
        const präsident = data.ausschuss.präsident;
        html += `
            <div class="border-l-4 border-yellow-500 pl-3 py-3 bg-yellow-50 rounded mb-3">
                <p class="text-sm font-semibold text-yellow-800 mb-1">🏆 Präsident des Ausschusses</p>
                <p class="text-sm font-bold text-gray-700">${präsident.name_vollständig}</p>
                <p class="text-xs text-gray-600">STWEG ${präsident.stweg_nummer}</p>
                ${präsident.telefon ? `<p class="text-xs text-gray-600">📞 ${präsident.telefon}</p>` : ''}
                <p class="text-xs text-gray-600">📧 <a href="mailto:${präsident.email}" class="text-blue-600 hover:underline">${präsident.email}</a></p>
            </div>
        `;
    }

    // Durch alle STWEGs iterieren (1-8)
    data.ausschuss.vertreter.forEach(stweg => {
        const borderColor = stweg.stweg_nummer === 8 ? 'green-500' : 'blue-400';
        const bgColor = stweg.stweg_nummer === 8 ? 'green-50' : 'gray-50';
        const label = stweg.stweg_nummer === 8 ? ' (Tiefgarage)' : '';

        html += `
            <div class="border-l-4 border-${borderColor} pl-3 py-2 bg-${bgColor} rounded">
                <p class="text-sm font-semibold text-gray-700 mb-1">STWEG ${stweg.stweg_nummer}${label}</p>
        `;

        // Vertreter mit Namen anzeigen
        const vertreterNames = stweg.vertreter.map(v => v.name_vollständig).join(' • ');
        html += `<p class="text-sm text-gray-600">${vertreterNames}</p>`;

        // E-Mail-Adresse anzeigen (falls vorhanden)
        if (stweg.email) {
            html += `<p class="text-xs text-gray-600 mt-1">📧 <a href="mailto:${stweg.email}" class="text-blue-600 hover:underline">${stweg.email}</a></p>`;
        }

        // Telefonnummern anzeigen (nur bei voller Berechtigung verfügbar)
        if (stweg.vertreter && stweg.vertreter.some(v => v.telefon)) {
            const telefonnummern = stweg.vertreter
                .filter(v => v.telefon)
                .map(v => `${v.name_vollständig}: ${v.telefon}`)
                .join(' • ');
            html += `<p class="text-xs text-gray-600 mt-1">📞 ${telefonnummern}</p>`;
        }

        html += '</div>';
    });

    container.innerHTML = html;
}

function updateLastUpdate(data) {
    const updateElement = document.getElementById('ausschuss-last-update');
    if (updateElement && data.stweg_kooperation.letzte_aktualisierung) {
        const date = new Date(data.stweg_kooperation.letzte_aktualisierung);
        const formatted = date.toLocaleDateString('de-CH', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        updateElement.textContent = `Letzte Aktualisierung: ${formatted}`;
    }
}

// Beim Laden der Seite Ausschuss laden
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAusschuss);
} else {
    loadAusschuss();
}