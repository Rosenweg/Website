/**
 * Seite /apps: alle Rosenweg-Apps als Kacheln, live aus dem Index der Telefonanlage
 * (https://pbx.rosenweg4303.ch/api/apps/index.json, Feld 'liste'; siehe pbx/api/app.py _apps_liste).
 * Nichts ist hier fest eingetragen: welche Apps es gibt, Logo, Satz, Version und Downloads kommen aus dem Index.
 * Fehlt 'liste' (ältere API), wird sie aus 'karten' und 'apps' zusammengesetzt.
 */
(function () {
    'use strict';
    const BASIS = 'https://pbx.rosenweg4303.ch';
    const INDEX = BASIS + '/api/apps/index.json';

    const PLATTFORM = {   // Index-Plattform -> Anzeige und Gerätefamilie des Besuchers
        'android':   { titel: 'Android', familie: 'android' },
        'linux-deb': { titel: 'Linux (.deb)', familie: 'linux' },
        'windows':   { titel: 'Windows', familie: 'windows' },
        'macos':     { titel: 'macOS', familie: 'macos' },
        'ios':       { titel: 'iOS', familie: 'ios' },
    };
    const REIHE = ['android', 'linux-deb', 'windows', 'macos', 'ios'];
    const ICON = {
        android: '<path d="M7 10v6M17 10v6M9 18v2M15 18v2M6 9h12v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1zM8 6.5 6.5 4.5M16 6.5l1.5-2M6.5 9a5.5 5 0 0 1 11 0"/>',
        linux: '<path d="M12 3c-2 0-3 1.7-3 4 0 1.5-.6 2.6-1.6 4C6 13 5 15 6 17.5M12 3c2 0 3 1.7 3 4 0 1.5.6 2.6 1.6 4 1.4 2 2.4 4 1.4 6.5M7 19c1.5 1.3 3 2 5 2s3.5-.7 5-2M10 7.5h.01M14 7.5h.01M10.5 10h3l-1.5 1.5z"/>',
        windows: '<path d="M4 6.5 11 5.5v6H4zM13 5.2 20 4v7.5h-7zM4 13h7v6l-7-1zM13 13h7v7l-7-1.2z"/>',
        macos: '<path d="M15.5 3.5c-.9.1-2 .7-2.6 1.5-.6.7-1 1.7-.9 2.6 1 .1 2-.5 2.6-1.3.6-.8 1-1.8.9-2.8zM16.4 8c-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.9-.7-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.7 1.1 8.9.8 1 1.6 2.2 2.8 2.1 1.1 0 1.5-.7 2.9-.7 1.3 0 1.7.7 2.9.7 1.2 0 1.9-1.1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.5 0 0-2.3-.9-2.3-3.5 0-2.2 1.8-3.2 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7z"/>',
        ios: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
        telefon: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2M10 7l1.5 1.5L14 6"/>',
    };
    const svg = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>';

    const $ = (id) => document.getElementById(id);
    const kacheln = $('kacheln');
    const state = { liste: [], gruppe: '', suche: '' };

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null && text !== '') e.textContent = text;
        return e;
    }
    const mb = (b) => b ? (b / 1048576).toLocaleString('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' MB' : '';
    function datum(s) {
        if (!s) return '';
        const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
        return isNaN(d) ? '' : d.toLocaleDateString('de-CH', { day: 'numeric', month: 'numeric', year: 'numeric' });
    }
    // Logos werden lange zwischengespeichert (immutable): neue Fassung = neues ?v= im Register
    const sichererPfad = (p) => /^\/[A-Za-z0-9/_.-]+(\?v=[A-Za-z0-9]{1,20})?$/.test(p || '') ? p : '/logo-rosenweg.png';
    const sichereUrl = (p) => /^\/api\/apps\/[A-Za-z0-9/_.-]+$/.test(p || '') ? BASIS + p : null;

    // Gerätefamilie des Besuchers (nur zum Hervorheben, nichts wird versteckt)
    function besucher() {
        const ua = navigator.userAgent || '';
        const pf = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
        if (/Android/i.test(ua)) return 'android';
        if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(pf) && navigator.maxTouchPoints > 1)) return 'ios';
        if (/Win/i.test(pf) || /Windows/i.test(ua)) return 'windows';
        if (/Mac/i.test(pf) || /Macintosh/i.test(ua)) return 'macos';
        if (/Linux|X11|CrOS/i.test(pf + ua)) return 'linux';
        return '';
    }
    const DEINS = besucher();

    // Ältere API ohne 'liste': aus karten + apps zusammensetzen
    function listeAusAlt(d) {
        const karten = d.karten || [];
        const mitKarte = new Set(karten.map(k => k.paket));
        const l = karten.map(k => ({
            paket: k.paket, name: k.name, text: k.text, fuer: k.fuer, logo: k.logo, logos: k.logos, downloads: k.downloads,
            gruppen: [k.downloads.some(x => x.plattform === 'android') ? 'handy' : null,
                      k.downloads.some(x => x.plattform !== 'android') ? 'computer' : null].filter(Boolean),
            version: (k.downloads[0] || {}).version, stand: (k.downloads[0] || {}).stand,
        }));
        for (const a of d.apps || []) {
            if (mitKarte.has(a.paket)) continue;
            l.push({ paket: a.paket, name: a.name, text: '', fuer: '', logo: '', gruppen: ['handy', 'telefone'],
                     geteilte_telefone: true, version: a.version_name, stand: a.stand,
                     downloads: [{ plattform: 'android', titel: 'Android', version: a.version_name, groesse: a.groesse,
                                   sha256: a.sha256, stand: a.stand, url: a.url, notiz: a.notiz }] });
        }
        return l;
    }

    function knopf(dl) {
        const url = sichereUrl(dl.url);
        if (!url) return null;
        const pf = PLATTFORM[dl.plattform] || { titel: dl.titel || dl.plattform, familie: '' };
        const a = el('a', 'knopf' + (pf.familie && pf.familie === DEINS ? ' deins' : ''));
        a.href = url;
        a.setAttribute('download', '');
        a.innerHTML = svg(pf.familie);
        const t = el('span');
        t.append(document.createTextNode(pf.titel));
        t.append(el('small', '', [dl.version ? 'Version ' + dl.version : '', mb(dl.groesse)].filter(Boolean).join(' · ')));
        a.append(t);
        a.setAttribute('aria-label', `${pf.titel} herunterladen` + (dl.version ? `, Version ${dl.version}` : '') + (dl.groesse ? `, ${mb(dl.groesse)}` : ''));
        return a;
    }

    function kachel(app) {
        const k = el('article', 'kachel');
        const downloads = (app.downloads || []).slice()
            .sort((x, y) => REIHE.indexOf(x.plattform) - REIHE.indexOf(y.plattform));

        const oben = el('div', 'oben');
        // Symbol je Gruppenfarbe nebeneinander: rot = Standard, blau = Verwaltung/Ausschuss, grün = Technik
        const logos = el('div', 'logos');
        const symbol = (pfad, farbe, hinweis) => {
            const img = el('img');
            img.src = sichererPfad(pfad);
            img.alt = `Logo ${app.name}, ${farbe}`;
            img.title = `${farbe}: ${hinweis}`;
            img.width = 56; img.height = 56;
            img.loading = 'lazy';
            img.onerror = () => { img.onerror = null; img.src = '/logo-rosenweg.png'; };
            logos.append(img);
        };
        symbol(app.logo, 'Rot', 'Standard');
        const mehrfarbig = app.logos || {};
        if (mehrfarbig.blau) symbol(mehrfarbig.blau, 'Blau', 'wenn du in der Verwaltung oder im Ausschuss bist');
        if (mehrfarbig.gruen) symbol(mehrfarbig.gruen, 'Grün', 'wenn du zur Technik gehörst');
        if (logos.children.length > 1) logos.setAttribute('aria-label', 'Symbol je nach Gruppe: rot, blau, grün');
        logos.classList.toggle('mehrere', logos.children.length > 1);
        const kopf = el('div');
        kopf.append(el('h3', '', app.name));
        if (app.text) kopf.append(el('p', 'satz', app.text));
        if (app.fuer) kopf.append(el('p', 'fuer', app.fuer));
        oben.classList.toggle('mehrfarbig', logos.children.length > 1);
        oben.append(logos, kopf);
        k.append(oben);

        const gruppen = app.gruppen || [];
        const marken = el('div', 'marken');
        if (gruppen.includes('telefone')) marken.append(el('span', 'marke telefone', 'Kommt automatisch auf die geteilten Telefone'));
        if (gruppen.includes('technik')) marken.append(el('span', 'marke technik', 'Technik'));
        if (marken.children.length) k.append(marken);

        if (app.nur_anzeige || !downloads.length) {
            const n = el('div', 'nur-telefone');
            n.innerHTML = svg('telefon');
            n.append(el('span', '', 'Nur auf den geteilten Telefonen, kommt automatisch.'));
            k.append(n);
        } else {
            const kn = el('div', 'knoepfe');
            downloads.map(knopf).filter(Boolean).forEach(a => kn.append(a));
            k.append(kn);
        }

        const meta = el('div', 'meta');
        if (app.version) meta.append(el('span', '', 'Version ' + app.version));
        if (datum(app.stand)) meta.append(el('span', '', 'vom ' + datum(app.stand)));
        if (meta.children.length) k.append(meta);

        if (!app.nur_anzeige && downloads.length) k.append(mehr(app, downloads));
        return k;
    }

    // Aufklappbar: Neu in der Version, QR-Code (Android) und Prüfsummen
    function mehr(app, downloads) {
        const det = el('details', 'mehr');
        // QR-Code nur am Computer: auf dem Handy lädt der Knopf direkt
        const android = DEINS !== 'android' && DEINS !== 'ios' && downloads.find(d => d.plattform === 'android' && sichereUrl(d.url));
        const neu = downloads.find(d => d.notiz);
        det.append(el('summary', '', [neu ? 'Neuigkeiten' : '', android ? 'QR-Code' : '', 'Prüfsumme'].filter(Boolean).join(', ')));
        const innen = el('div', 'innen');
        if (neu) {
            const n = el('div');
            n.append(el('b', '', 'Neu in Version ' + neu.version), el('div', 'notiz', neu.notiz));
            innen.append(n);
        }
        if (android) {
            const q = el('div', 'qr');
            const c = el('canvas');
            c.setAttribute('role', 'img');
            c.setAttribute('aria-label', 'QR-Code zum Herunterladen von ' + app.name + ' auf dem Handy');
            q.append(c, el('span', 'leise', 'Mit der Kamera des Android-Handys scannen, um die App dort zu laden.'));
            innen.append(q);
            det.addEventListener('toggle', () => {
                if (!det.open || c.dataset.fertig || !window.QRious) return;
                new QRious({ element: c, value: sichereUrl(android.url), size: 232, level: 'M', foreground: '#0f172a' });
                c.dataset.fertig = '1';
            });
        }
        for (const d of downloads) {
            if (!d.sha256) continue;
            const p = el('div');
            p.append(el('div', '', `SHA-256 ${(PLATTFORM[d.plattform] || {}).titel || d.plattform}` + (d.stand ? ` (${datum(d.stand)})` : '')));
            p.append(el('div', 'pruef', d.sha256));
            innen.append(p);
        }
        det.append(innen);
        return det;
    }

    function passt(app) {
        if (state.gruppe && !(app.gruppen || []).includes(state.gruppe)) return false;
        if (!state.suche) return true;
        const s = state.suche.toLowerCase();
        return [app.name, app.text, app.fuer].some(t => (t || '').toLowerCase().includes(s));
    }

    function zeigen() {
        const treffer = state.liste.filter(passt);
        kacheln.textContent = '';
        if (!treffer.length) {
            const m = el('div', 'meldung');
            m.append(el('p', '', state.liste.length ? 'Keine App passt zu dieser Auswahl.' : 'Im Moment sind keine Apps freigegeben.'));
            if (state.liste.length) {
                const b = el('button', '', 'Alle zeigen');
                b.type = 'button';
                b.onclick = () => { $('suche').value = ''; state.suche = ''; waehlen(''); };
                m.append(b);
            }
            kacheln.append(m);
        } else {
            treffer.forEach(a => kacheln.append(kachel(a)));
        }
        $('ansage').textContent = treffer.length === 1 ? '1 App' : treffer.length + ' Apps';
    }

    function zaehlen() {
        document.querySelectorAll('#filter button').forEach(b => {
            const g = b.dataset.gruppe;
            const n = state.liste.filter(a => !g || (a.gruppen || []).includes(g)).length;
            b.querySelector('.zahl').textContent = n;
            b.hidden = !!g && n === 0;
        });
    }

    function waehlen(g) {
        state.gruppe = g;
        document.querySelectorAll('#filter button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gruppe === g)));
        try { history.replaceState(null, '', g ? '#' + g : location.pathname + location.search); } catch (e) { /* egal */ }
        zeigen();
    }

    function fehler() {
        kacheln.textContent = '';
        const m = el('div', 'meldung');
        m.append(el('p', '', 'Die Liste der Apps ist gerade nicht erreichbar.'),
                 el('p', 'leise klein', 'Bitte später nochmals versuchen. Hält es an: Ressort Technik.'));
        const b = el('button', '', 'Nochmals laden');
        b.type = 'button';
        b.onclick = laden;
        m.append(b);
        kacheln.append(m);
        $('ansage').textContent = 'Die Liste der Apps ist gerade nicht erreichbar.';
    }

    async function laden() {
        kacheln.setAttribute('aria-busy', 'true');
        try {
            const r = await fetch(INDEX, { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();
            if (d.signatur_sha256) $('signatur').textContent = d.signatur_sha256;
            state.liste = Array.isArray(d.liste) ? d.liste : listeAusAlt(d);
            // Alphabetisch nach Namen, ohne das vorangestellte "Rosenweg" (Stefan 28.11.2026)
            const ohneVorsatz = n => String(n || '').replace(/^Rosenweg\s+/i, '');
            state.liste.sort((a, b) => ohneVorsatz(a.name).localeCompare(ohneVorsatz(b.name), 'de-CH', { sensitivity: 'base' }));
            zaehlen();
            hinweis();
            const g = decodeURIComponent(location.hash.slice(1));
            // Ohne Auswahl im Link: auf dem Android-Handy gleich die Apps fürs Handy zeigen
            const start = ['handy', 'computer', 'telefone', 'technik'].includes(g) ? g
                : (state.erstesMal !== false && DEINS === 'android' ? 'handy' : state.gruppe);
            state.erstesMal = false;
            waehlen(start);
        } catch (e) {
            fehler();
        } finally {
            kacheln.setAttribute('aria-busy', 'false');
        }
    }

    // Filter, Suche, Hinweis zur eigenen Plattform
    document.querySelectorAll('#filter button').forEach(b => b.addEventListener('click', () => waehlen(b.dataset.gruppe)));
    $('suche').addEventListener('input', (e) => { state.suche = e.target.value.trim(); zeigen(); });
    const NAME = { android: 'Android', ios: 'iPhone/iPad', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
    function hinweis() {
        if (!DEINS) return;
        const h = $('hinweisPlattform');
        const da = state.liste.some(a => (a.downloads || []).some(d => (PLATTFORM[d.plattform] || {}).familie === DEINS));
        h.textContent = da
            ? `Du bist auf ${NAME[DEINS]}: die passenden Downloads sind blau hervorgehoben.`
            : `Für ${NAME[DEINS]} gibt es noch keine Rosenweg-Apps zum Laden.`;
        h.hidden = false;
        const a = document.querySelector(`#anleitungen [data-plattform="${DEINS}"]`);
        if (a) a.classList.add('deins');
    }
    laden();
})();
