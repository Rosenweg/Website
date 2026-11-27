// ═══════════════════════════════════════════════════════════════════
// STATIONEN-PROTOKOLL v2 — Entscheidungen ohne Datenbank
//
// Ein Protokoll für alle Geräte mit Agent: Linux-Stationen (os-stationen),
// Windows-PCs der Domäne, später der Kiosk-Fernseher. Das Programm dazu ist
// Rosenweg/rosenweg-agent; die Beschreibung steht dort in
// docs/protokoll-v2.md, die Routen in routes/stationen-v2.js.
//
// Hier liegt, was sich ohne Postgres prüfen lässt
// (api/test/stationprotokoll.test.js):
//   - Inventar auf bekannte Felder mit Grenzen zurechtstutzen
//   - daraus die Felder ableiten, die /stationen und die Wächter aus dem
//     alten Lebenszeichen (v1) kennen
//   - Befehle prüfen: welche Art, welche Parameter, auf welcher Plattform
//   - aus einem Kerberos-Namen den Rechnernamen lesen
// ═══════════════════════════════════════════════════════════════════

const PROTOKOLL = 2;

// Wie oft der Agent sich meldet. Zwei Minuten: ein Befehl von /stationen
// (Nachricht, Neustart) soll nicht fünf Minuten auf sich warten lassen, und
// ein Lebenszeichen ist ein kleiner POST. Der Agent nimmt, was die Antwort
// sagt, und hält sich an die Grenzen.
const INTERVALL_SEKUNDEN = 120;
const INTERVALL_MIN = 30;
const INTERVALL_MAX = 900;

const PLATTFORMEN = ['windows', 'linux', 'android-tv'];

// ─── Hilfen ─────────────────────────────────────────────────────────

const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const zahl = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
};
const wahr = (v) => (v === true ? true : v === false ? false : null);
const zeit = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const liste = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function normMac(m) {
  const s = String(m || '').trim().toLowerCase().replace(/-/g, ':');
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return null;
  // Null-MAC und die Platzhalter, die Android Apps ohne Berechtigung zeigt.
  if (s === '00:00:00:00:00:00' || s === '02:00:00:00:00:00') return null;
  return s;
}

// IPv4 oder IPv6 als Text, ohne zu prüfen, ob sie erreichbar ist — nur, dass
// keine beliebige Zeichenkette in die Seite gelangt.
const IP_MUSTER = /^[0-9a-fA-F:.%]{2,64}$/;
const ip = (v) => (typeof v === 'string' && IP_MUSTER.test(v.trim()) ? v.trim() : null);

// ─── Inventar ───────────────────────────────────────────────────────

const NETZ_ARTEN = ['kabel', 'wlan', 'andere'];
const SITZUNG_ZUSTAENDE = ['aktiv', 'getrennt', 'gesperrt', 'andere'];
const SCHUTZ = ['an', 'aus', 'unbekannt'];

/**
 * Das Inventar aus dem Lebenszeichen, nur bekannte Felder, mit Grenzen.
 * last_state ist das, was /stationen zeigt; was der Agent sonst schickt,
 * gehört nicht in eine Seite, die jemand offen liegen lässt.
 *
 * Plattform-Eigenes steht unter `zusatz` als flaches Objekt aus kurzen
 * Texten, Zahlen und Wahrheitswerten (höchstens 30 Einträge).
 */
