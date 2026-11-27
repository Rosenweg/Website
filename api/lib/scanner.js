// Scanner-Konten: je allgemeinem Rosenweg-Scanner ein eigenes AD-Konto
// (Entscheid Stefan 27.11.2026). Bisher teilten sich alle das Konto
// `scanner`, dessen Passwort in einer Bewohner-Anleitung stand; es ist
// deaktiviert. Bewohner scannen mit ihrem eigenen Konto (Stationen).
//
// Rein funktional, ohne Datenbank und ohne Netz: die Geräteliste, das
// Passwort und der Zettel. Den Ablauf (AD setzen, drucken, Protokoll) macht
// routes/scanner.js.
//
// Ablage: Freigabe `scans` auf dem Fileserver-Paar (files.ad…, 100.64.2.29),
// `valid users = @scanner-geraete`, `path = /mnt/cephfs-stage/Scans/%u`. Jedes
// Gerät landet so von selbst in seinem eigenen Ordner Scans/<konto> und sieht
// die Scans der anderen nicht. Siehe fileserver-lxc/scans/README.md.
const crypto = require('crypto');

// ─── Geräte ─────────────────────────────────────────────────────────────────
// Nur Geräte, die selbst auf eine Freigabe scannen und dafür ein Konto
// brauchen. Gemessen am 27.11.2026 (UniFi-Clients, Web-Oberflächen, CUPS CT 111):
//
//   DruckerR13  Brother MFC-J6510DW, 100.64.139.4 (Rosenweg 13). Kann «Scan to
//               FTP/Network»; Profil 1 «Rosenweg» zeigte per FTP auf
//               100.64.2.28 mit dem lokalen Konto `scanner` — dessen
//               local_root /srv/documents/Scans gibt es seit dem Umzug auf
//               CephFS nicht mehr, letzter FTP-Eintrag Juni 2026.
//   DruckerR9   Brother DCP-1612W (DCP-1610W series), 100.64.99.4 (Rosenweg 9).
//               Hat kein «Scan to Network»; scannt nur an einen Rechner
//               (Stationen, WSD). Braucht kein Konto, steht deshalb nicht hier.
//
// Kommt ein Gerät dazu: hier eintragen, Konto anlegen (README oben), fertig.
// `id` steht in der URL, `konto` ist der sAMAccountName im AD.
const SCANNER = [
  {
    id: 'r13', name: 'DruckerR13', modell: 'Brother MFC-J6510DW', standort: 'Rosenweg 13',
    ip: '100.64.139.4', konto: 'scan-r13',
    // Wo man es am Gerät einstellt (steht auf dem Zettel)
    einstellen: 'Web-Oberfläche http://100.64.139.4/ → Scan → Scan to FTP/Network Profile → Profil 1: '
      + 'Typ «Network», Werte unten eintragen, «Submit». Am Gerät: Scan → Scan to FTP/Network → Rosenweg.',
    anmeldung: 'NTLMv2',
  },
];

const ZIEL = {
  server: process.env.SCANNER_SMB_SERVER || '100.64.2.29',
  servername: process.env.SCANNER_SMB_SERVERNAME || 'files.ad.rosenweg4303.ch',
  freigabe: process.env.SCANNER_SMB_FREIGABE || 'scans',
  domaene: process.env.SCANNER_AD_DOMAENE || 'ROSENWEG',
};

// Der Zettel kommt immer aus diesem Drucker (Rosenweg 9, beim Technikraum).
const ZETTEL_DRUCKER = process.env.SCANNER_ZETTEL_DRUCKER || 'DruckerR9';

const KONTO_RE = /^scan-[a-z0-9]{1,15}$/;
const ID_RE = /^[a-z0-9]{1,15}$/;

function scannerFinden(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return SCANNER.find(s => s.id === id) || null;
}

/** Prüft die Liste (Test und Start): eindeutige ids/Konten, Konten nur scan-*. */
function listePruefen(liste = SCANNER) {
  const fehler = [];
  const ids = new Set(), konten = new Set();
  for (const s of liste) {
    if (!ID_RE.test(s.id || '')) fehler.push(`id ${s.id}`);
    if (!KONTO_RE.test(s.konto || '')) fehler.push(`konto ${s.konto} (nur scan-…)`);
    if (ids.has(s.id)) fehler.push(`id ${s.id} doppelt`);
    if (konten.has(s.konto)) fehler.push(`konto ${s.konto} doppelt`);
    ids.add(s.id); konten.add(s.konto);
  }
  return fehler;
}

