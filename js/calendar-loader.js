/**
 * Calendar-Loader für STWEG-Kooperation Rosenweg
 * Lädt Termine aus Google Calendar via API-Proxy
 */

const CALENDAR_CONFIG = {
    API_URL: '/api/calendar',
    API_TIMEOUT: 8000,
    MAX_EVENTS: 10,
};

// Farbzuweisung basierend auf Schlüsselwörtern im Titel
function getEventColor(title) {
    const t = title.toLowerCase();
    if (t.includes('hauptversammlung') || t.includes('versammlung')) return 'purple';
    if (t.includes('ausschuss') || t.includes('sitzung')) return 'blue';
    if (t.includes('wartung') || t.includes('reparatur') || t.includes('sanierung')) return 'green';
    if (t.includes('reinigung') || t.includes('putz')) return 'yellow';
    if (t.includes('entsorgung') || t.includes('sperrmüll') || t.includes('müll')) return 'orange';
    return 'indigo';
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

    // All-day event (format: YYYY-MM-DD without time)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return date.toLocaleDateString('de-CH', options);
    }

    const dateFormatted = date.toLocaleDateString('de-CH', options);
    const timeFormatted = date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    return `${dateFormatted}, ${timeFormatted} Uhr`;
}

function renderEvents(events) {
    const container = document.getElementById('calendar-events');
    if (!container) return;

    if (!events || events.length === 0) {
        container.innerHTML = `
            <div class="text-center text-gray-500 py-8">
                <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
                <p>Keine anstehenden Termine</p>
            </div>`;
        return;
    }

    const displayed = events.slice(0, CALENDAR_CONFIG.MAX_EVENTS);
    container.innerHTML = displayed.map(event => {
        const color = getEventColor(event.title);
        const isHighlight = color === 'purple';
        const bgClass = isHighlight ? `bg-${color}-50` : '';
        const pyClass = isHighlight ? 'py-3' : 'py-2';
        const titleClass = isHighlight ? 'text-lg' : '';

        let html = `<div class="border-l-4 border-${color}-600 pl-4 ${pyClass} ${bgClass}">`;
        html += `<p class="font-semibold text-gray-800 ${titleClass}">${escapeHtml(event.title)}</p>`;
        html += `<p class="text-gray-600 text-sm mt-1">${formatDate(event.start)}</p>`;

        if (event.location) {
            html += `<p class="text-gray-600 text-sm"><strong>Ort:</strong> ${escapeHtml(event.location)}</p>`;
        }
        if (event.description) {
            html += `<p class="text-gray-500 text-xs mt-1">${escapeHtml(event.description)}</p>`;
        }
        html += '</div>';
        return html;
    }).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderLoading() {
    const container = document.getElementById('calendar-events');
    if (!container) return;
    container.innerHTML = `
        <div class="text-center text-gray-400 py-8">
            <div class="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-500 rounded-full mx-auto mb-3"></div>
            <p>Termine werden geladen...</p>
        </div>`;
}

function renderError() {
    const container = document.getElementById('calendar-events');
    if (!container) return;
    container.innerHTML = `
        <div class="text-center text-gray-500 py-8">
            <svg class="w-12 h-12 mx-auto mb-3 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
            </svg>
            <p>Termine konnten nicht geladen werden</p>
        </div>`;
}

async function loadCalendar() {
    renderLoading();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALENDAR_CONFIG.API_TIMEOUT);

    try {
        const response = await fetch(CALENDAR_CONFIG.API_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderEvents(data.events);
    } catch (err) {
        clearTimeout(timeout);
        console.error('Calendar load failed:', err.message);
        renderError();
    }
}

// Load when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCalendar);
} else {
    loadCalendar();
}
