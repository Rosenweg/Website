// noc-cockpit — das Lagebild, einmal geschrieben, an zwei Orten benutzt.
//
// Bis zum 5.9.2026 gab es zwei Umsetzungen desselben Monitorings: das
// Cockpit in isp-admin.html (Dienst-Ampeln, Kontingent, Top-Sender, Pfade)
// und das Wandbild noc-fullscreen.html (Dienstwacht, Nextcloud, Mail-
// Warteschlangen, WAN-Durchsatz). Beide zeigten dieselben Anlagen, aber
// nie dasselbe Bild — was in der einen ergaenzt wurde, fehlte in der
// anderen. Diese Datei ist die Vereinigung: jede Kachel aus beiden.
//
// Verwendung:
//   NocCockpit.starten(document.getElementById('noc'), { modus: 'wandbild' })
//   NocCockpit.starten(ziel, { modus: 'eingebettet', intervallMs: 30000 })
//
// Wege zu den Zahlen — dieselbe Wahl wie bisher im Wandbild:
//   Token (?token=… oder Option)  → oeffentliche Endpunkte mit X-Noc-Token
//   angemeldet                    → geschuetzte Endpunkte ueber Authentik
//   sonst                         → oeffentliche Endpunkte ohne Ausweis
// Der Token wandert aus der Adresszeile, sobald er gelesen ist: sonst steht
// er im nginx-Protokoll, im Verlauf, im Referer und auf dem Bildschirm.
(function (global) {
  'use strict';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CSS = `
    .noc-cockpit { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border: 1px solid #334155; color: #cbd5e1; position: relative; overflow: hidden; }
    .noc-cockpit::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0); background-size: 24px 24px; pointer-events: none; }
    .noc-inner { position: relative; padding: 1.25rem; }
    .noc-tile { background: rgba(15,23,42,0.6); border: 1px solid #334155; border-radius: .65rem; padding: .85rem; min-width: 0; }
    .noc-label { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; margin-bottom: .25rem; }
    .noc-big { font-size: 1.85rem; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .noc-mid { font-size: 1.15rem; font-weight: 600; color: #f1f5f9; font-variant-numeric: tabular-nums; line-height: 1.15; }
    .noc-wert { margin-left: auto; font-family: ui-monospace, monospace; font-size: .72rem; color: #f1f5f9; font-variant-numeric: tabular-nums; }
    .noc-svc { display: flex; align-items: center; gap: .5rem; background: rgba(15,23,42,0.5); border: 1px solid #334155; padding: .4rem .6rem; border-radius: .5rem; }
    .noc-led { width: .55rem; height: .55rem; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 6px rgba(148,163,184,0.5); display: inline-block; flex-shrink: 0; }
    .led-green { background: #34d399; box-shadow: 0 0 8px #34d399; animation: noc-pulse 2s infinite; }
    .led-amber { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; }
    .led-red   { background: #f87171; box-shadow: 0 0 8px #f87171; animation: noc-pulse 1s infinite; }
    @keyframes noc-pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
    .noc-pill { display: inline-flex; align-items: center; gap: .4rem; background: rgba(15,23,42,.6); border: 1px solid #334155; border-radius: .35rem; padding: .15rem .5rem; }
    .noc-pill span:last-child { font-family: ui-monospace, monospace; font-size: .62rem; text-transform: uppercase; color: #cbd5e1; }
    .noc-bar { height: .25rem; background: #334155; border-radius: 9999px; overflow: hidden; }
    .noc-bar > div { height: 100%; background: #06b6d4; }
    .noc-zeile { display: grid; grid-template-columns: 1fr auto; gap: .5rem; align-items: center; font-size: .75rem; }
    .noc-zeile > .noc-bar { grid-column: span 2; }
    .noc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; color: #cbd5e1; }
    .noc-zahl { font-family: ui-monospace, monospace; color: #e2e8f0; font-variant-numeric: tabular-nums; }
    .noc-gitter { display: grid; gap: .75rem; grid-template-columns: repeat(2, minmax(0,1fr)); }
    @media (min-width: 1024px) { .noc-gitter { grid-template-columns: repeat(4, minmax(0,1fr)); } }
    .noc-breit { grid-column: span 2; }
    .noc-leise { font-size: .62rem; color: #94a3b8; font-family: ui-monospace, monospace; margin-top: .25rem; line-height: 1.5; }
    .noc-fehler { background: rgba(136,19,55,.4); border: 1px solid #9f1239; color: #fecdd3; border-radius: .5rem; padding: .6rem .8rem; margin-bottom: .75rem; font-size: .8rem; }
    /* Wandbild: dieselben Kacheln, nur groesser — es haengt an der Wand. */
    .noc-wandbild .noc-big { font-size: 2.6rem; }
    .noc-wandbild .noc-mid { font-size: 1.5rem; }
    .noc-wandbild .noc-label { font-size: .72rem; }
    .noc-wandbild .noc-inner { padding: 1.5rem; }
  `;

  const KOPF = (modus) => `
    <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
      <div class="flex items-center gap-3">
        <span class="noc-led" data-el="led-overall"></span>
        <h2 class="text-lg font-bold text-slate-100 tracking-wide">NETWORK · OPS · COCKPIT</h2>
        <span class="text-xs text-slate-400 font-mono" data-el="zeit">—</span>
        ${modus === 'wandbild' ? '<span class="text-xs text-slate-500 font-mono">UTC <span data-el="utc"></span></span>' : ''}
      </div>
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span data-el="takt">Auto-Refresh</span>
        <button data-el="jetzt" class="text-slate-200 hover:text-white border border-slate-600 hover:border-slate-400 px-2 py-0.5 rounded font-mono">↻ NOW</button>
      </div>
    </div>
    <div data-el="fehler" class="noc-fehler" hidden></div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4" data-el="dienste">
      ${['pmg:PMG', 'mailcow:Mailcow', 'smtp2go:SMTP2GO', 'quarantine:Quarantine', 'webmail:Webmail'].map((s) => {
        const [k, l] = s.split(':');
        return `<div class="noc-svc" data-svc="${k}"><span class="noc-led led-amber"></span><span class="text-xs text-slate-300">${l}</span></div>`;
      }).join('')}
      ${[['wacht', 'Dienstwacht'], ['nextcloud', 'Nextcloud'], ['q-relay', 'Relay-Queue'], ['q-pmg', 'PMG-Queue']].map(([k, l]) =>
        `<div class="noc-svc" data-svc="${k}"><span class="noc-led led-amber"></span><span class="text-xs text-slate-300">${l}</span>` +
        `<span class="noc-wert" data-el="${k}">—</span></div>`).join('')}
    </div>`;

  const MAIL = `
    <div class="noc-gitter">
      <div class="noc-tile noc-breit">
        <div class="noc-label">Outbound · <span data-el="monat">—</span></div>
        <div class="flex items-baseline gap-2">
          <span class="noc-big" data-el="out-total">—</span>
          <span class="text-xs text-slate-400">/ <span data-el="out-limit">1000</span> free</span>
        </div>
        <div class="mt-2">
          <div class="h-1.5 bg-slate-700 rounded-full overflow-hidden"><div data-el="out-bar" style="width:0%;height:100%;background:#10b981;transition:width .3s"></div></div>
          <div class="flex justify-between text-[10px] text-slate-400 font-mono mt-1">
            <span><span data-el="out-pct">0</span>%</span><span data-el="out-state">OK</span>
          </div>
        </div>
        <div class="noc-leise" data-el="out-quelle"></div>
      </div>

      <div class="noc-tile">
        <div class="noc-label">Mail-Relays</div>
        <div class="noc-big" data-el="relays">—</div>
        <div class="noc-leise"><span data-el="relays-managed">0</span> managed · <span data-el="relays-smart">0</span> smarthost</div>
      </div>

      <div class="noc-tile noc-breit">
        <div class="noc-label">Anschlüsse</div>
        <div class="flex items-baseline gap-4">
          <div><span class="noc-big" data-el="subs">—</span><div class="noc-leise" style="margin-top:0">Client-Anschlüsse</div></div>
          <div><span class="noc-big text-cyan-300" data-el="vpn">—</span><div class="noc-leise" style="margin-top:0">VPN aktiv</div></div>
        </div>
        <div data-el="anschluss-liste" class="flex flex-wrap gap-1.5 mt-2"></div>
        <div class="noc-leise"><span data-el="vpn-conn" class="text-emerald-300">0</span> VPN verbunden · <span data-el="vpn-pen" class="text-amber-300">0</span> pending<span data-el="anschluss-mac"></span></div>
      </div>

      <div class="noc-tile noc-breit">
        <div class="noc-label flex justify-between"><span>Top Sender (Monat)</span><span class="text-[10px] text-slate-400" data-el="top-meta">—</span></div>
        <div data-el="top-list" class="space-y-1 mt-1"><div class="text-xs text-slate-500 font-mono">lade…</div></div>
      </div>

      <div class="noc-tile">
        <div class="noc-label">Pending</div>
        <div class="noc-big" data-el="pending">—</div>
        <div class="noc-leise"><div><span data-el="pending-mb">0</span> Mailbox-Anträge</div><div><span data-el="pending-vlan">0</span> Netzwerk-Anträge</div></div>
      </div>

      <div class="noc-tile">
        <div class="noc-label">Pfade · live</div>
        <div class="noc-leise" style="margin-top:.35rem">
          <div>:25 → PMG inbound</div><div>:587/465 → submission</div>
          <div>:993 → IMAPS passthrough</div><div class="text-slate-500">→ SMTP2GO outbound</div>
        </div>
      </div>

    </div>`;

  const UNIFI = `
    <div class="flex items-center justify-between mt-5 mb-2">
      <div class="flex items-center gap-2">
        <span class="noc-led led-amber" data-el="led-unifi"></span>
        <span class="text-[11px] font-mono uppercase tracking-wider text-slate-300">UniFi · Site Default</span>
        <span class="text-[10px] text-slate-500 font-mono" data-el="wan-ip"></span>
      </div>
      <span class="text-[10px] text-slate-500 font-mono" data-el="unifi-fehler"></span>
    </div>
    <div class="noc-gitter">
      <div class="noc-tile">
        <div class="noc-label">Geräte online</div>
        <div class="flex items-baseline gap-2"><span class="noc-big" data-el="dev-online">—</span><span class="text-xs text-slate-400">/ <span data-el="dev-total">0</span></span></div>
        <div class="noc-leise"><span data-el="dev-ap">0</span> APs · <span data-el="dev-sw">0</span> Switches · <span data-el="dev-gw">0</span> GW</div>
      </div>

      <div class="noc-tile">
        <div class="noc-label">Clients</div>
        <div class="noc-big" data-el="cli-total">—</div>
        <div class="noc-leise"><span data-el="cli-wifi">0</span> WiFi · <span data-el="cli-wired">0</span> wired · <span data-el="cli-guest">0</span> guest</div>
      </div>

      <!-- WAN mit Durchsatz und Verlauf — beides kam bisher nur im Wandbild vor -->
      <div class="noc-tile noc-breit">
        <div class="noc-label">WAN</div>
        <div class="flex items-baseline gap-3"><span class="noc-big" data-el="wan-state">—</span><span class="text-xs text-slate-400 font-mono" data-el="wan-gw">—</span></div>
        <div class="grid grid-cols-2 gap-3 mt-2">
          <div><div class="noc-label" style="margin:0">↓ Down</div><div class="noc-mid text-cyan-300" data-el="wan-rx">—</div></div>
          <div><div class="noc-label" style="margin:0">↑ Up</div><div class="noc-mid text-emerald-300" data-el="wan-tx">—</div></div>
        </div>
        <svg data-el="wan-graph" viewBox="0 0 200 60" preserveAspectRatio="none" class="w-full h-14 mt-2 bg-slate-800/40 rounded"></svg>
        <div class="noc-leise" data-el="wan-uptime">—</div>
      </div>

      <div class="noc-tile">
        <div class="noc-label">WLANs</div>
        <div class="flex items-baseline gap-2"><span class="noc-big" data-el="wlan-on">—</span><span class="text-xs text-slate-400">/ <span data-el="wlan-total">0</span> total</span></div>
        <div class="noc-leise">aktiv broadcast</div>
      </div>

      <div class="noc-tile noc-breit">
        <div class="noc-label flex justify-between"><span>Top APs (nach Clients)</span><span class="text-[10px] text-slate-400" data-el="aps-meta">—</span></div>
        <div data-el="aps-list" class="space-y-1 mt-1"><div class="text-xs text-slate-500 font-mono">lade…</div></div>
      </div>

      <div class="noc-tile noc-breit">
        <div class="noc-label">Subsystems</div>
        <div data-el="subsysteme" class="flex flex-wrap gap-1.5 mt-1"><span class="text-xs text-slate-500 font-mono">lade…</span></div>
      </div>
    </div>`;

  function cssEinmal() {
    if (document.getElementById('noc-cockpit-css')) return;
    const st = document.createElement('style');
    st.id = 'noc-cockpit-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const fmtRate = (bytesProSek) => {
    if (!bytesProSek || bytesProSek < 1) return '0 bps';
    const u = ['', 'K', 'M', 'G', 'T'];
    let v = bytesProSek * 8, i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + u[i] + 'bps';
  };
  const fmtDauer = (s) => {
    if (!s) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  };
  const balken = (name, zahl, anteil, titel) => `
    <div class="noc-zeile">
      <div class="noc-name" title="${esc(titel || name)}">${esc(name)}</div>
      <div class="noc-zahl">${esc(zahl)}</div>
      <div class="noc-bar"><div style="width:${anteil.toFixed(1)}%"></div></div>
    </div>`;
  const punkt = (ok, text, titel) => `
    <span class="noc-pill"${titel ? ` title="${esc(titel)}"` : ''}>
      <span class="noc-led ${ok === 'warn' ? 'led-amber' : ok ? 'led-green' : 'led-red'}"></span><span>${esc(text)}</span>
    </span>`;

  function starten(ziel, opts) {
    if (!ziel) return null;
    const o = opts || {};
    const modus = o.modus === 'wandbild' ? 'wandbild' : 'eingebettet';
    const intervallMs = o.intervallMs || (modus === 'wandbild' ? 5000 : 30000);
    cssEinmal();

    const params = new URLSearchParams(location.search);
    let token = o.token || params.get('token') || '';
    if (params.get('token')) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* egal */ } }

    ziel.className = 'noc-cockpit' + (modus === 'wandbild' ? ' noc-wandbild' : '') + ' sm:rounded-2xl ' + (ziel.className || '');
    ziel.innerHTML = `<div class="noc-inner">${KOPF(modus)}${MAIL}${UNIFI}</div>`;
    const el = (n) => ziel.querySelector(`[data-el="${n}"]`);
    const setz = (n, wert, klasse) => { const e = el(n); if (!e) return; e.textContent = wert; if (klasse) e.className = klasse; };
    // Eine Kachel in der Dienste-Leiste: Lampe, Wert, Erklaerung beim Draufzeigen.
    // true = gruen, 'warn' = gelb, false = rot.
    const dienst = (n, zustand, wert, titel) => {
      const kachel = ziel.querySelector(`[data-svc="${n}"]`);
      if (!kachel) return;
      const lampe = kachel.querySelector('.noc-led');
      if (lampe) lampe.className = 'noc-led ' + (zustand === 'warn' ? 'led-amber' : zustand ? 'led-green' : 'led-red');
      const w = el(n);
      if (w) w.textContent = wert;
      if (titel) kachel.title = titel;
    };
    el('takt').textContent = 'Auto-Refresh ' + Math.round(intervallMs / 1000) + 's';

    const rxVerlauf = [], txVerlauf = [], MAX = 360;
    let laeuftGerade = false;

    const holen = (pfad) => {
      const angemeldet = !token && global.AuthentikAuth?.isLoggedIn?.();
      return angemeldet
        ? global.AuthentikAuth.apiFetch(pfad.replace('/public/', '/'))
        : fetch(pfad, { headers: token ? { 'X-Noc-Token': token } : {} });
    };

    function zeichneWan() {
      const svg = el('wan-graph');
      if (!svg) return;
      if (!rxVerlauf.length) { svg.innerHTML = ''; return; }
      const max = Math.max(1, ...rxVerlauf, ...txVerlauf);
      const pts = (arr) => arr.map((v, i) => `${(i / (MAX - 1)) * 200},${60 - (v / max) * 58}`).join(' ');
      svg.innerHTML = `<polyline points="${pts(rxVerlauf)}" fill="none" stroke="#67e8f9" stroke-width="1.5"/>`
                    + `<polyline points="${pts(txVerlauf)}" fill="none" stroke="#6ee7b7" stroke-width="1.5"/>`;
    }

    function zeigeFehler(text) {
      const e = el('fehler');
      if (!e) return;
      if (text) { e.textContent = text; e.hidden = false; } else { e.hidden = true; }
    }

    // Ein Abschnitt darf scheitern, ohne den Rest mitzunehmen — bei einem
    // Lagebild ist eine kaputte Kachel besser als eine leere Seite.
    const sicher = (fn, was) => { try { fn(); } catch (e) { console.warn('[noc] ' + was + ':', e.message); } };

    function malDashboard(d) {
      sicher(() => {
        const out = d.outbound || {};
        setz('monat', d.year_month || '—');
        setz('out-total', (out.monthly_total ?? 0).toLocaleString('de-CH'));
        setz('out-limit', out.quota_limit ?? 1000);
        const pct = Math.min(100, out.quota_pct || 0);
        const bar = el('out-bar');
        bar.style.width = pct + '%';
        bar.style.background = (out.quota_pct || 0) >= 100 ? '#f43f5e' : (out.quota_pct || 0) >= 80 ? '#f59e0b' : '#10b981';
        setz('out-pct', out.quota_pct || 0);
        setz('out-state', (out.quota_pct || 0) >= 100 ? 'ÜBER LIMIT' : (out.quota_pct || 0) >= 80 ? 'WARN' : 'OK');
        setz('out-quelle', (out.quelle === 'smtp2go' ? 'laut SMTP2GO' : 'SMTP2GO nicht erreichbar — eigene Zählung')
          + (out.zyklus ? ' · Zyklus ' + String(out.zyklus.von || '').slice(0, 10) + ' bis ' + String(out.zyklus.bis || '').slice(0, 10) : ''));
      }, 'outbound');

      sicher(() => {
        const r = d.relays || {};
        setz('relays', r.active_count ?? '0');
        setz('relays-managed', r.managed_count ?? '0');
        setz('relays-smart', r.smarthost_count ?? '0');
      }, 'relays');

      sicher(() => {
        const c = d.counts || {}, p = d.pending || {};
        setz('subs', c.subscribers_active ?? '0');   // wird von malUnifi ueberschrieben, sobald die Liste da ist
        setz('vpn', c.vpn_active ?? '0');
        setz('vpn-conn', c.vpn_connected ?? '0');
        setz('vpn-pen', c.vpn_pending ?? '0');
        setz('pending', (p.mailbox_requests || 0) + (p.vlan_requests || 0));
        setz('pending-mb', p.mailbox_requests || 0);
        setz('pending-vlan', p.vlan_requests || 0);
        const w = c.dienst_befunde ?? 0;
        dienst('wacht', w === 0 ? true : 'warn', w, w === 0 ? 'keine offenen Meldungen' : w + ' offene Meldungen der Dienstwacht');
      }, 'zahlen');

      sicher(() => {
        const nc = d.nextcloud || {};
        dienst('nextcloud', !!nc.ok, nc.ok ? (nc.version || 'ok') : 'weg', nc.ok ? 'erreichbar, Version ' + (nc.version || '?') : (nc.grund || 'nicht erreichbar'));
      }, 'nextcloud');

      sicher(() => {
        for (const [n, host] of [['q-relay', 'smtp-relay'], ['q-pmg', 'pmg']]) {
          const st = (d.relay_status || []).find((r) => r.host === host);
          if (!st) { dienst(n, false, '—', 'keine Meldung'); continue; }
          const stumm = st.alter_s > 900, q = st.queue_total || 0;
          dienst(n, stumm ? false : q > 0 ? 'warn' : true, stumm ? 'stumm' : String(q),
            (st.deferred ? st.deferred + ' aufgeschoben · ' : '') + 'Meldung vor ' + Math.round(st.alter_s / 60) + ' min'
            + (st.oldest_s ? ' · ältester ' + Math.round(st.oldest_s / 3600) + ' h' : ''));
        }
      }, 'warteschlangen');

      sicher(() => {
        const top = (d.outbound || {}).top_senders || [];
        const max = Math.max(1, ...top.map((t) => t.count));
        setz('top-meta', top.length ? top.length + ' Domains' : 'keine Sender');
        el('top-list').innerHTML = top.length === 0
          ? '<div class="text-xs text-slate-500 font-mono">Diesen Monat noch keine Outbound-Mails</div>'
          : top.map((t) => balken(t.sender_domain, t.count, t.count / max * 100)).join('');
      }, 'top_sender');
    }

    function malUnifi(u) {
      sicher(() => {
        el('led-unifi').className = 'noc-led ' + (u.reachable ? 'led-green' : 'led-red');
        setz('unifi-fehler', u.reachable ? '' : ('UDM unreachable' + (u.error ? ' · ' + u.error : '')));
      }, 'led');

      sicher(() => {
        const dev = u.devices || {}, by = dev.by_type || {};
        setz('dev-online', dev.online ?? 0);
        setz('dev-total', dev.total ?? 0);
        setz('dev-ap', (by.ap?.online || 0) + '/' + (by.ap?.total || 0));
        setz('dev-sw', (by.switch?.online || 0) + '/' + (by.switch?.total || 0));
        setz('dev-gw', (by.gateway?.online || 0) + '/' + (by.gateway?.total || 0));
      }, 'devices');

      sicher(() => {
        const c = u.clients || {};
        setz('cli-total', c.total ?? 0);
        setz('cli-wifi', c.wireless ?? 0);
        setz('cli-wired', c.wired ?? 0);
        setz('cli-guest', c.guest ?? 0);
      }, 'clients');

      sicher(() => {
        const w = u.wan || {};
        setz('wan-state', w.up ? 'UP' : 'DOWN', 'noc-big ' + (w.up ? 'text-emerald-300' : 'text-rose-400'));
        setz('wan-gw', w.gw_name || '—');
        setz('wan-ip', w.ip ? '· ' + w.ip : '');
        setz('wan-uptime', w.uptime_s ? 'uptime ' + fmtDauer(w.uptime_s) : '—');
        const roh = (u.health || []).find((h) => h.subsystem === 'wan');
        if (roh) {
          const rx = roh['rx_bytes-r'] || 0, tx = roh['tx_bytes-r'] || 0;
          setz('wan-rx', fmtRate(rx));
          setz('wan-tx', fmtRate(tx));
          rxVerlauf.push(rx); txVerlauf.push(tx);
          if (rxVerlauf.length > MAX) rxVerlauf.shift();
          if (txVerlauf.length > MAX) txVerlauf.shift();
          zeichneWan();
        }
      }, 'wan');

      sicher(() => {
        const wl = u.wlans || {};
        setz('wlan-on', wl.enabled ?? 0);
        setz('wlan-total', wl.total ?? 0);
      }, 'wlans');

      sicher(() => {
        const aps = u.top_aps || [];
        const max = Math.max(1, ...aps.map((a) => a.num_sta || 0));
        setz('aps-meta', aps.length ? aps.length + ' APs gelistet' : 'keine Daten');
        el('aps-list').innerHTML = aps.length === 0
          ? '<div class="text-xs text-slate-500 font-mono">keine aktiven APs</div>'
          : aps.map((a) => balken(a.name, (a.num_sta || 0) + ' Cli', (a.num_sta || 0) / max * 100, a.name + (a.model ? ' (' + a.model + ')' : ''))).join('');
      }, 'top_aps');

      // Anschluesse: gruen = provisioniert und ein Geraet gesehen, gelb = nur
      // provisioniert, rot = Widerspruch (heute nur eine abweichende MAC).
      // Ohne hinterlegte MAC kann es kein Rot geben — das sagt die Zeile darunter.
      sicher(() => {
        const liste = u.anschluesse || [];
        if (!liste.length) return;
        const aktiv = liste.filter((a) => a.zustand === 'aktiv').length;
        const kaputt = liste.filter((a) => a.zustand === 'fehler').length;
        setz('subs', liste.length);
        el('anschluss-liste').innerHTML = liste.map((a) => punkt(
          a.zustand === 'aktiv' ? true : a.zustand === 'fehler' ? false : 'warn',
          a.label,
          [a.typ, a.vlan ? 'VLAN ' + a.vlan : null, a.reserviert_ip, a.switch,
           a.port ? 'Port ' + a.port : null, a.grund].filter(Boolean).join(' · '))).join('');
        const ohneMac = liste.filter((a) => !a.mac_hinterlegt).length;
        setz('anschluss-mac', ' · ' + aktiv + ' von ' + liste.length + ' aktiv'
          + (kaputt ? ' · ' + kaputt + ' fehlerhaft' : '')
          + (ohneMac ? ' · ' + ohneMac + ' ohne MAC-Bindung' : ''));
      }, 'anschluesse');

      // Subsystems: Gesundheit, Router, Frontends und LXC — die letzten drei
      // kannte bisher nur das Wandbild, obwohl sie im Cockpit genauso fehlten.
      sicher(() => {
        const d = [];
        for (const s of (u.health || [])) d.push(punkt(s.status === 'ok' ? true : s.status === 'warning' ? 'warn' : false, s.subsystem));
        for (const r of (u.routers || [])) d.push(punkt(!!r.ok, r.label, 'CT ' + r.lxc_id + ' · VLAN ' + r.client_vlan));
        for (const f of (u.frontends || [])) d.push(punkt(!!f.ok, f.label, 'Frontend-Container ' + f.svc));
        for (const l of (u.lxcs || [])) d.push(punkt(!!l.ok, l.label, 'LXC ' + l.vmid + ' · ' + l.status));
        el('subsysteme').innerHTML = d.join('') || '<span class="text-xs text-slate-500 font-mono">keine Daten</span>';
      }, 'subsystems');
    }

    async function ampeln() {
      let s = { mail: true, web: true, internet: true };
      try {
        const r = await holen('/api/isp/status-summary');
        if (r.ok) s = await r.json();
      } catch (e) { /* Ampeln bleiben, wie sie waren */ }
      const setLed = (svc, ok) => {
        const t = ziel.querySelector(`[data-svc="${svc}"] .noc-led`);
        if (t) t.className = 'noc-led ' + (ok ? 'led-green' : 'led-red');
      };
      setLed('pmg', s.mail); setLed('mailcow', s.mail); setLed('webmail', s.mail);
      setLed('quarantine', s.mail); setLed('smtp2go', true);
      const mail = ['pmg', 'mailcow', 'smtp2go', 'quarantine', 'webmail'];
      const alle = mail.map((k) => ziel.querySelector(`[data-svc="${k}"] .noc-led`)).filter(Boolean);
      const gut = alle.every((l) => l.classList.contains('led-green'));
      const schlecht = alle.some((l) => l.classList.contains('led-red'));
      el('led-overall').className = 'noc-led ' + (gut ? 'led-green' : schlecht ? 'led-red' : 'led-amber');
    }

    async function laden() {
      // Ueberlappungsschutz und Pause bei verstecktem Tab: ein Wandbild, das
      // niemand sieht, muss die API nicht alle fuenf Sekunden fragen.
      if (laeuftGerade || document.hidden) return;
      laeuftGerade = true;
      try {
        const [dr, ur] = await Promise.all([
          holen('/api/isp/noc/public/dashboard'),
          holen('/api/isp/noc/public/unifi'),
        ]);
        if (!dr.ok || !ur.ok) { zeigeFehler(`Fehler (Dashboard ${dr.status} / UniFi ${ur.status}).`); return; }
        zeigeFehler('');
        malDashboard(await dr.json());
        malUnifi(await ur.json());
      } catch (e) {
        zeigeFehler('Fehler: ' + e.message);
      } finally {
        laeuftGerade = false;
      }
    }

    function uhr() {
      const now = new Date();
      setz('zeit', now.toLocaleTimeString('de-CH'));
      if (el('utc')) setz('utc', now.toISOString().slice(11, 19));
    }

    el('jetzt').addEventListener('click', () => { laden(); ampeln(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) laden(); });

    uhr(); laden(); ampeln();
    const t1 = setInterval(uhr, 1000);
    const t2 = setInterval(laden, intervallMs);
    const t3 = setInterval(ampeln, Math.max(intervallMs, 60000));
    return { laden, ampeln, beenden: () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); } };
  }

  global.NocCockpit = { starten };
})(window);