// ─── Passwort ───────────────────────────────────────────────────────────────
// Am Gerät eintippbar und vom Zettel fehlerfrei abzulesen: keine Zeichen, die
// sich verwechseln lassen (0/O/o, 1/l/I/i, 2/Z/z, 5/S/s, 8/B) und keine
// Kleinbuchstaben, die gross genauso aussehen (c k p s u v w x y z). Keine
// Sonderzeichen: die sind auf Gerätetastaturen tief versteckt.
// 16 Zeichen aus 41 -> rund 85 Bit. Das AD verlangt Komplexität (3 von 4
// Klassen), deshalb immer mindestens ein Gross-, Kleinbuchstabe und eine Ziffer.
const GROSS = 'ACDEFGHJKLMNPQRTUVWXY';
const KLEIN = 'abdefghjmnqrt';
const ZIFFERN = '346789';
const ALLE = GROSS + KLEIN + ZIFFERN;
const PASSWORT_LAENGE = 16;

function passwortErzeugen(zufall = crypto.randomInt) {
  for (;;) {
    let p = '';
    for (let i = 0; i < PASSWORT_LAENGE; i++) p += ALLE[zufall(ALLE.length)];
    if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)) return p;
  }
}

/** Für den Zettel in Vierergruppen: "AbC3 …" (eingegeben wird ohne Leerzeichen). */
const gruppiert = (p) => String(p).match(/.{1,4}/g).join(' ');

/** Ein Text, in dem das Passwort vorkommen könnte (Fehlermeldungen), ohne das Passwort. */
function ohnePasswort(text, passwort) {
  let t = String(text ?? '');
  if (passwort) t = t.split(passwort).join('***');
  return t.slice(0, 500);
}

// ─── Zettel ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * HTML für den Zettel (A4, Gotenberg). meta: { zeit: Date, von: Name/Adresse }.
 * Mit Absicht ohne Bilder, Schriften oder Skripte von aussen.
 */