function inventarBereinigen(roh) {
  const r = roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  const bs = r.betriebssystem && typeof r.betriebssystem === 'object' ? r.betriebssystem : {};
  const upd = r.updates && typeof r.updates === 'object' ? r.updates : {};

  const netz = liste(r.netz, 16).map((n) => ({
    name: text(n?.name, 80),
    mac: normMac(n?.mac),
    art: NETZ_ARTEN.includes(n?.art) ? n.art : 'andere',
    verbunden: wahr(n?.verbunden),
    standard: n?.standard === true,
    ipv4: liste(n?.ipv4, 8).map(ip).filter(Boolean),
    ipv6: liste(n?.ipv6, 8).map(ip).filter(Boolean),
  })).filter((n) => n.name || n.mac);

  const zusatz = {};
  if (r.zusatz && typeof r.zusatz === 'object' && !Array.isArray(r.zusatz)) {
    for (const [k, v] of Object.entries(r.zusatz).slice(0, 30)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
      if (typeof v === 'string') zusatz[k] = v.slice(0, 200);
      else if (typeof v === 'number' && Number.isFinite(v)) zusatz[k] = v;
      else if (typeof v === 'boolean') zusatz[k] = v;
    }
  }

  return {
    hostname: text(r.hostname, 63),
    betriebssystem: {
      name: text(bs.name, 80),
      version: text(bs.version, 40),
      build: text(bs.build, 40),
      kernel: text(bs.kernel, 80),
    },
    laufzeit_sekunden: zahl(r.laufzeit_sekunden, 0, 10 * 365 * 86400),
    personen: liste(r.personen, 20).map((p) => ({
      name: text(p?.name, 120),
      sitzung: text(p?.sitzung != null ? String(p.sitzung) : null, 40),
      zustand: SITZUNG_ZUSTAENDE.includes(p?.zustand) ? p.zustand : 'andere',
    })).filter((p) => p.name),
    netz,
    platten: liste(r.platten, 12).map((p) => ({
      laufwerk: text(p?.laufwerk, 80),
      gesamt_bytes: zahl(p?.gesamt_bytes),
      frei_bytes: zahl(p?.frei_bytes),
    })).filter((p) => p.laufwerk && p.gesamt_bytes),
    verschluesselung: liste(r.verschluesselung, 12).map((v) => ({
      laufwerk: text(v?.laufwerk, 80),
      schutz: SCHUTZ.includes(v?.schutz) ? v.schutz : 'unbekannt',
      zustand: text(v?.zustand, 40),
      prozent: zahl(v?.prozent, 0, 100),
    })).filter((v) => v.laufwerk),
    updates: {
      zuletzt: zeit(upd.zuletzt),
      neustart_ausstehend: wahr(upd.neustart_ausstehend),
      liste: liste(upd.liste, 10).map((u) => ({
        titel: text(u?.titel, 200),
        datum: zeit(u?.datum),
        ok: wahr(u?.ok),
      })).filter((u) => u.titel),
      fehler: text(upd.fehler, 200),
    },
    zusatz,
  };
}

/** Die Agent-Angaben: Name, Version, Plattform. */
function agentBereinigen(roh) {
  const r = roh && typeof roh === 'object' ? roh : {};
  const plattform = PLATTFORMEN.includes(r.plattform) ? r.plattform : null;
  const version = typeof r.version === 'string' && /^[0-9A-Za-z.+_-]{1,40}$/.test(r.version) ? r.version : null;
  return {
    name: text(r.name, 40) || 'rosenweg-agent',
    version,
    plattform,
    arch: text(r.arch, 20),
    // 'parallel' = läuft neben dem alten Bash-Agenten (Umstellung der
    // Linux-Stationen): nur zusehen, nichts ausführen, last_state nicht
    // überschreiben. Siehe routes/stationen-v2.js.
    modus: r.modus === 'parallel' ? 'parallel' : 'voll',
  };
}

/**
 * MACs fürs Inventar der Station (hardware.macs), so wie der Anschluss-Wächter
 * sie liest: nur Kabel und WLAN, keine virtuellen Adapter (VPN, Hyper-V,
 * Docker) — die hängen an keinem Switch-Port.
 */
function macsAus(inventar) {
  const macs = {};
  for (const n of inventar?.netz || []) {
    if (!n.mac || (n.art !== 'kabel' && n.art !== 'wlan')) continue;
    const name = (n.name || n.mac).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || n.mac;
    macs[name in macs ? `${name}-${n.mac.slice(-5)}` : name] = n.mac;
  }
  return macs;
}

/**
 * Das alte Lebenszeichen (station-agent.sh) aus dem neuen Inventar. /stationen,
 * die Doppel-Erkennung (uptime_seconds, ip) und manches Skript lesen diese
 * Felder — sie sollen für einen Windows-PC dasselbe sagen wie für eine
 * Linux-Station, ohne dass jede Stelle zwei Formate kennt.
 */
