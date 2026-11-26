// ─── Meine Handys: jedes eigene Handy genau einmal, darunter seine Rosenweg-Apps ───
//
// Stefan 26.11.2026 zu /smartphones: "ist nur 1 Telefon – so sieht es aus, als wären es
// 4 Geräte". Rosenweg Telefon (Anlage, telefon_sip_privat), Rosenweg Messenger
// (messenger_privat) und die Karten-Sitzungen der Apps (app_karten_sitzungen) liegen in
// drei Tabellen; hier werden sie je Handy zusammengelegt.
//
// Zusammenlegen: alle drei Quellen liefern geraet_gruppe (Gruppenschluessel je Person aus
// der gemeinsamen Geraetekennung der Rosenweg-Apps, api/lib/geraet-gruppe.js). Aeltere
// Eintraege ohne Kennung: nach Modellname ("samsung SM-A376B") – als "vermutlich dasselbe
// Handy" gekennzeichnet. Innerhalb eines Handys ist jede App eine Zeile; die Karten-Sitzung
// einer App (z.B. Telefon mit der Karte angemeldet) steht in derselben Zeile.
//
// Gebraucht von smartphones.html und profil.html (#app-sitzungen).
(function () {
    const APP_TELEFON = 'ch.rosenweg4303.phone';
    const APP_MESSENGER = 'ch.rosenweg4303.messages';
    const PBX = 'https://pbx.rosenweg4303.ch';

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const datum = t => t ? new Date(String(t).replace(' ', 'T') + (/[zZ+]/.test(String(t).slice(10)) ? '' : 'Z')) : null;
    const zeit = t => { const d = datum(t); return d && !isNaN(d) ? d.toLocaleString('de-CH', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : ''; };
    const modell = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    /** Rohdaten der drei Quellen -> einheitliche Eintraege (ein Eintrag = eine Anmeldung). */
    function eintraege({ telefon = [], messenger = [], karten = [] }) {
        const xs = [];
        telefon.forEach(p => xs.push({
            quelle: 'telefon', id: p.id, app: APP_TELEFON, appName: 'Rosenweg Telefon',
            geraet: p.geraet, gruppe: p.geraet_gruppe || null, seit: p.seit, online: !!p.registriert,
            text: `Zugang ${p.kennung}`,
        }));
        messenger.forEach(z => xs.push({
            quelle: 'messenger', id: z.id, app: APP_MESSENGER, appName: 'Rosenweg Messenger',
            geraet: z.geraet, gruppe: z.geraet_gruppe || null, seit: z.seit, zuletzt: z.zuletzt,
        }));
        karten.forEach(s => xs.push({
            quelle: 'karte', id: s.id, app: s.app, appName: s.app_name || s.app,
            geraet: s.geraet_name, gruppe: s.geraet_gruppe || null, seit: s.created_at, zuletzt: s.last_used_at,
            text: `mit der Karte …${s.karte_anzeige || ''}` + (s.expires_at ? ` · gilt bis ${zeit(s.expires_at).slice(0, 6)}` : ''),
        }));
        return xs;
    }

    /** Eintraege -> Handys [{name, vermutlich, apps:[{app, name, eintraege}]}] */
    function gruppieren(xs) {
        const handys = new Map();
        const neu = (schluessel, e) => {
            const h = { schluessel, name: '', vermutlich: false, eintraege: [] };
            handys.set(schluessel, h);
            return h;
        };
        xs.filter(e => e.gruppe).forEach(e => (handys.get('g:' + e.gruppe) || neu('g:' + e.gruppe)).eintraege.push(e));
        // Ohne Kennung (aeltere App-Versionen): zu dem Handy mit gleichem Modell, wenn es genau
        // eines gibt, sonst nach Modell zusammen. Beides nur "vermutlich".
        xs.filter(e => !e.gruppe).forEach(e => {
            const m = modell(e.geraet);
            const passend = [...handys.values()].filter(h => h.schluessel.startsWith('g:')
                && h.eintraege.some(x => modell(x.geraet) === m));
            const h = passend.length === 1 ? passend[0] : (handys.get('m:' + m) || neu('m:' + m, e));
            e.vermutlich = true;
            h.eintraege.push(e);
        });
        return [...handys.values()].map(h => {
            const namen = h.eintraege.map(e => e.geraet).filter(Boolean);
            h.name = namen.find(n => /\s/.test(n)) || namen[0] || 'Eigenes Handy';
            // "vermutlich": ein Eintrag ohne Kennung steht mit anderen zusammen
            h.vermutlich = h.eintraege.length > 1 && h.eintraege.some(e => e.vermutlich);
            const apps = new Map();
            h.eintraege.forEach(e => {
                const a = apps.get(e.app) || { app: e.app, name: e.appName, eintraege: [] };
                if (e.quelle !== 'karte') a.name = e.appName;
                a.eintraege.push(e);
                apps.set(e.app, a);
            });
            const rang = a => a.app === APP_TELEFON ? 0 : a.app === APP_MESSENGER ? 1 : 2;
            h.apps = [...apps.values()].sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name, 'de'));
            h.zuletzt = h.eintraege.map(e => datum(e.zuletzt || e.seit)).filter(Boolean).sort((a, b) => b - a)[0] || null;
            return h;
        }).sort((a, b) => (b.zuletzt || 0) - (a.zuletzt || 0));
    }

    function appZeile(a, hi, ai) {
        const zeilen = a.eintraege.map(e => {
            const teile = [];
            if (e.quelle === 'telefon') teile.push(`<span class="inline-block w-2 h-2 rounded-full align-middle" style="background:${e.online ? '#16a34a' : '#cbd5e1'}" title="${e.online ? 'mit der Anlage verbunden' : 'gerade nicht verbunden'}"></span> ${e.online ? 'verbunden' : 'nicht verbunden'}`);
            if (e.text) teile.push(esc(e.text));
            if (e.seit) teile.push('seit ' + esc(zeit(e.seit)));
            if (e.zuletzt) teile.push('zuletzt ' + esc(zeit(e.zuletzt)));
            return `<div>${teile.join(' · ')}</div>`;
        }).join('');
        return `<li class="py-2 flex items-center gap-3">
            <div class="flex-1 min-w-0"><div class="font-medium">${esc(a.name)}</div><div class="text-xs text-slate-500">${zeilen}</div></div>
            <button class="px-3 py-1 rounded-lg text-sm bg-slate-200 hover:bg-slate-300 whitespace-nowrap" data-rg-app="${hi}:${ai}">Abmelden</button></li>`;
    }

    function handyKarte(h, hi) {
        const hinweis = h.vermutlich
            ? `<div class="text-xs text-amber-700 mt-0.5">Vermutlich dasselbe Handy (gleiches Modell) – ältere App-Versionen melden noch keine Gerätekennung.</div>` : '';
        const alle = h.apps.length > 1
            ? `<div class="text-right pt-2 border-t"><button class="px-3 py-1 rounded-lg text-sm bg-red-100 text-red-800 hover:bg-red-200" data-rg-handy="${hi}">Alle Apps auf diesem Handy abmelden</button></div>` : '';
        return `<div class="border rounded-lg p-3">
            <div><b>📱 ${esc(h.name)}</b> <span class="text-xs text-slate-500">· ${h.apps.length} ${h.apps.length === 1 ? 'App' : 'Apps'}</span>${hinweis}</div>
            <ul class="divide-y text-sm mt-1 pl-1">${h.apps.map((a, ai) => appZeile(a, hi, ai)).join('')}</ul>
            ${alle}
        </div>`;
    }

    /**
     * In el anzeigen. opts:
     *   pbx(pfad, opts), web(pfad, opts): fetch-Funktionen (Standard: AuthentikAuth.apiFetch)
     *   telefon: privat-Liste aus /api/telefon/meine, wenn die Seite sie schon hat
     *   melde(text, fehler): Rueckmeldung (Standard: alert bei Fehler)
     *   leer: Text ohne Handy
     * Gibt die Zahl der Handys zurueck.
     */
    async function anzeigen(el, opts = {}) {
        const web = opts.web || ((p, o) => AuthentikAuth.apiFetch(p, o));
        const pbx = opts.pbx || ((p, o) => AuthentikAuth.apiFetch(PBX + p, o));
        const melde = opts.melde || ((t, f) => { if (f) alert(t); });
        const json = r => r.json().catch(() => ({}));
        const fehlt = [];
        const holen = async (wer, f, feld) => {
            try {
                const r = await f();
                if (!r.ok) throw new Error(String(r.status));
                return (await json(r))[feld] || [];
            } catch (e) { if (e.message === 'auth') throw e; fehlt.push(wer); return []; }
        };
        const [telefon, messenger, karten] = await Promise.all([
            opts.telefon ? Promise.resolve(opts.telefon) : holen('Rosenweg Telefon', () => pbx('/api/telefon/meine'), 'privat'),
            holen('Rosenweg Messenger', () => web('/api/messenger/zugaenge'), 'zugaenge'),
            holen('Karten-Anmeldungen', () => web('/api/apps/sitzungen'), 'sitzungen'),
        ]);
        const handys = gruppieren(eintraege({ telefon, messenger, karten }));
        el.innerHTML = (handys.map(handyKarte).join('') ||
                `<div class="text-sm text-slate-500 py-2">${esc(opts.leer || 'Auf keinem eigenen Handy angemeldet.')}</div>`)
            + (fehlt.length ? `<div class="text-xs text-amber-700 mt-1">Nicht erreichbar, fehlt darum hier: ${esc(fehlt.join(', '))}.</div>` : '');

        const nochmals = () => anzeigen(el, { ...opts, telefon: undefined }).catch(() => {});
        async function abmelden(es) {
            let ok = 0; const fehler = [];
            for (const e of es) {
                const r = await (e.quelle === 'telefon' ? pbx('/api/telefon/privat/' + Number(e.id), {method: 'DELETE'})
                    : e.quelle === 'messenger' ? web('/api/messenger/zugaenge/' + Number(e.id), {method: 'DELETE'})
                    : web('/api/apps/sitzungen/' + encodeURIComponent(e.id), {method: 'DELETE'})).catch(() => null);
                if (r && r.ok) ok++; else fehler.push(e.appName + ': ' + ((r && (await json(r)).error) || 'Fehler'));
            }
            if (fehler.length) melde(fehler.join(' · '), true);
            if (opts.nachher) opts.nachher();
            nochmals();
            return ok;
        }
        const folgen = es => [
            es.some(e => e.quelle === 'telefon') ? 'Deine Nummer klingelt dort dann nicht mehr.' : '',
            es.some(e => e.quelle === 'messenger') ? 'Der Messenger löscht dort beim nächsten Kontakt seine Chats.' : '',
            'Neu anmelden geht jederzeit in der App.',
        ].filter(Boolean).join(' ');
        el.querySelectorAll('[data-rg-app]').forEach(b => b.onclick = async () => {
            const [hi, ai] = b.dataset.rgApp.split(':').map(Number);
            const h = handys[hi], a = h.apps[ai];
            if (!confirm(`${a.name} auf ${h.name} abmelden? ${folgen(a.eintraege)}`)) return;
            if (await abmelden(a.eintraege)) melde(`${a.name} auf ${h.name} abgemeldet.`);
        });
        el.querySelectorAll('[data-rg-handy]').forEach(b => b.onclick = async () => {
            const h = handys[Number(b.dataset.rgHandy)];
            const es = h.apps.flatMap(a => a.eintraege);
            if (!confirm(`Alle Rosenweg-Apps auf ${h.name} abmelden (${h.apps.map(a => a.name).join(', ')})? ${folgen(es)}`)) return;
            if (await abmelden(es)) melde(`Alle Apps auf ${h.name} abgemeldet.`);
        });
        return handys.length;
    }

    window.RosenwegGeraete = { anzeigen, gruppieren, eintraege };
})();