function zettelHtml(scanner, passwort, { zeit = new Date(), von = '' } = {}) {
  const wann = zeit.toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'long', timeStyle: 'short' });
  const zeile = (k, v, extra = '') => `<tr><th>${esc(k)}</th><td>${v}${extra ? `<div class="klein">${extra}</div>` : ''}</td></tr>`;
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Scanner-Zugang</title>
<style>
  body { font-family: "DejaVu Sans", Arial, sans-serif; font-size: 12pt; color: #000; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  .unter { color: #333; margin-bottom: 14pt; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 7pt 8pt; border-bottom: 1px solid #999; }
  th { width: 34%; font-weight: normal; color: #333; }
  td { font-weight: bold; }
  .mono { font-family: "DejaVu Sans Mono", "Courier New", monospace; font-size: 15pt; letter-spacing: 1pt; }
  .pw { font-family: "DejaVu Sans Mono", "Courier New", monospace; font-size: 26pt; letter-spacing: 3pt; }
  .klein { font-weight: normal; font-size: 9.5pt; color: #333; margin-top: 3pt; }
  .box { border: 2px solid #000; padding: 10pt 12pt; margin-top: 18pt; }
  .fuss { margin-top: 16pt; font-size: 9pt; color: #555; }
</style></head><body>
<h1>Scanner-Zugang ${esc(scanner.name)}</h1>
<div class="unter">${esc(scanner.modell)} · ${esc(scanner.standort)} · Gerät ${esc(scanner.ip)}</div>
<table>
${zeile('Server (Host Address)', `<span class="mono">${esc(ZIEL.server)}</span>`, `Name: ${esc(ZIEL.servername)} – das Gerät nimmt besser die Adresse`)}
${zeile('Freigabe (Store Directory)', `<span class="mono">${esc(ZIEL.freigabe)}</span>`)}
${zeile('Pfad / Unterordner', 'keiner', `Der Server legt die Scans selbst in <span class="mono" style="font-size:9.5pt">Scans/${esc(scanner.konto)}</span> ab.`)}
${zeile('Benutzer (Username)', `<span class="mono">${esc(scanner.konto)}</span>`, `Verlangt das Gerät die Domäne: <span class="mono" style="font-size:9.5pt">${esc(ZIEL.domaene)}\\${esc(scanner.konto)}</span>`)}
${zeile('Passwort', `<span class="pw">${esc(gruppiert(passwort))}</span>`, 'Ohne Leerzeichen eingeben. Gross- und Kleinschreibung beachten. Keine Null, kein O, keine Eins, kein l.')}
${zeile('Anmeldeart', esc(scanner.anmeldung || 'NTLMv2'))}
${zeile('Wo einstellen', `<span style="font-weight:normal">${esc(scanner.einstellen || 'am Gerät bzw. in seiner Web-Oberfläche')}</span>`)}
${zeile('Gesetzt', esc(wann), von ? `von ${esc(von)}` : '')}
</table>
<div class="box"><strong>Nach dem Eintragen diesen Zettel vernichten</strong> (Schredder oder klein zerreissen).
Nicht fotografieren, nicht aufbewahren, nicht weitergeben. Das Passwort gilt nur für dieses Gerät;
das bisherige gilt ab jetzt nicht mehr. Verloren oder vergessen: im Portal unter «Scanner» ein neues drucken.</div>
<div class="fuss">STWEG-Kooperation Rosenweg · Technik · Das Passwort ist nirgends gespeichert, auch nicht im Portal.</div>
</body></html>`;
}

// ─── Ablauf (ohne Express und Datenbank; routes/scanner.js gibt die Teile) ──
// Ergebnis -> was die Seite sagt. Nie mit dem Passwort.
const MELDUNG = {
  ok: (s, d) => `Zettel für ${s.name} kommt aus ${d}. Das neue Passwort gilt ab jetzt: am Gerät eintragen, Zettel danach vernichten.`,
  'pdf-fehler': () => 'Der Zettel liess sich nicht erzeugen. Nichts geändert, das bisherige Passwort gilt weiter.',
  'druck-fehler': (s, d) => `${d} hat den Zettel nicht angenommen. Nichts geändert, das bisherige Passwort gilt weiter.`,
  'ad-fehler': (s, d) => `Gedruckt, aber im AD NICHT gesetzt. Der Zettel auf ${d} ist ungültig – bitte vernichten. Das bisherige Passwort gilt weiter.`,
  'ad-unklar': (s, d) => `Gedruckt; das AD hat nicht rechtzeitig geantwortet. Den Zettel auf ${d} am Gerät ausprobieren – scannt es nicht, nochmals drucken.`,
  'kein-konto': (s, d) => `Gedruckt, aber das Konto ${s.konto} gibt es im AD nicht. Zettel auf ${d} vernichten und das Konto zuerst anlegen (fileserver-lxc/scans/README.md).`,
};

/**
 * Der Ablauf, ohne Express und ohne Datenbank (Tests).
 * deps: { htmlZuPdf(html), drucken(drucker, pdf, name), adSetzen(konto, pw),
 *         protokollieren(zeile), passwortErzeugen(), jetzt() }
 * -> { ergebnis, status, meldung }
 */
async function passwortDrucken(scanner, wer, deps) {
  const drucker = deps.drucker || ZETTEL_DRUCKER;
  const zeit = deps.jetzt ? deps.jetzt() : new Date();
  const zeile = (ergebnis, detail = '') => ({
    scanner_id: scanner.id, konto: scanner.konto, email: wer.email || null, name: wer.name || null,
    art: wer.art || null, ergebnis, detail: String(detail || '').slice(0, 500), zeit,
  });
  const fertig = async (ergebnis, status, detail) => {
    // Ein Protokollfehler darf das Ergebnis nicht verdecken (das AD ist dann evtl. schon gesetzt)
    try { await deps.protokollieren(zeile(ergebnis, detail)); } catch (e) { console.error('[scanner] Protokoll:', e.message); }
    return { ergebnis, status, meldung: MELDUNG[ergebnis](scanner, drucker) };
  };

  let passwort = deps.passwortErzeugen ? deps.passwortErzeugen() : passwortErzeugen();
  try {
    let pdf;
    try {
      pdf = await deps.htmlZuPdf(zettelHtml(scanner, passwort, { zeit, von: wer.name || wer.email || '' }));
    } catch (e) {
      return await fertig('pdf-fehler', 502, ohnePasswort(e?.message, passwort));
    }

    let druck;
    try {
      druck = await deps.drucken(drucker, pdf, 'scanner-zugang.pdf');
    } catch (e) {
      druck = { ok: false, message: e?.message };
    }
    pdf = null;
    if (!druck.ok) return await fertig('druck-fehler', 502, ohnePasswort(druck.message || druck.status, passwort));

    const ad = await deps.adSetzen(scanner.konto, passwort);
    if (ad.ok) return await fertig('ok', 200, `${drucker}: ${ohnePasswort(druck.message, passwort)}`);
    const text = ohnePasswort(ad.fehler, passwort);
    if (ad.zeitueberschreitung) return await fertig('ad-unklar', 502, text);
    if (/unable to find user|no such user|not found/i.test(text)) return await fertig('kein-konto', 502, text);
    return await fertig('ad-fehler', 502, text);
  } finally {
    passwort = null; // nur Verweis weg; JS-Strings lassen sich nicht überschreiben
  }
}

module.exports = {
  MELDUNG, passwortDrucken,
  SCANNER, ZIEL, ZETTEL_DRUCKER, KONTO_RE, scannerFinden, listePruefen,
  GROSS, KLEIN, ZIFFERN, PASSWORT_LAENGE, passwortErzeugen, gruppiert, ohnePasswort, zettelHtml,
};