function v1Felder(inventar, agent, stationId) {
  const standard = (inventar.netz || []).find((n) => n.standard && n.ipv4.length)
    || (inventar.netz || []).find((n) => n.ipv4.length);
  const bs = inventar.betriebssystem || {};
  const os = [bs.name, bs.version, bs.build ? `(${bs.build})` : null].filter(Boolean).join(' ') || null;
  // Belegung der Systemplatte: C: bei Windows, / bei Linux, sonst die erste.
  const platte = (inventar.platten || []).find((p) => /^(c:|\/)$/i.test(p.laufwerk)) || (inventar.platten || [])[0];
  const disk = platte && platte.gesamt_bytes
    ? Math.round(((platte.gesamt_bytes - (platte.frei_bytes || 0)) / platte.gesamt_bytes) * 100) : null;
  const jetzt = new Date();
  return {
    station_id: stationId,
    hostname: inventar.hostname,
    ip: standard ? standard.ipv4[0] : null,
    os_version: os,
    uptime_seconds: inventar.laufzeit_sekunden,
    disk_percent: disk,
    ts: jetzt.toISOString(),
    epoch: jetzt.getTime(),
    protokoll: PROTOKOLL,
    agent_version: agent.version,
    plattform: agent.plattform,
  };
}

// ─── Befehle ────────────────────────────────────────────────────────
//
// Was /stationen einem Gerät auftragen kann. Der Agent holt es beim
// Lebenszeichen ab — die Geräte haben keinen offenen Port, und das soll so
// bleiben. Jeder Befehl gilt nur kurz: ein PC, der übers Wochenende aus war,
// soll am Montag nicht als Erstes neu starten.
//
// Ausgeliefert wird höchstens einmal (abgeholt_am). Kommt keine Quittung,
// steht das auf /stationen; erneut geschickt wird nichts — ein doppelter
// Neustart ist schlimmer als ein fehlender.
//
// Sperren ist KEIN Befehl, sondern ein Zustand (status = 'gesperrt'): er
// kommt mit jedem Lebenszeichen, wirkt nach einem Neustart weiter und wird
// nur durch eine echte Antwort aufgehoben — wie bei station-sperre.
const BEFEHLE = {
  nachricht: {
    titel: 'Nachricht anzeigen',
    plattformen: ['windows', 'linux'],
    minuten: 60,
    pruefen(p) {
      const t = text(p?.text, 500);
      if (!t) return { fehler: 'Text fehlt (höchstens 500 Zeichen)' };
      return { wert: { text: t } };
    },
  },
  abmelden: {
    titel: 'Abmelden',
    plattformen: ['windows', 'linux'],
    minuten: 15,
    pruefen(p) {
      // Vorwarnung, damit niemand mitten im Satz abgemeldet wird. Gespeichert
      // ist dann, was gespeichert ist — darum mindestens eine Minute.
      const vorwarnung = p?.vorwarnung_sekunden == null ? 60 : zahl(p.vorwarnung_sekunden, 30, 900);
      if (vorwarnung === null) return { fehler: 'Vorwarnung: 30 bis 900 Sekunden' };
      return { wert: { vorwarnung_sekunden: vorwarnung, text: text(p?.text, 300) } };
    },
  },
  neustart: {
    titel: 'Neu starten',
    plattformen: ['windows', 'linux'],
    minuten: 15,
    pruefen(p) {
      const verz = p?.verzoegerung_sekunden == null ? 300 : zahl(p.verzoegerung_sekunden, 60, 3600);
      if (verz === null) return { fehler: 'Verzögerung: 60 bis 3600 Sekunden' };
      return { wert: { verzoegerung_sekunden: verz, text: text(p?.text, 300) } };
    },
  },
  // Einmal vom Netz starten (PXE), für die Sicherung. Windows: bcdedit
  // {fwbootmgr} bootsequence über os-stationen/sicherung/windows/
  // netzstart-einmal.ps1 — dasselbe Skript wie von Hand, der Agent ruft es
  // nur mit -Setzen auf und startet danach mit Vorwarnung neu.
  netzstart_einmal: {
    titel: 'Einmal vom Netz starten (Sicherung)',
    plattformen: ['windows'],
    minuten: 15,
    pruefen(p) {
      const verz = p?.verzoegerung_sekunden == null ? 120 : zahl(p.verzoegerung_sekunden, 60, 3600);
      if (verz === null) return { fehler: 'Verzögerung: 60 bis 3600 Sekunden' };
      return { wert: { verzoegerung_sekunden: verz, text: text(p?.text, 300) } };
    },
  },
  // Sofort ein volles Inventar schicken (BitLocker, Updates werden sonst nur
  // alle 30 Minuten gelesen).
  inventar: {
    titel: 'Inventar jetzt lesen',
    plattformen: ['windows', 'linux'],
    minuten: 15,
    pruefen() { return { wert: {} }; },
  },
};

