// Tägliche Läufe zu einer festen Uhrzeit (Schweizer Zeit), Befund W27.
//
// setInterval(fn, 24 h) läuft 24 h nach dem Prozessstart – nach einem Neustart
// am Nachmittag also jeden Nachmittag, nicht wie kommentiert nachts. taeglichUm()
// plant jeden Lauf neu auf die nächste Uhrzeit in Europe/Zurich, auch über die
// Umstellung Sommer-/Winterzeit.

const ZONE = 'Europe/Zurich';

function teile(datum, zone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(datum)) o[p.type] = p.value;
  return o;
}

/** Abstand Wanduhr der Zone minus UTC in ms für diesen Zeitpunkt. */
function versatzMs(datum, zone = ZONE) {
  const o = teile(datum, zone);
  const alsUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return alsUtc - Math.floor(datum.getTime() / 1000) * 1000;
}

/** Nächster Zeitpunkt (Date) nach `jetzt`, an dem es in der Zone stunde:minute ist. */
function naechsterZeitpunkt(stunde, minute = 0, jetzt = new Date(), zone = ZONE) {
  const o = teile(jetzt, zone);
  for (let tag = 0; tag < 3; tag++) {
    const wanduhr = Date.UTC(+o.year, +o.month - 1, +o.day + tag, stunde, minute, 0);
    let t = wanduhr - versatzMs(new Date(wanduhr), zone);
    t = wanduhr - versatzMs(new Date(t), zone); // Versatz am Zielzeitpunkt (Umstellungstag)
    if (t > jetzt.getTime()) return new Date(t);
  }
  return new Date(jetzt.getTime() + 24 * 3600 * 1000);
}

/**
 * fn täglich um stunde:minute (Schweizer Zeit) ausführen. Fehler werden
 * gemeldet, der nächste Lauf wird trotzdem geplant. -> { stop(), naechster() }
 */
function taeglichUm(stunde, minute, fn, { name = 'tageslauf', zone = ZONE } = {}) {
  let h = null;
  let ziel = null;
  const planen = () => {
    ziel = naechsterZeitpunkt(stunde, minute, new Date(), zone);
    h = setTimeout(async () => {
      try { await fn(); } catch (e) { console.error(`[${name}]`, e.message); }
      planen();
    }, Math.max(1000, ziel.getTime() - Date.now()));
    h.unref?.();
  };
  planen();
  return { stop() { if (h) clearTimeout(h); h = null; }, naechster: () => ziel };
}

module.exports = { naechsterZeitpunkt, taeglichUm, versatzMs };
