// ═══════════════════════════════════════════════════════════════════
// SSH-SCHLUESSEL — Pruefung, Fingerabdruck, GitHub-Bezug
//
// Oeffentliche Schluessel sind harmlos zu lesen. Kritisch ist, was wir
// annehmen: Ein angenommener Schluessel ist eine Tuer. Darum wird hier
// streng geparst statt nur oberflaechlich geprueft — der eingebettete
// Typ im Blob muss zum vorangestellten Typ passen, sonst waere das
// Feld ein Ablageort fuer beliebigen Text, den sshd spaeter anders
// liest als wir.
// ═══════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Was wir annehmen. Kein DSA (zu schwach), kein ssh-rsa unter 2048 Bit.
const ERLAUBTE_TYPEN = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa',
]);

// Liest den ersten laengenpraefixierten String aus dem Blob. OpenSSH
// legt dort den Typ ab — er muss mit dem Typ vor dem Base64 passen.
function typAusBlob(blob) {
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len < 1 || len > 64 || blob.length < 4 + len) return null;
  return blob.subarray(4, 4 + len).toString('ascii');
}

// RSA-Blob: string type, mpint e, mpint n. Die Bitlaenge steckt in n.
function rsaBits(blob) {
  let p = 0;
  const naechstes = () => {
    if (blob.length < p + 4) return null;
    const len = blob.readUInt32BE(p);
    if (blob.length < p + 4 + len) return null;
    const teil = blob.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    return teil;
  };
  naechstes();                      // type
  if (!naechstes()) return 0;       // e
  const n = naechstes();
  if (!n) return 0;
  let i = 0;
  while (i < n.length && n[i] === 0) i++;   // fuehrende Null der mpint
  return (n.length - i) * 8;
}

/**
 * Prueft eine Zeile im authorized_keys-Format.
 * Gibt { typ, blobB64, kommentar, fingerprint } zurueck oder wirft.
 */
function schluesselPruefen(zeile) {
  const roh = String(zeile || '').trim();
  if (!roh) throw new Error('Kein Schlüssel angegeben');
  if (roh.length > 16384) throw new Error('Schlüssel ist unplausibel lang');
  if (/[\r\n]/.test(roh)) throw new Error('Mehrere Zeilen — bitte einen Schlüssel pro Eintrag');

  const teile = roh.split(/\s+/);
  // Optionen vor dem Typ (command=, from=, ...) lehnen wir ab: Sie
  // gehoeren nicht ins Profil, sondern in die Politik auf dem Host.
  if (!ERLAUBTE_TYPEN.has(teile[0])) {
    throw new Error(`Nicht unterstützter oder unzulässiger Schlüsseltyp: ${teile[0].slice(0, 40)}`);
  }
  const typ = teile[0];
  const blobB64 = teile[1] || '';
  if (!/^[A-Za-z0-9+/]+=*$/.test(blobB64)) throw new Error('Der Schlüssel ist nicht sauber Base64-kodiert');

  let blob;
  try { blob = Buffer.from(blobB64, 'base64'); } catch { throw new Error('Schlüssel nicht lesbar'); }
  if (blob.length < 16) throw new Error('Schlüssel zu kurz');

  const innen = typAusBlob(blob);
  if (innen !== typ) throw new Error('Typ und Schlüsselinhalt passen nicht zusammen');
  if (typ === 'ssh-rsa' && rsaBits(blob) < 2048) throw new Error('RSA-Schlüssel unter 2048 Bit werden nicht angenommen');

  const kommentar = teile.slice(2).join(' ').slice(0, 200);
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { typ, blobB64, kommentar, fingerprint };
}

/** Wieder zu einer authorized_keys-Zeile zusammensetzen. */
function alsZeile(k) {
  return k.kommentar ? `${k.typ} ${k.blob_b64} ${k.kommentar}` : `${k.typ} ${k.blob_b64}`;
}

const GITHUB_BENUTZER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Holt die oeffentlichen Schluessel eines GitHub-Kontos.
 * Bewusst mit knappem Timeout: Das Ergebnis wird bei uns zwischen-
 * gespeichert, nie im Anmeldepfad live abgefragt.
 */
async function githubSchluessel(benutzer, timeoutMs = 8000) {
  if (!GITHUB_BENUTZER.test(String(benutzer || ''))) throw new Error('Ungültiger GitHub-Benutzername');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://github.com/${benutzer}.keys`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'rosenweg-ssh-sync' },
    });
    if (r.status === 404) throw new Error(`GitHub-Konto "${benutzer}" existiert nicht`);
    if (!r.ok) throw new Error(`GitHub antwortete mit ${r.status}`);
    const text = await r.text();
    if (text.length > 65536) throw new Error('Antwort von GitHub unplausibel gross');
    const gueltig = [];
    for (const zeile of text.split('\n')) {
      if (!zeile.trim()) continue;
      try { gueltig.push(schluesselPruefen(zeile)); } catch { /* einzelne unbrauchbare Zeile ueberspringen */ }
    }
    return gueltig;
  } finally { clearTimeout(t); }
}

module.exports = { schluesselPruefen, alsZeile, githubSchluessel, GITHUB_BENUTZER, ERLAUBTE_TYPEN };
