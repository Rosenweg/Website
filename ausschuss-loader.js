/**
 * Ausschuss-Loader für STWEG-Kooperation Rosenweg
 * Lädt die Ausschussmitglieder aus ausschuss-kontakte.json und zeigt sie an
 */

// Ausschussmitglieder aus JSON laden
async function loadAusschuss() {
    try {
        const response = await fetch('ausschuss-kontakte.json');
        if (!response.ok) {
            throw new Error('Ausschuss-Daten konnten nicht geladen werden');
        }
        const data = await response.json();
        renderAusschuss(data);
        updateLastUpdate(data);
    } catch (error) {
        console.error('Fehler beim Laden der Ausschuss-Daten:', error);
        // Fallback: Zeige Hinweistext
        const container = document.getElementById('ausschuss-liste');
        if (container) {
            container.innerHTML = `
                <div class="text-sm text-gray-600 bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
                    <p class="font-semibold mb-1">⚠️ Hinweis</p>
                    <p>Die Ausschussmitglieder-Liste konnte nicht automatisch geladen werden.</p>
                    <p class="mt-2 text-xs">Bitte wenden Sie sich an die Hausverwaltung für aktuelle Kontaktdaten oder prüfen Sie, ob die Datei "ausschuss-kontakte.json" vorhanden ist.</p>
                </div>
            `;
        }
    }
}

function renderAusschuss(data) {
    const container = document.getElementById('ausschuss-liste');
    if (!container) {
        console.warn('Container "ausschuss-liste" nicht gefunden');
        return;
    }

    let html = '';
    
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