// Benutzerbild für die Stationen — aus Authentik, nicht aus dem AD.
//
// Cinnamon zeigt im Menü, im Anmelde- und im Sperrbildschirm das Bild aus
// /var/lib/AccountsService/icons/<benutzer>. Woher es kommt, war die Frage.
//
// Im AD steht ein `thumbnailPhoto` — aber bei allen 84 Konten dasselbe: das
// Rosenweg-Wappen, 96×96, identische Prüfsumme. Als Anmeldebild wäre das
// schlechter als nichts; es sähe aus, als wäre es eingerichtet, und jede
// Person sähe dasselbe.
//
// Authentik dagegen liefert je Konto ein fertiges Bild. Die Einstellung
// `avatars` steht auf einer Kette, und wo kein ausdrückliches Bild gesetzt
// ist, rendert Authentik die Initialen als SVG:
//
//   <rect fill="#c85d68" …/><text …>SM</text>
//
// Das ist genau, was gebraucht wird — und es wird von selbst zum hochgeladenen
// Foto, sobald jemand eines hinterlegt. Kein zweiter Ort, an dem Initialen
// erzeugt werden, und nichts, was ins AD zurückgeschrieben werden muss.
//
// Die Stationen fragen nicht selbst bei Authentik: dort läge der API-Token auf
// jedem Gerät. Sie fragen die Rosenweg-API mit ihrem Stationstoken, und die
// holt es.
const { AUTHENTIK_URL, AUTHENTIK_API_TOKEN } = require('./config');

// Der Blauton des Sperrbildschirms (roles/desktop/parts/20-look.sh). Authentik
// würfelt die Farbe aus dem Namen; im Haus soll es ruhig und einheitlich sein.
const ROSENWEG_BLAU = '#0f172a';

const SVG_PRAEFIX = 'data:image/svg+xml;base64,';

/**
 * Das von Authentik erzeugte Initialen-SVG auf Rosenweg-Blau umfärben und auf
 * die gewünschte Kantenlänge bringen. Der viewBox bleibt, also skaliert es
 * verlustfrei.
 *
 * Bewusst nur zwei gezielte Ersetzungen statt eines SVG-Umbaus: was Authentik
 * an seinem Markup ändert, soll hier nicht gleich alles brechen. Passt das
 * Muster nicht, bleibt das SVG eben, wie es war — bunt, aber brauchbar.
 */
function initialenUmfaerben(svg, groesse) {
  let out = svg;

  // Hintergrund: Farbe setzen und die Ecken zum Kreis runden. Authentik nutzt
  // ein <rect> mit cx/cy/r — Attribute, die dort nichts tun. rx wirkt.
  //
  // Das Tag ist selbstschliessend (`<rect …/>`). Ein Attribut einfach vor das
  // `>` zu hängen ergab `…/ rx="50%">` — kaputtes XML, und librsvg zeichnet
  // dann gar nichts. Deshalb wird der Attributteil sauber zerlegt und wieder
  // zusammengesetzt.
  out = out.replace(/<rect\b([^>]*)>/, (ganzes, attribute) => {
    if (!/fill="#[0-9a-fA-F]{3,8}"/.test(attribute)) return ganzes;
    const selbstschliessend = /\/\s*$/.test(attribute);
    let a = attribute.replace(/\/\s*$/, '').replace(/\s+$/, '');
    a = a.replace(/fill="#[0-9a-fA-F]{3,8}"/, `fill="${ROSENWEG_BLAU}"`);
    if (!/\brx=/.test(a)) a += ' rx="50%"';
    return `<rect${a}${selbstschliessend ? '/' : ''}>`;
  });

  if (Number.isFinite(groesse) && groesse > 0) {
    out = out
      .replace(/width="\d+px"/, `width="${groesse}px"`)
      .replace(/height="\d+px"/, `height="${groesse}px"`);
  }
  return out;
}

/** Ist das ein von Authentik erzeugtes Initialenbild — oder ein echtes Foto? */
function istInitialenbild(svg) {
  return /<text\b/.test(svg) && /<rect\b/.test(svg);
}

/**
 * Das Bild einer Person holen.
 * @param {string} benutzername  sAMAccountName bzw. Authentik-Username
 * @param {number} groesse       Kantenlänge in Pixeln (nur für Initialen)
 * @returns {Promise<{typ: string, daten: Buffer, herkunft: string}|null>}
 */
async function benutzerbild(benutzername, groesse = 256) {
  if (!AUTHENTIK_API_TOKEN || !AUTHENTIK_URL) return null;
  const name = String(benutzername || '').trim();
  if (!name) return null;

  const basis = AUTHENTIK_URL.replace(/\/$/, '');
  const r = await fetch(`${basis}/api/v3/core/users/?search=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${AUTHENTIK_API_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Authentik antwortete mit ${r.status}`);

  const daten = await r.json();
  // search trifft auch Teilzeichenketten — die Person mit genau diesem
  // Benutzernamen nehmen, sonst bekäme 'hans' das Bild von 'hans.beat'.
  const person = (daten.results || []).find(
    (u) => String(u.username || '').toLowerCase() === name.toLowerCase(),
  );
  if (!person || !person.avatar) return null;

  const avatar = String(person.avatar);

  if (avatar.startsWith(SVG_PRAEFIX)) {
    const svg = Buffer.from(avatar.slice(SVG_PRAEFIX.length), 'base64').toString('utf8');
    const fertig = istInitialenbild(svg) ? initialenUmfaerben(svg, groesse) : svg;
    return { typ: 'image/svg+xml', daten: Buffer.from(fertig, 'utf8'), herkunft: 'initialen' };
  }

  if (avatar.startsWith('data:')) {
    const treffer = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(avatar);
    if (!treffer) return null;
    const [, typ, base64, nutzlast] = treffer;
    return {
      typ,
      daten: base64 ? Buffer.from(nutzlast, 'base64') : Buffer.from(decodeURIComponent(nutzlast), 'utf8'),
      herkunft: 'hochgeladen',
    };
  }

  // Gravatar oder eine andere Adresse: die Station kommt nicht ins Internet,
  // also wird hier geholt und weitergereicht.
  if (/^https?:\/\//.test(avatar)) {
    const bild = await fetch(avatar, { signal: AbortSignal.timeout(10000) });
    if (!bild.ok) return null;
    return {
      typ: bild.headers.get('content-type') || 'image/jpeg',
      daten: Buffer.from(await bild.arrayBuffer()),
      herkunft: 'gravatar',
    };
  }

  return null;
}

module.exports = { benutzerbild, initialenUmfaerben, istInitialenbild, ROSENWEG_BLAU };
