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
//   Token (#token=…, Rueckfall ?token=…, oder Option)  → oeffentliche Endpunkte mit X-Noc-Token
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
    .led-blau  { background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
    .led-grau  { background: #475569; box-shadow: none; }
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
    /* Stationen: eine Karte je Geraet, die schlimmsten zuerst. */
    .noc-stationen { display: grid; gap: .5rem; grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr)); }
    .noc-st { background: rgba(15,23,42,0.6); border: 1px solid #334155; border-left-width: 4px; border-radius: .5rem; padding: .5rem .65rem; min-width: 0; }
    .noc-st.st-rot  { border-left-color: #f87171; background: rgba(127,29,29,.25); }
    .noc-st.st-gelb { border-left-color: #fbbf24; }
    .noc-st.st-gruen{ border-left-color: #34d399; }
    .noc-st.st-blau { border-left-color: #38bdf8; }
    .noc-st.st-grau { border-left-color: #475569; opacity: .7; }
    .noc-st-kopf { display: flex; align-items: center; gap: .45rem; min-width: 0; }
    .noc-st-name { font-family: ui-monospace, monospace; font-weight: 600; color: #f1f5f9; font-size: .82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .noc-st-zeit { margin-left: auto; font-family: ui-monospace, monospace; font-size: .68rem; color: #94a3b8; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .noc-st-was  { font-size: .66rem; color: #94a3b8; font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: .1rem; }
    .noc-st-tags { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .3rem; }
    .noc-tag { font-family: ui-monospace, monospace; font-size: .6rem; text-transform: uppercase; letter-spacing: .03em; border-radius: .25rem; padding: .05rem .35rem; border: 1px solid #334155; color: #cbd5e1; }
    .tag-rot  { background: rgba(248,113,113,.18); border-color: #f87171; color: #fecaca; }
    .tag-gelb { background: rgba(251,191,36,.15); border-color: #fbbf24; color: #fde68a; }
    .tag-info { background: rgba(56,189,248,.15); border-color: #38bdf8; color: #bae6fd; }
    .noc-srv-zeile { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .15rem .5rem; align-items: center; font-size: .72rem; margin-top: .3rem; }
    .noc-srv-zeile > .noc-bar { grid-column: span 2; height: .3rem; }
    .noc-wandbild .noc-srv-zeile { font-size: .85rem; }
    .noc-wandbild .noc-stationen { grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: .6rem; }
    .noc-wandbild .noc-st-name { font-size: 1.05rem; }
    .noc-wandbild .noc-st-zeit { font-size: .85rem; }
    .noc-wandbild .noc-st-was  { font-size: .78rem; }
    .noc-wandbild .noc-tag     { font-size: .72rem; }
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

      <!-- Steht unter Top Sender: dort bleiben im Vierer-Raster zwei Spalten
           frei, weil Pending und Pfade nur je eine belegen. -->
      <div class="noc-tile noc-breit">
        <div class="noc-label">Subsystems</div>
        <div data-el="subsysteme" class="flex flex-wrap gap-1.5 mt-1"><span class="text-xs text-slate-500 font-mono">lade…</span></div>
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
    </div>`;

  // Stationen (Rosenweg/os-stationen, Agent v2, Kiosk, Chromecast): Zaehler
  // oben, darunter eine Karte je Geraet — rot und gelb zuerst. Woher die
  // Ampel kommt, steht in api/lib/nocstationen.js.
  const STATIONEN = `
    <div class="flex items-center justify-between mt-5 mb-2">
      <div class="flex items-center gap-2">
        <span class="noc-led led-amber" data-el="led-stationen"></span>
        <span class="text-[11px] font-mono uppercase tracking-wider text-slate-300">Stationen</span>
      </div>
      <span class="text-[10px] text-slate-500 font-mono" data-el="st-fehler"></span>
    </div>
    <div class="noc-gitter mb-3">
      <div class="noc-tile">
        <div class="noc-label">Online</div>
        <div class="flex items-baseline gap-2"><span class="noc-big text-emerald-300" data-el="st-online">—</span><span class="text-xs text-slate-400">/ <span data-el="st-gesamt">0</span></span></div>
        <div class="noc-leise" data-el="st-online-leise">&nbsp;</div>
      </div>
      <div class="noc-tile">
        <div class="noc-label">Offline</div>
        <div class="noc-big" data-el="st-offline">—</div>
        <div class="noc-leise" data-el="st-offline-leise">&nbsp;</div>
      </div>
      <div class="noc-tile">
        <div class="noc-label">Warnungen</div>
        <div class="noc-big" data-el="st-warn">—</div>
        <div class="noc-leise" data-el="st-warn-leise">&nbsp;</div>
      </div>
      <div class="noc-tile">
        <div class="noc-label">Update · Wartung</div>
        <div class="noc-big" data-el="st-arbeit">—</div>
        <div class="noc-leise">laufend oder angefordert</div>
      </div>
    </div>
    <div data-el="st-liste" class="noc-stationen"><div class="text-xs text-slate-500 font-mono">lade…</div></div>`;

  // Fernwartung der geteilten Telefone (adb-Tunnel, api/lib/nocfernwartung.js):
  // eine Karte je Telefon, rot und gelb zuerst; blau = Sitzung läuft.
  const FERNWARTUNG = `
    <div class="flex items-center justify-between mt-5 mb-2">
      <div class="flex items-center gap-2">
        <span class="noc-led led-grau" data-el="led-fw"></span>
        <span class="text-[11px] font-mono uppercase tracking-wider text-slate-300">Telefone · Fernwartung</span>
        <span class="text-[10px] text-slate-500 font-mono" data-el="fw-kopf"></span>
      </div>
      <span class="text-[10px] text-slate-500 font-mono" data-el="fw-fehler"></span>
    </div>
    <div data-el="fw-liste" class="noc-stationen"><div class="text-xs text-slate-500 font-mono">lade…</div></div>`;

  // Alter eines Lebenszeichens, kurz: 3 min, 2 h, 4 T.
  const fmtAlter = (min) => {
    if (min === null || min === undefined) return 'nie';
    if (min < 2) return 'jetzt';
    if (min < 60) return min + ' min';
    if (min < 48 * 60) return Math.round(min / 60) + ' h';
    return Math.round(min / 1440) + ' T';
  };
  const ZUSTAND_TEXT = { online: '', aus: 'aus', still: 'still', nie: 'nie gemeldet', 'ohne-agent': 'ohne Agent' };
  const LED = { rot: 'led-red', gelb: 'led-amber', gruen: 'led-green', blau: 'led-blau', grau: 'led-grau' };

  function stationKarte(s) {
    const ort = [s.rolle_text, s.haus ? 'R' + s.haus : null, s.standort].filter(Boolean).join(' · ');
    const was = [s.os, s.agent].filter(Boolean).join(' · ');
    const zeit = s.zustand === 'ohne-agent' ? '—'
      : s.zustand === 'online' ? fmtAlter(s.alter_min)
      : (ZUSTAND_TEXT[s.zustand] || s.zustand) + (s.alter_min !== null && s.alter_min !== undefined ? ' ' + fmtAlter(s.alter_min) : '');
    // „aus"/„still" stehen schon rechts in der Zeit — nicht noch einmal als Etikett.
    const tags = (s.hinweise || []).filter((x) => !/^(aus|Anzeige aus|seit Tagen still|nie gemeldet)$/.test(x.text));
    const titel = [ort, was, ...(s.hinweise || []).map((x) => x.text)].filter(Boolean).join('\n');
    return `<div class="noc-st st-${esc(s.ampel)}" title="${esc(titel)}">
      <div class="noc-st-kopf"><span class="noc-led ${LED[s.ampel] || 'led-grau'}"></span>
        <span class="noc-st-name">${esc(s.id)}</span><span class="noc-st-zeit">${esc(zeit)}</span></div>
      <div class="noc-st-was">${esc(ort)}</div>
      ${was ? `<div class="noc-st-was">${esc(was)}</div>` : ''}
      ${tags.length ? `<div class="noc-st-tags">${tags.map((x) => `<span class="noc-tag tag-${esc(x.stufe)}">${esc(x.text)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  function fwKarte(t) {
    return `<div class="noc-st st-${esc(t.ampel)}" title="${esc([t.name, ...(t.hinweise || [])].join('\n'))}">
      <div class="noc-st-kopf"><span class="noc-led ${LED[t.ampel] || 'led-grau'}"></span>
        <span class="noc-st-name">${esc(t.ext)}</span><span class="noc-st-zeit">${esc(t.kontakt || '')}</span></div>
      <div class="noc-st-was">${esc(t.name)}</div>
      ${(t.hinweise || []).length ? `<div class="noc-st-tags">${t.hinweise.map((x) => `<span class="noc-tag tag-${t.ampel === 'rot' ? 'rot' : t.ampel === 'blau' ? 'info' : 'gelb'}">${esc(x)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  // Server: Proxmox-Cluster und PBS. Komplett aus den Daten gezeichnet —
  // Knotenzahl, Platten und Jobs stehen nicht fest. Auswertung und Ampeln:
  // api/lib/nocserver.js.
  const SERVER = `
    <div class="flex items-center justify-between mt-5 mb-2">
      <div class="flex items-center gap-2">
        <span class="noc-led led-amber" data-el="led-pve"></span>
        <span class="text-[11px] font-mono uppercase tracking-wider text-slate-300">Server · Proxmox-Cluster</span>
        <span class="text-[10px] text-slate-500 font-mono" data-el="pve-kopf"></span>
      </div>
      <span class="text-[10px] text-slate-500 font-mono" data-el="srv-fehler"></span>
    </div>
    <div data-el="pve" class="noc-gitter"><div class="text-xs text-slate-500 font-mono">lade…</div></div>
    <div class="flex items-center justify-between mt-5 mb-2">
      <div class="flex items-center gap-2">
        <span class="noc-led led-amber" data-el="led-pbs"></span>
        <span class="text-[11px] font-mono uppercase tracking-wider text-slate-300">Backup-Server · PBS</span>
      </div>
    </div>
    <div data-el="pbs" class="noc-gitter"><div class="text-xs text-slate-500 font-mono">lade…</div></div>`;

  const FARBE = { rot: '#f87171', gelb: '#fbbf24', gruen: '#34d399', grau: '#64748b' };
  const TEXT = { rot: 'text-rose-400', gelb: 'text-amber-300', gruen: 'text-emerald-300', grau: 'text-slate-400' };
  const fmtBytes = (b) => {
    if (b === null || b === undefined) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = b, i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
  };
  const fmtStunden = (h) => (h === null || h === undefined ? '—' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' T');
  // Eine Zeile mit Balken in Ampelfarbe.
  const srvBalken = (name, wert, pct, ampel, titel) => `
    <div class="noc-srv-zeile"${titel ? ` title="${esc(titel)}"` : ''}>
      <div class="noc-name">${name}</div><div class="noc-zahl ${TEXT[ampel] || ''}">${esc(wert)}</div>
      <div class="noc-bar"><div style="width:${Math.max(0, Math.min(100, pct || 0)).toFixed(1)}%;background:${FARBE[ampel] || '#06b6d4'}"></div></div>
    </div>`;
  const ampelPunkt = (ampel, text, titel) => `
    <span class="noc-pill"${titel ? ` title="${esc(titel)}"` : ''}>
      <span class="noc-led ${LED[ampel] || 'led-grau'}"></span><span>${esc(text)}</span>
    </span>`;
  const nichtEingerichtet = (teil) => `<div class="noc-tile noc-breit"><div class="noc-label">nicht eingerichtet</div>
    <div class="noc-leise">In /opt/rosenweg-core/.env fehlt: ${esc((teil.fehlt || []).join(', '))}</div></div>`;

  function pveKacheln(p) {
    const k = [];
    for (const n of p.knoten || []) {
      k.push(`<div class="noc-tile"${n.gruende.length ? ` title="${esc(n.gruende.join(' · '))}"` : ''}>
        <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[n.ampel]}"></span><span>${esc(n.name)}</span>
          <span class="ml-auto text-[10px] ${TEXT[n.ampel]}">${n.online ? (n.gruende[0] ? esc(n.gruende[0]) : 'online') : 'OFFLINE'}</span></div>
        ${n.online ? `
          ${srvBalken('CPU', (n.cpu ?? 0) + ' %', n.cpu, n.cpu >= 90 ? 'gelb' : 'gruen')}
          ${srvBalken('RAM', (n.ram ?? 0) + ' % von ' + fmtBytes(n.ram_gesamt), n.ram, n.ram >= 90 ? 'gelb' : 'gruen')}
          <div class="noc-leise">Last ${esc(n.last ?? '—')} / ${esc(n.kerne ?? '?')} · up ${esc(fmtDauer(n.uptime_s))}</div>
          <div class="noc-leise">HA ${esc(n.ha_lrm || '—')} · ${n.gaeste_laufend}/${n.gaeste_gesamt} Gäste</div>`
        : '<div class="noc-big text-rose-400">DOWN</div>'}
      </div>`);
    }
    const c = p.ceph || {};
    k.push(`<div class="noc-tile">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[c.ampel] || 'led-grau'}"></span><span>Ceph</span></div>
      <div class="noc-mid ${TEXT[c.ampel] || ''}">${esc(c.status ? c.status.replace('HEALTH_', '') : '—')}</div>
      ${c.osd ? `<div class="noc-leise">OSD ${c.osd.up ?? '?'}/${c.osd.gesamt ?? '?'} up · ${c.belegt_prozent ?? '—'} % belegt (${esc(fmtBytes(c.belegt_bytes))} / ${esc(fmtBytes(c.gesamt_bytes))})</div>` : ''}
      <div class="noc-st-tags">${(c.pruefungen || []).map((x) => `<span class="noc-tag ${x.stumm ? '' : 'tag-' + (x.stufe === 'rot' ? 'rot' : 'gelb')}" style="${x.stumm ? 'opacity:.55' : ''}" title="${esc(x.name + (x.stumm ? ' — stumm (Altlast), färbt die Ampel nicht' : ''))}">${esc(x.text || x.name)}${x.stumm ? ' · stumm' : ''}</span>`).join('')}</div>
    </div>`);

    const ssd = p.ssd || [];
    k.push(`<div class="noc-tile noc-breit">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[p.ssd_ampel] || 'led-grau'}"></span><span>SSD-Abnutzung (SMART „Percentage Used“)</span></div>
      ${ssd.length ? ssd.map((d) => srvBalken(
        `${esc(d.knoten)} · ${esc(d.geraet)}${d.osd ? ' · <span class="text-cyan-300">osd.' + esc(d.osd_id) + '</span>' : ''}`,
        d.verbraucht === null ? (d.gesund === false ? 'SMART!' : '—') : d.verbraucht + ' %', d.verbraucht, d.ampel,
        [d.modell, ...d.gruende].filter(Boolean).join(' · '))).join('')
        : '<div class="noc-leise">keine Angaben</div>'}
    </div>`);

    const h = p.ha || {};
    k.push(`<div class="noc-tile"${h.gruende?.length ? ` title="${esc(h.gruende.join(' · '))}"` : ''}>
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[h.ampel] || 'led-grau'}"></span><span>HA</span></div>
      <div class="flex items-baseline gap-2"><span class="noc-big">${h.started ?? '—'}</span><span class="text-xs text-slate-400">/ ${h.dienste ?? 0} started</span></div>
      <div class="noc-leise">Master ${esc(h.master || '—')}${h.wandernd ? ' · ' + h.wandernd + ' wandern' : ''}${h.stopped ? ' · ' + h.stopped + ' gestoppt' : ''}</div>
      ${h.fehler?.length ? `<div class="noc-st-tags">${h.fehler.map((f) => `<span class="noc-tag tag-rot">${esc((f.sid || 'Gast') + ' ' + f.zustand)}</span>`).join('')}</div>` : ''}
    </div>`);

    const g = p.gaeste || {};
    k.push(`<div class="noc-tile">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[g.ampel] || 'led-grau'}"></span><span>Gäste</span></div>
      <div class="flex items-baseline gap-2"><span class="noc-big">${g.laufend ?? '—'}</span><span class="text-xs text-slate-400">/ ${g.gesamt ?? 0} laufen</span></div>
      <div class="noc-leise">${g.soll_laufen?.length ? 'Autostart, aber aus:' : (g.gestoppt || 0) + ' gestoppt, keiner mit Autostart'}</div>
      ${g.soll_laufen?.length ? `<div class="noc-st-tags">${g.soll_laufen.map((x) => `<span class="noc-tag tag-gelb" title="${esc(x.knoten || '')}">${esc([x.vmid, x.name].filter(Boolean).join(' '))}</span>`).join('')}</div>` : ''}
    </div>`);
    return k.join('');
  }

  function pbsKacheln(b) {
    const k = [];
    for (const d of b.datastores || []) {
      k.push(`<div class="noc-tile"${d.gruende.length ? ` title="${esc(d.gruende.join(' · '))}"` : ''}>
        <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[d.ampel]}"></span><span>Datastore ${esc(d.name)}</span></div>
        <div class="flex items-baseline gap-2"><span class="noc-big ${TEXT[d.ampel]}">${d.belegt_prozent ?? '—'}<span class="text-base">%</span></span></div>
        ${srvBalken(esc(fmtBytes(d.belegt_bytes)) + ' von ' + esc(fmtBytes(d.gesamt_bytes)), '', d.belegt_prozent, d.ampel)}
        <div class="noc-leise">${d.tage_bis_voll !== null && d.tage_bis_voll >= 0 ? 'voll in ~' + d.tage_bis_voll + ' Tagen' : 'kein Ende absehbar'}</div>
      </div>`);
    }
    const s = b.sicherungen || {};
    k.push(`<div class="noc-tile">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[s.ampel] || 'led-grau'}"></span><span>Sicherungen je Gast</span></div>
      <div class="flex items-baseline gap-2"><span class="noc-big">${s.gaeste ?? '—'}</span><span class="text-xs text-slate-400">Gäste · jüngste ${esc(fmtStunden(s.juengste_stunden))}</span></div>
      <div class="noc-leise">${s.zu_alt?.length ? s.zu_alt.length + ' älter als ' + esc(b.sicherung_stunden || 36) + ' h' : 'alle jünger als ' + esc(b.sicherung_stunden || 36) + ' h'}${s.ohne?.length ? ' · ' + s.ohne.length + ' ohne Sicherung' : ''}</div>
      ${s.zu_alt?.length ? `<div class="noc-st-tags">${s.zu_alt.map((x) => `<span class="noc-tag tag-gelb">${esc([x.gast, x.name].filter(Boolean).join(' '))} · ${esc(x.grund)}</span>`).join('')}</div>` : ''}
      ${s.ohne?.length ? `<div class="noc-leise" title="${esc(s.ohne.map((x) => [x.gast, x.name].filter(Boolean).join(' ')).join(', '))}">ohne: ${esc(s.ohne.slice(0, 6).map((x) => x.name || x.gast).join(', '))}${s.ohne.length > 6 ? ' …' : ''}</div>` : ''}
    </div>`);
    const jobs = b.jobs || [];
    const jobAmpel = jobs.some((j) => j.ampel === 'rot') ? 'rot' : jobs.some((j) => j.ampel === 'gelb') ? 'gelb' : jobs.length ? 'gruen' : 'grau';
    k.push(`<div class="noc-tile">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${LED[jobAmpel]}"></span><span>Jobs · GC · Prüfung · Aufräumen</span></div>
      <div class="flex flex-wrap gap-1.5 mt-1">${jobs.map((j) => ampelPunkt(j.ampel, j.art + (j.ns && j.ns !== '(Wurzel)' ? ' ' + j.ns : ''),
        j.zustand + (j.zuletzt ? ' · zuletzt ' + new Date(j.zuletzt).toLocaleString('de-CH') : ''))).join('') || '<span class="noc-leise">keine Jobs</span>'}</div>
    </div>`);
    const f = b.fehlgeschlagen || [];
    k.push(`<div class="noc-tile">
      <div class="noc-label flex items-center gap-2"><span class="noc-led ${f.length ? 'led-amber' : 'led-green'}"></span><span>Fehlgeschlagen · 24 h</span></div>
      <div class="noc-big ${f.length ? 'text-amber-300' : 'text-emerald-300'}">${f.length}</div>
      ${f.slice(0, 5).map((x) => `<div class="noc-leise" title="${esc(x.text || '')}">${esc(x.art)}${x.ziel ? ' ' + esc(x.ziel) : ''}${x.zeit ? ' · ' + esc(new Date(x.zeit).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })) : ''}${x.text ? ' · ' + esc(x.text.slice(0, 40)) : ''}</div>`).join('')}
    </div>`);
    return k.join('');
  }

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

    // Token bevorzugt aus dem #Fragment (geht nicht in Server-/Proxy-Logs und Referer);
    // ?token= bleibt als Rueckfall fuer bestehende Wandbild-Links. Danach aus der URL entfernen.
    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const urlToken = hashParams.get('token') || params.get('token') || '';
    // Fuer F5/Neuladen im Wandbild: Token pro Tab in sessionStorage merken (die URL ist
    // danach leer). Nur im Wandbild-Modus – eingebettet zaehlt die Anmeldung.
    const SPEICHER = 'noc_wandbild_token';
    let gemerkt = '';
    if (modus === 'wandbild') {
      try {
        if (urlToken) sessionStorage.setItem(SPEICHER, urlToken);
        gemerkt = sessionStorage.getItem(SPEICHER) || '';
      } catch (e) { /* Speicher gesperrt: dann wie bisher nur aus der URL */ }
    }
    let token = o.token || urlToken || gemerkt;
    if (urlToken) {
      params.delete('token');
      const rest = params.toString();
      try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '')); } catch (e) { /* egal */ }
    }

    ziel.className = 'noc-cockpit' + (modus === 'wandbild' ? ' noc-wandbild' : '') + ' sm:rounded-2xl ' + (ziel.className || '');
    ziel.innerHTML = `<div class="noc-inner">${KOPF(modus)}${MAIL}${UNIFI}${STATIONEN}${FERNWARTUNG}${SERVER}</div>`;
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

    function malStationen(d) {
      sicher(() => {
        const z = d.zusammenfassung || {};
        el('led-stationen').className = 'noc-led ' + (LED[z.ampel] || 'led-grau');
        setz('st-fehler', '');
        setz('st-online', z.online ?? 0);
        setz('st-gesamt', z.gesamt ?? 0);
        setz('st-online-leise', z.ohne_agent ? z.ohne_agent + ' ohne Agent' : '\u00a0');
        const echtAus = (z.offline || 0) - (z.aus_erlaubt || 0);
        setz('st-offline', z.offline ?? 0, 'noc-big ' + (z.stoerungen && echtAus > 0 ? 'text-rose-400' : ''));
        setz('st-offline-leise', z.aus_erlaubt ? z.aus_erlaubt + ' davon dürfen aus sein' : '\u00a0');
        const w = (z.warnungen || 0) + (z.stoerungen || 0);
        setz('st-warn', w, 'noc-big ' + (z.stoerungen ? 'text-rose-400' : z.warnungen ? 'text-amber-300' : 'text-emerald-300'));
        setz('st-warn-leise', w ? (z.stoerungen || 0) + ' rot · ' + (z.warnungen || 0) + ' gelb' : 'keine');
        setz('st-arbeit', z.arbeiten ?? 0, 'noc-big ' + (z.arbeiten ? 'text-sky-300' : ''));
        const liste = d.stationen || [];
        el('st-liste').innerHTML = liste.length
          ? liste.map(stationKarte).join('')
          : '<div class="text-xs text-slate-500 font-mono">keine Stationen eingetragen</div>';
      }, 'stationen');
    }

    // Eigener Abruf: fehlt der Endpunkt (alte API) oder klemmt die Datenbank,
    // bleibt der Rest des Lagebilds stehen.
    async function stationen() {
      if (document.hidden) return;
      try {
        const r = await holen('/api/isp/noc/public/stationen');
        if (!r.ok) {
          el('led-stationen').className = 'noc-led led-red';
          setz('st-fehler', 'Stationen: HTTP ' + r.status);
          return;
        }
        malStationen(await r.json());
      } catch (e) {
        el('led-stationen').className = 'noc-led led-red';
        setz('st-fehler', 'Stationen: ' + e.message);
      }
    }

    function malFernwartung(d) {
      sicher(() => {
        setz('fw-fehler', '');
        const z = d.zusammenfassung || {};
        el('led-fw').className = 'noc-led ' + (LED[z.ampel] || 'led-grau');
        if (!d.eingerichtet) {
          setz('fw-kopf', '');
          el('fw-liste').innerHTML = '<div class="text-xs text-slate-500 font-mono">adb-zentrale noch nicht eingerichtet</div>';
          return;
        }
        setz('fw-kopf', (d.zentrale ? '' : '· Zentrale nicht erreichbar · ') + '· ' + (z.gruen || 0) + ' bereit'
          + (z.blau ? ' · ' + z.blau + ' in Sitzung' : '') + (z.rot ? ' · ' + z.rot + ' rot' : '') + (z.gelb ? ' · ' + z.gelb + ' gelb' : ''));
        el('fw-liste').innerHTML = (d.telefone || []).map(fwKarte).join('')
          || '<div class="text-xs text-slate-500 font-mono">keine geteilten Telefone</div>';
      }, 'fernwartung');
    }

    async function fernwartung() {
      if (document.hidden) return;
      try {
        const r = await holen('/api/isp/noc/public/fernwartung');
        if (!r.ok) {
          el('led-fw').className = 'noc-led led-red';
          setz('fw-fehler', 'Fernwartung: HTTP ' + r.status);
          return;
        }
        malFernwartung(await r.json());
      } catch (e) {
        el('led-fw').className = 'noc-led led-red';
        setz('fw-fehler', 'Fernwartung: ' + e.message);
      }
    }

    function malServer(d) {
      setz('srv-fehler', '');
      sicher(() => {
        const p = d.pve || {};
        const ziel = el('pve');
        if (p.eingerichtet === false) { el('led-pve').className = 'noc-led led-grau'; ziel.innerHTML = nichtEingerichtet(p); return; }
        el('led-pve').className = 'noc-led ' + (LED[p.ampel] || 'led-grau');
        if (p.fehler) { ziel.innerHTML = `<div class="noc-tile noc-breit"><div class="noc-label">Proxmox nicht lesbar</div><div class="noc-leise">${esc(p.fehler)}</div></div>`; setz('pve-kopf', ''); return; }
        const q = p.quorum || {};
        setz('pve-kopf', '· Quorum ' + (q.quorate ? 'OK' : q.quorate === false ? 'VERLOREN' : '?') + ' · ' + (q.online ?? '?') + '/' + (q.knoten ?? '?') + ' Knoten'
          + (p.ha?.master ? ' · HA-Master ' + p.ha.master : ''));
        ziel.innerHTML = pveKacheln(p);
      }, 'pve');
      sicher(() => {
        const b = d.pbs || {};
        const ziel = el('pbs');
        if (b.eingerichtet === false) { el('led-pbs').className = 'noc-led led-grau'; ziel.innerHTML = nichtEingerichtet(b); return; }
        el('led-pbs').className = 'noc-led ' + (LED[b.ampel] || 'led-grau');
        if (b.fehler) { ziel.innerHTML = `<div class="noc-tile noc-breit"><div class="noc-label">PBS nicht lesbar</div><div class="noc-leise">${esc(b.fehler)}</div></div>`; return; }
        ziel.innerHTML = pbsKacheln({ ...b, sicherung_stunden: d.schwellen?.sicherungStunden });
      }, 'pbs');
    }

    async function server() {
      if (document.hidden) return;
      try {
        const r = await holen('/api/isp/noc/public/server');
        if (!r.ok) {
          el('led-pve').className = 'noc-led led-red';
          setz('srv-fehler', 'Server: HTTP ' + r.status);
          return;
        }
        malServer(await r.json());
      } catch (e) {
        el('led-pve').className = 'noc-led led-red';
        setz('srv-fehler', 'Server: ' + e.message);
      }
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

    el('jetzt').addEventListener('click', () => { laden(); ampeln(); stationen(); fernwartung(); server(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { laden(); stationen(); fernwartung(); server(); } });

    uhr(); laden(); ampeln(); stationen(); fernwartung(); server();
    const t1 = setInterval(uhr, 1000);
    const t2 = setInterval(laden, intervallMs);
    const t3 = setInterval(ampeln, Math.max(intervallMs, 60000));
    // Lebenszeichen kommen hoechstens jede Minute — die API cached 15 s.
    const t4 = setInterval(stationen, Math.max(intervallMs, 15000));
    // Server: die API cached 30 s (SMART 10 min) — oefter fragen bringt nichts.
    const t5 = setInterval(server, Math.max(intervallMs, 30000));
    // Fernwartung: die API merkt sich die Antwort der Anlage 20 s.
    const t6 = setInterval(fernwartung, Math.max(intervallMs, 30000));
    return { laden, ampeln, stationen, fernwartung, server, beenden: () => { [t1, t2, t3, t4, t5, t6].forEach(clearInterval); } };
  }

  global.NocCockpit = { starten };
})(window);