/**
 * Einen Befehl aus /stationen prüfen.
 * @returns {{wert:{art,parameter,minuten}}|{fehler:string}}
 */
function befehlPruefen(art, parameter, plattform) {
  const b = Object.prototype.hasOwnProperty.call(BEFEHLE, art) ? BEFEHLE[art] : null;
  if (!b) return { fehler: `Unbekannter Befehl '${String(art).slice(0, 40)}'` };
  if (!plattform) return { fehler: 'Auf diesem Gerät läuft noch kein Agent (Protokoll 2)' };
  if (!b.plattformen.includes(plattform)) return { fehler: `„${b.titel}" gibt es auf ${plattform} nicht` };
  const e = b.pruefen(parameter && typeof parameter === 'object' ? parameter : {});
  if (e.fehler) return e;
  return { wert: { art, parameter: e.wert, minuten: b.minuten } };
}

/** Was der Agent über einen Befehl erfährt. */
function befehlFuerAgent(z) {
  return {
    id: Number(z.id),
    art: z.art,
    parameter: z.parameter || {},
    gueltig_bis: z.gueltig_bis instanceof Date ? z.gueltig_bis.toISOString() : z.gueltig_bis,
  };
}

const QUITTUNG_ERGEBNISSE = ['ok', 'fehler', 'abgelehnt'];

/** Quittungen aus dem Lebenszeichen, höchstens 20, nur gültige. */
function quittungenBereinigen(roh) {
  return liste(roh, 20).map((q) => ({
    id: zahl(q?.id, 1),
    ergebnis: QUITTUNG_ERGEBNISSE.includes(q?.ergebnis) ? q.ergebnis : null,
    text: text(q?.text, 1000),
  })).filter((q) => q.id && q.ergebnis);
}

/** Meldungen des Agenten (Ereignisse wie „gesperrt angewandt"). */
function meldungenBereinigen(roh) {
  return liste(roh, 10).map((m) => ({
    art: typeof m?.art === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(m.art) ? m.art : null,
    text: text(m?.text, 500),
  })).filter((m) => m.art);
}

// ─── Kerberos ───────────────────────────────────────────────────────

/**
 * Aus dem Kerberos-Namen den Rechner: 'WIN11-1$' im Realm des AD -> 'WIN11-1'.
 * Nur Computerkonten (Name endet auf $) und nur der eigene Realm. Ein
 * Benutzerkonto bekommt vom KDC zwar auch ein Ticket für die API — aber eine
 * Person ist kein Rechner.
 */
function rechnerAusPrincipal(principal, realm, erwarteterRealm) {
  const p = String(principal || '');
  if (!erwarteterRealm || String(realm || '').toUpperCase() !== String(erwarteterRealm).toUpperCase()) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,62})\$$/.exec(p);
  return m ? m[1] : null;
}

/** Was der Agent als Intervall bekommt — die Vorgabe oder overrides.agent. */
function intervall(overrides) {
  const n = zahl(overrides?.agent?.intervall_sekunden, INTERVALL_MIN, INTERVALL_MAX);
  return n || INTERVALL_SEKUNDEN;
}

module.exports = {
  PROTOKOLL, PLATTFORMEN, INTERVALL_SEKUNDEN, BEFEHLE,
  inventarBereinigen, agentBereinigen, macsAus, v1Felder,
  befehlPruefen, befehlFuerAgent, quittungenBereinigen, meldungenBereinigen,
  rechnerAusPrincipal, intervall, normMac,
};
