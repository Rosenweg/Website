/**
 * Shared STWEG Kontakte module
 * Loads Hausverwaltung, Ausschuss and Kontaktliste dynamically from API
 * Usage: STWEGKontakte.init(stwegNr)
 */
const STWEGKontakte = (function() {
    const floorNames = { 'ug': 'Untergeschoss', 'eg': 'Erdgeschoss', '1og': '1. Obergeschoss', '2og': '2. Obergeschoss', '3og': '3. Obergeschoss', 'dg': 'Dachgeschoss' };
    const floorColors = { 'ug': 'orange', 'eg': 'blue', '1og': 'green', '2og': 'purple', '3og': 'teal', 'dg': 'pink' };

    function esc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function loadHausverwaltung(stwegNr) {
        try {
            const v = await SiteConfig.getVerwaltungForStweg(stwegNr);
            const el = document.getElementById('hausverwaltung-card');
            if (!el) return;
            if (!v) {
                el.innerHTML = '<p class="text-sm text-gray-500">Keine Hausverwaltung hinterlegt.</p>';
                return;
            }
            const telDigits = (v.telefon || '').replace(/\s/g, '');
            const webHref = v.website ? (v.website.startsWith('http') ? v.website : 'https://' + v.website) : '';
            el.innerHTML = `
                <div class="flex items-center mb-4">
                    <svg class="h-8 w-8 text-blue-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
                    </svg>
                    <h3 class="text-xl font-semibold">Hausverwaltung</h3>
                </div>
                <p class="text-gray-700 mb-2 font-semibold text-lg">${esc(v.firma)}</p>
                ${v.adresse ? `<p class="text-gray-600 text-sm mb-3 whitespace-pre-line">${esc(v.adresse)}</p>` : ''}
                ${v.telefon ? `<p class="text-gray-600 text-sm mb-2"><strong>Tel:</strong> <a href="tel:${esc(telDigits)}" class="text-blue-600 hover:underline">${esc(v.telefon)}</a></p>` : ''}
                ${v.email ? `<p class="text-gray-600 text-sm mb-2"><strong>E-Mail:</strong> <a href="mailto:${esc(v.email)}" class="text-blue-600 hover:underline">${esc(v.email)}</a></p>` : ''}
                ${v.website ? `<p class="text-gray-600 text-sm mb-3"><strong>Web:</strong> <a href="${esc(webHref)}" target="_blank" class="text-blue-600 hover:underline">${esc(v.website)}</a></p>` : ''}
                ${v.oeffnungszeiten ? `<p class="text-gray-600 text-sm"><strong>Öffnungszeiten:</strong><br>${esc(v.oeffnungszeiten)}</p>` : ''}`;
        } catch(e) { console.error('Verwaltung load error:', e); }
    }

    async function loadKontakte(stwegNr, user) {
        try {
            const res = await AuthentikAuth.apiFetch('/api/stweg/' + stwegNr + '/kontakte');
            if (!res.ok) {
                if (res.status === 403) {
                    var ks = document.getElementById('kontakte-section');
                    if (ks) ks.classList.add('hidden');
                    return;
                }
                throw new Error('API Fehler');
            }
            const data = await res.json();
            renderAusschuss(stwegNr, data.ausschuss);
            if (data.wohnungen && data.wohnungen.length > 0) {
                renderKontakte(data.wohnungen);
                var ks = document.getElementById('kontakte-section');
                if (ks) ks.classList.remove('hidden');
            }
        } catch(e) {
            console.error('Kontakte error:', e);
            var ac = document.getElementById('ausschuss-card');
            if (ac) ac.innerHTML = '<p class="text-red-600 text-sm">Fehler beim Laden der Ausschuss-Daten</p>';
        }
    }

    function renderAusschuss(stwegNr, ausschuss) {
        var el = document.getElementById('ausschuss-card');
        if (!el) return;
        var names = ausschuss.map(function(a) { return esc(a.name) + ' (' + esc(a.funktion) + ')'; }).join(' &bull; ');
        el.innerHTML = `
            <div class="flex items-center mb-4">
                <svg class="h-8 w-8 text-blue-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                </svg>
                <h3 class="text-xl font-semibold">Ausschuss-Vertreter STWEG ${stwegNr}</h3>
            </div>
            <div class="border-l-4 border-blue-500 pl-4 py-3 bg-blue-50 rounded">
                <p class="font-semibold text-gray-800 mb-2">Ihre Ausschussvertreter</p>
                <p class="text-sm text-gray-600 mb-2">${names}</p>
                ${ausschuss.map(function(a) { return `
                    <div class="text-sm text-gray-600 mt-2">
                        <strong>${esc(a.name)}</strong>
                        ${a.email ? ' &mdash; <a href="mailto:' + esc(a.email) + '" class="text-blue-600 hover:underline">' + esc(a.email) + '</a>' : ''}
                        ${a.telefon ? ' &mdash; <a href="tel:' + esc(a.telefon.replace(/\s/g,'')) + '" class="text-blue-600 hover:underline">' + esc(a.telefon) + '</a>' : ''}
                    </div>
                `; }).join('')}
            </div>`;
    }

    function renderKontakte(wohnungen) {
        var container = document.getElementById('kontakte-list');
        if (!container) return;

        // Group by floor
        var floors = {};
        for (var i = 0; i < wohnungen.length; i++) {
            var w = wohnungen[i];
            var m = w.bezeichnung.toLowerCase().match(/^(\d*[a-z]+)/);
            var floorKey = m ? m[1] : 'sonstige';
            if (!floors[floorKey]) floors[floorKey] = [];
            floors[floorKey].push(w);
        }

        var html = '';
        for (var key in floors) {
            var wohnungenInFloor = floors[key];
            var floorName = floorNames[key] || key.toUpperCase();
            var color = floorColors[key] || 'gray';
            html += '<div class="border-l-4 border-' + color + '-500 bg-' + color + '-50 p-4 rounded-lg">';
            html += '<h3 class="font-semibold text-lg text-' + color + '-800 mb-3">' + floorName + '</h3>';

            for (var j = 0; j < wohnungenInFloor.length; j++) {
                var w = wohnungenInFloor[j];
                var isLast = j === wohnungenInFloor.length - 1;
                html += '<div class="bg-white p-4 rounded-lg ' + (!isLast ? 'mb-3' : '') + '">';
                html += '<div class="mb-2"><span class="bg-' + color + '-100 text-' + color + '-800 px-2 py-1 rounded text-sm font-semibold">' + esc(w.bezeichnung) + '</span></div>';
                html += '<div class="space-y-2">';

                for (var k = 0; k < w.bewohner.length; k++) {
                    var person = w.bewohner[k];
                    var rolleLabel = person.rolle === 'eigentuemer' ? 'Eigentümer' : 'Mieter';
                    var isSelfOwner = person.rolle === 'eigentuemer' && w.bewohner.length === 1;
                    var displayRolle = isSelfOwner ? 'Eigentümer (Selbstbewohner)' : rolleLabel;
                    html += '<div>';
                    html += '<p class="font-semibold text-gray-800">' + esc(person.name) + '</p>';
                    if (person.email) html += '<p class="text-sm text-gray-600">&#x1F4E7; <a href="mailto:' + esc(person.email) + '" class="text-blue-600 hover:underline">' + esc(person.email) + '</a></p>';
                    if (person.telefon) html += '<p class="text-sm text-gray-600">&#x1F4F1; <a href="tel:' + esc(person.telefon.replace(/\s/g,'')) + '" class="text-blue-600 hover:underline">' + esc(person.telefon) + '</a></p>';
                    html += '<p class="text-xs text-gray-500 mt-1">' + displayRolle + '</p>';
                    html += '</div>';
                    if (person.rolle === 'eigentuemer' && w.bewohner.length > 1) {
                        html += '<div class="border-t border-gray-200 mt-2 pt-2"></div>';
                    }
                }

                html += '</div></div>';
            }
            html += '</div>';
        }
        container.innerHTML = html;
    }

    async function showLoginState(stwegNr) {
        // Load public Ausschuss data even without login
        try {
            const resp = await fetch('/api/public/ausschuss');
            if (resp.ok) {
                const data = await resp.json();
                const stwegData = (data.vertreter || []).find(s => s.stweg_nummer === stwegNr);
                const vertreter = stwegData?.vertreter || [];
                if (vertreter.length > 0) {
                    renderAusschuss(stwegNr, vertreter.map(v => ({
                        name: v.name, funktion: v.funktion || 'Vertreter',
                        email: null, telefon: null,
                    })));
                    // Add STWEG-specific email from verteiler
                    try {
                        const vResp = await fetch('/api/verteiler/by-stweg/' + stwegNr);
                        if (vResp.ok) {
                            const verteiler = await vResp.json();
                            const stweg = verteiler.find(v => v.name.toLowerCase().includes('ausschuss')) || verteiler[0];
                            if (stweg) {
                                const ac = document.getElementById('ausschuss-card');
                                if (ac) {
                                    ac.innerHTML += `<div class="mt-3 pt-3 border-t">
                                        <p class="text-sm text-gray-600">E-Mail: <a href="mailto:${esc(stweg.email_address)}" class="text-blue-600 hover:underline">${esc(stweg.email_address)}</a></p>
                                    </div>`;
                                }
                            }
                        }
                    } catch(e) {}
                    return;
                }
            }
        } catch(e) {}
        var ac = document.getElementById('ausschuss-card');
        if (ac) {
            ac.innerHTML = `
                <div class="flex items-center mb-4">
                    <svg class="h-8 w-8 text-blue-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                    </svg>
                    <h3 class="text-xl font-semibold">Ausschuss-Vertreter STWEG ${stwegNr}</h3>
                </div>
                <p class="text-sm text-gray-600">Ausschuss-Daten nicht verfuegbar.</p>`;
        }
        var loginEl = document.getElementById('kontakte-login');
        if (loginEl) {
            loginEl.classList.remove('hidden');
            var btn = document.getElementById('kontakte-login-btn');
            if (btn) btn.addEventListener('click', function() { AuthentikAuth.login(); });
        }
    }

    function init(stwegNr) {
        loadHausverwaltung(stwegNr);

        function checkAuth() {
            if (typeof AuthentikAuth === 'undefined') return;
            var user = AuthentikAuth.getUser();
            if (user && AuthentikAuth.isLoggedIn()) {
                loadKontakte(stwegNr, user);
            } else {
                showLoginState(stwegNr);
            }
        }
        // nav.js init is async, wait a tick for it to complete
        setTimeout(checkAuth, 500);
    }

    return { init: init };
})();
