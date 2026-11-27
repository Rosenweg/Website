// Erlaubte Programme auf den Windows-Rechnern der Domäne (AppLocker).
//
// Das Gegenstück zur Positivliste der Linux-Stationen (os-stationen,
// roles/desktop/parts/60-programme.sh): eine Liste, was laufen darf, gepflegt
// auf /stationen — für alle Windows-Rechner und zusätzlich je Rechner.
//
// Wer was tut:
//   - HIER steht der Katalog: welche Programme es zur Auswahl gibt und an
//     welchen Regeln AppLocker sie erkennt. Er ändert sich per Pull Request,
//     wie die Druckerliste in stationconfig.js — eine Regel ist Sicherheits-
//     technik, kein Freitext.
//   - Die Verwaltung (/stationen) wählt daraus: die Vorgabe für alle und
//     zusätzliche Programme je Rechner, dazu der Modus.
//   - Der Rechner holt sich das Ergebnis über GET /api/stations/programme/
//     <rechner> (programme.ps1 der GPO „Rosenweg-Look Windows") und baut
//     daraus die AppLocker-Regeln.
//
// Modus:
//   'probe'       Überwachung. Durchgesetzt bleibt der Grundschutz (alles
//                 unter Windows und den Programme-Ordnern, wie seit 22.11.);
//                 die Positivliste wird nur geprüft: der Rechner nimmt jedes
//                 erlaubte Programm aus dem AppLocker-Protokoll und fragt
//                 Test-AppLockerPolicy, ob die Liste es auch erlaubt hätte.
//                 Was nicht, meldet er hierher — /stationen zeigt es.
//   'durchsetzen' Die Positivliste gilt. Was nicht auf ihr steht, blockiert
//                 AppLocker; gemeldet werden dann die echten Sperren.
// Ein Rechner ohne Eintrag bekommt immer 'probe' — durchgesetzt wird nur,
// was jemand ausdrücklich so eingestellt hat.
//
// Gesperrt (SPERREN unten, Edge und OneDrive): Verbotsregeln, die auch die
// Ausnahmen schlagen — ein Verbot geht bei AppLocker jeder Erlaubnis vor.
//
// Nie von hier aus beeinflussbar (steht fest in programme.ps1): alles unter
// C:\Windows, die Gruppe Windows-Programme-frei und Administratoren mit
// Admin-Token, Dienste. Die API kann also nur ERLAUBEN, nie den Grundschutz
// wegnehmen oder Technik aussperren.

// Signaturen. Die Schreibweise ist die von AppLocker (Grossbuchstaben,
// Komma + Leerzeichen) — so stehen sie auch im Ereignisprotokoll.
const MS_WINDOWS = 'CN=MICROSOFT WINDOWS, O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US';
const MS_CORP_APPX = 'CN=MICROSOFT CORPORATION, O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US';
const MS_CORP_EXE = 'O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US';

const pfad = (p) => ({ art: 'pfad', pfad: p });
const paket = (name, herausgeber = MS_CORP_APPX) => ({ art: 'paket', herausgeber, paket: name });
const herausgeber = (h, produkt) => ({ art: 'herausgeber', herausgeber: h, produkt });

// %PROGRAMFILES% meint bei AppLocker beide Ordner: „Program Files" und
// „Program Files (x86)". Ordnerregeln nur dort, wo ausschliesslich Admins
// schreiben — sonst legt jemand ein Programm daneben und es ist erlaubt.
//
//   pflicht   immer dabei, nicht abwählbar (Windows selbst, Laufzeiten, das
//             Eigene). Fehlte eines, ginge Windows kaputt, nicht ein Programm.
//   standard  in der Vorgabe für alle, solange niemand sie geändert hat
//
// Abgeglichen mit win11-1 am 26.11.2026 (Program Files, AppLocker-Protokoll
// 8002/8020 der letzten Tage).
const KATALOG = [
  // ── Pflicht ────────────────────────────────────────────────────────────
  {
    id: 'windows-teile', name: 'Windows-Bestandteile unter Programme', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'Defender, Windows-Sicherheit, Zubehör, PowerShell, Store-Programmdateien, .NET, gemeinsame Dateien (auch Office-Updates)',
    regeln: [
      pfad('%PROGRAMFILES%\\Common Files\\*'),
      pfad('%PROGRAMFILES%\\Internet Explorer\\*'),
      pfad('%PROGRAMFILES%\\Windows Defender\\*'),
      pfad('%PROGRAMFILES%\\Windows Defender Advanced Threat Protection\\*'),
      pfad('%PROGRAMFILES%\\Windows Mail\\*'),
      pfad('%PROGRAMFILES%\\Windows Media Player\\*'),
      pfad('%PROGRAMFILES%\\Windows NT\\*'),
      pfad('%PROGRAMFILES%\\Windows Photo Viewer\\*'),
      pfad('%PROGRAMFILES%\\WindowsPowerShell\\*'),
      pfad('%PROGRAMFILES%\\WindowsApps\\*'),
      pfad('%PROGRAMFILES%\\ModifiableWindowsApps\\*'),
      pfad('%PROGRAMFILES%\\Microsoft.NET\\*'),
    ],
  },
  {
    id: 'edge-laufzeit', name: 'Edge-Laufzeit und Microsoft-Updates', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'WebView2 (brauchen Widgets, Outlook, Teams …) und der Updater von Edge',
    regeln: [
      pfad('%PROGRAMFILES%\\Microsoft\\EdgeWebView\\*'),
      pfad('%PROGRAMFILES%\\Microsoft\\EdgeUpdate\\*'),
      pfad('%PROGRAMFILES%\\Microsoft\\EdgeCore\\*'),
      pfad('%PROGRAMFILES%\\Microsoft\\Temp\\*'),
    ],
  },
  {
    id: 'rosenweg', name: 'Rosenweg (Startmenü, Anmeldung, Skripte)', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'BGInfo, Drucker, Laufwerke, Open-Shell',
    // pGina (frühere Windows-Anmeldung) wird nicht mehr benutzt: seit
    // 27.11.2026 nicht mehr freigegeben.
    regeln: [
      pfad('%PROGRAMFILES%\\Rosenweg\\*'),
      pfad('%PROGRAMFILES%\\Open-Shell\\*'),
    ],
  },
  // Bilder und Medien (27.11.2026): die Richtlinie installiert beide auf
  // jedem Rechner und macht sie zum Standard für Bilder bzw. Audio/Video
  // (rosenweg-look.ps1). Darum Pflicht und nicht nur Vorgabe — eine schon
  // gespeicherte Vorgabe auf /stationen kennte sie sonst nicht, und beim
  // Durchsetzen öffneten Doppelklicks auf Fotos und Aufnahmen ins Leere.
  // Die Ids bleiben (vlc stand schon im Katalog, vielleicht in Zusätzen).
  {
    id: 'irfanview', name: 'IrfanView (Bilder)', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'Standard für Bilder, mit Plugins — verteilt von der Richtlinie „Rosenweg-Look Windows"',
    regeln: [pfad('%PROGRAMFILES%\\IrfanView\\*')],
  },
  {
    id: 'vlc', name: 'VLC (Audio und Video)', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'Standard für Audio, Video und die Aufnahmen des Diktiergeräts — verteilt von der Richtlinie „Rosenweg-Look Windows"',
    regeln: [pfad('%PROGRAMFILES%\\VideoLAN\\*')],
  },
  {
    id: 'vm-werkzeuge', name: 'Gast-Werkzeuge (Proxmox-VM)', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'QEMU-Agent, SPICE, VirtIO — auf einem echten PC einfach nicht vorhanden',
    regeln: [
      pfad('%PROGRAMFILES%\\Qemu-ga\\*'),
      pfad('%PROGRAMFILES%\\Red Hat\\*'),
      pfad('%PROGRAMFILES%\\Spice Agent\\*'),
      pfad('%PROGRAMFILES%\\SPICE Guest Tools\\*'),
      pfad('%PROGRAMFILES%\\Virtio-Win\\*'),
    ],
  },
  {
    id: 'windows-apps', name: 'Windows-eigene Apps', gruppe: 'Immer erlaubt', pflicht: true,
    hinweis: 'Startmenü, Anmeldung (AAD-Broker), Sperrbildschirm, Widgets, Windows-Sicherheit',
    regeln: [
      // Alles, was Microsoft als Teil von Windows signiert (cw5n1h2txyewy).
      { art: 'paket', herausgeber: MS_WINDOWS, paket: '*' },
      paket('MICROSOFT.SECHEALTHUI'),
      paket('MICROSOFT.WIDGETSPLATFORMRUNTIME'),
      paket('MICROSOFT.STARTEXPERIENCESAPP'),
      paket('MICROSOFT.APPLICATIONCOMPATIBILITYENHANCEMENTS'),
    ],
  },

  // ── Programme ──────────────────────────────────────────────────────────
  { id: 'firefox', name: 'Firefox', gruppe: 'Internet', standard: true,
    regeln: [pfad('%PROGRAMFILES%\\Mozilla Firefox\\*'), pfad('%PROGRAMFILES%\\Mozilla Maintenance Service\\*')] },
  // Der Browser der Windows-Rechner (26.11.2026, statt Edge). Installiert
  // und eingestellt von rosenweg-look.ps1; der Google-Updater aktualisiert.
  { id: 'chrome', name: 'Google Chrome', gruppe: 'Internet', standard: true,
    regeln: [pfad('%PROGRAMFILES%\\Google\\Chrome\\Application\\*'), pfad('%PROGRAMFILES%\\Google\\Update\\*')] },

  { id: 'office', name: 'Microsoft Office / 365', gruppe: 'Büro', standard: true,
    regeln: [pfad('%PROGRAMFILES%\\Microsoft Office\\*'), pfad('%PROGRAMFILES%\\Microsoft Office 15\\*')] },
  { id: 'onlyoffice', name: 'ONLYOFFICE', gruppe: 'Büro', standard: true,
    regeln: [pfad('%PROGRAMFILES%\\ONLYOFFICE\\*')] },
  { id: 'libreoffice', name: 'LibreOffice', gruppe: 'Büro',
    regeln: [pfad('%PROGRAMFILES%\\LibreOffice\\*')] },
  { id: 'acrobat', name: 'Adobe Acrobat Reader', gruppe: 'Büro',
    regeln: [pfad('%PROGRAMFILES%\\Adobe\\Acrobat DC\\*'), pfad('%PROGRAMFILES%\\Adobe\\Acrobat Reader DC\\*'),
      pfad('%PROGRAMFILES%\\Adobe\\Acrobat Reader\\*')] },

  { id: '7zip', name: '7-Zip', gruppe: 'Werkzeuge', regeln: [pfad('%PROGRAMFILES%\\7-Zip\\*')] },
  { id: 'copilot', name: 'Copilot', gruppe: 'Werkzeuge', regeln: [pfad('%PROGRAMFILES%\\Microsoft\\Copilot\\*')] },
  { id: 'anydesk', name: 'AnyDesk (Fernwartung)', gruppe: 'Werkzeuge', regeln: [pfad('%PROGRAMFILES%\\AnyDesk\\*')] },

  // ── Store-Apps ─────────────────────────────────────────────────────────
  // Store-Apps installiert jede Person selbst, ohne Admin — darum gehören sie
  // hier auf die Liste und nicht pauschal „alles Signierte" wie bisher.
  { id: 'notepad', name: 'Editor', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.WINDOWSNOTEPAD')] },
  { id: 'paint', name: 'Paint', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.PAINT')] },
  { id: 'fotos', name: 'Fotos', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.WINDOWS.PHOTOS')] },
  { id: 'rechner', name: 'Rechner', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.WINDOWSCALCULATOR')] },
  { id: 'snipping', name: 'Snipping Tool', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.SCREENSKETCH')] },
  { id: 'medien', name: 'Medienwiedergabe', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.ZUNEMUSIC')] },
  { id: 'scan', name: 'Windows-Scan', gruppe: 'Store-Apps', standard: true, regeln: [paket('MICROSOFT.WINDOWSSCAN')] },
  { id: 'kamera', name: 'Kamera', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.WINDOWSCAMERA')] },
  { id: 'outlook', name: 'Outlook (neu)', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.OUTLOOKFORWINDOWS')] },
  { id: 'teams', name: 'Teams', gruppe: 'Store-Apps', regeln: [paket('MSTEAMS')] },
  { id: 'smartphone-link', name: 'Smartphone-Link', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.YOURPHONE')] },
  { id: 'store', name: 'Microsoft Store', gruppe: 'Store-Apps',
    hinweis: 'damit installiert jede Person selbst Apps',
    regeln: [paket('MICROSOFT.WINDOWSSTORE'), paket('MICROSOFT.STOREPURCHASEAPP')] },
  { id: 'terminal', name: 'Windows-Terminal', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.WINDOWSTERMINAL')] },
  { id: 'appinstaller', name: 'App-Installer (winget)', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.DESKTOPAPPINSTALLER')] },
  { id: 'quickassist', name: 'Remotehilfe', gruppe: 'Store-Apps', regeln: [paket('MICROSOFTCORPORATIONII.QUICKASSIST')] },
  { id: 'xbox', name: 'Xbox / Spiele', gruppe: 'Store-Apps',
    regeln: [paket('MICROSOFT.GAMINGAPP'), paket('MICROSOFT.XBOXGAMINGOVERLAY')] },
  { id: 'hilfe', name: 'Hilfe anfordern', gruppe: 'Store-Apps', regeln: [paket('MICROSOFT.GETHELP')] },
];

// ── Gesperrt ───────────────────────────────────────────────────────────────
// Auf allen Windows-Rechnern, auch für Technik (Stefan, 26.11.2026): Edge
// und OneDrive. AppLocker-Verbotsregeln an der Signatur, damit es auch eine
// Kopie an anderem Ort trifft. Sie gehören zur Positivliste, wirken also im
// gleichen Modus: beim Überwachen meldet der Rechner nur, wo Edge oder
// OneDrive gestartet wurde; durchgesetzt erst mit „Durchsetzen".
//
// WebView2 (msedgewebview2.exe) trägt das Produkt „MICROSOFT EDGE WEBVIEW2"
// und bleibt damit erlaubt — Widgets, Outlook, Teams und manches Programm
// zeigen ihre Oberfläche darin. Auf win11-1 nachgesehen: msedge.exe,
// msedge_proxy.exe, msedge_pwa_launcher.exe sind „MICROSOFT EDGE", der
// Installer „MICROSOFT EDGE INSTALLER", der Updater „MICROSOFT EDGE UPDATE"
// (der aktualisiert als SYSTEM auch WebView2 — SYSTEM prüft AppLocker nicht).
const SPERREN = [
  { id: 'edge', name: 'Microsoft Edge', hinweis: 'Browser, Installer und Updater im Namen der Person — WebView2 bleibt erlaubt',
    regeln: [
      herausgeber(MS_CORP_EXE, 'MICROSOFT EDGE'),
      herausgeber(MS_CORP_EXE, 'MICROSOFT EDGE INSTALLER'),
      herausgeber(MS_CORP_EXE, 'MICROSOFT EDGE UPDATE'),
    ] },
  { id: 'onedrive', name: 'OneDrive', hinweis: 'Programm und Einrichtung (OneDriveSetup.exe)',
    regeln: [herausgeber(MS_CORP_EXE, 'MICROSOFT ONEDRIVE')] },
];

const MODI = ['probe', 'durchsetzen'];
const NACH_ID = new Map(KATALOG.map((p) => [p.id, p]));
const STANDARD = KATALOG.filter((p) => p.standard && !p.pflicht).map((p) => p.id);

// ── Freie Freigaben ───────────────────────────────────────────────────────
// Was nicht im Katalog steht, lässt sich je Zeile eintragen:
//   C:\Program Files\Hersteller\Programm\*      ein Ordner unter Programme
//   C:\Program Files\Hersteller\prog.exe        eine Datei dort
//   Microsoft.BingWeather                       eine Store-App (Paketname)
// Nur unter den Programme-Ordnern: dort schreiben ausschliesslich Admins.
// Alles andere (C:\Tools\…, Netzlaufwerke) gehört in programme-freigaben.txt
// im Git und wird mit einrichten.sh verteilt — mit Review statt per Klick,
// denn ein Ordner, in den jeder schreiben kann, hebelte die Liste aus.
const MAX_FREIGABEN = 50;
const PAKET_MUSTER = /^[A-Za-z0-9][A-Za-z0-9.-]{2,99}$/;
const PROGRAMME_PRAEFIX = /^(?:%PROGRAMFILES%|[Cc]:\\Program Files(?: \(x86\))?)\\/;

/**
 * Eine Zeile prüfen und in die Form bringen, die der Rechner bekommt.
 * Gibt { regel } oder { fehler } zurück.
 */
function freigabeLesen(zeile) {
  const z = String(zeile || '').trim().replace(/\//g, '\\');
  if (!z) return { leer: true };
  if (!z.includes('\\')) {
    if (!PAKET_MUSTER.test(z)) return { fehler: `„${z}" ist weder ein Ordner unter Programme noch ein Paketname` };
    // Herausgeber '*' heisst: der Rechner liest ihn selbst aus dem
    // installierten Paket (Get-AppLockerFileInformation). AppLocker erlaubt
    // keinen Produktnamen ohne Herausgeber.
    return { regel: { art: 'paket', herausgeber: '*', paket: z.toUpperCase() } };
  }
  if (!PROGRAMME_PRAEFIX.test(z)) {
    return { fehler: `„${z}" liegt nicht unter C:\\Program Files — solche Freigaben gehören in programme-freigaben.txt (Git)` };
  }
  const rest = z.replace(PROGRAMME_PRAEFIX, '');
  // Mindestens ein Unterordner: „Program Files\*" wäre der alte Grundschutz.
  if (!rest || rest === '*' || /(^|\\)\.\.(\\|$)/.test(rest) || /[<>"|?]/.test(rest)
      || (rest.includes('*') && !/^[^*]+\\\*$/.test(rest))) {
    return { fehler: `„${z}": bitte einen bestimmten Ordner (…\\Hersteller\\*) oder eine Datei angeben` };
  }
  return { regel: { art: 'pfad', pfad: `%PROGRAMFILES%\\${rest}` } };
}

/** Mehrzeiliger Text → { regeln, fehler[] }. */
function freigabenLesen(text) {
  const regeln = [];
  const fehler = [];
  const zeilen = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (zeilen.length > MAX_FREIGABEN) fehler.push(`Höchstens ${MAX_FREIGABEN} Zeilen`);
  for (const zeile of zeilen.slice(0, MAX_FREIGABEN)) {
    const r = freigabeLesen(zeile);
    if (r.fehler) fehler.push(r.fehler);
    else if (r.regel) regeln.push(r.regel);
  }
  return { regeln, fehler };
}

/** Vorgabe für alle (aus der Datenbank) prüfen und auffüllen. */
function vorgabeNormal(v) {
  const roh = v && typeof v === 'object' ? v : {};
  return {
    programme: Array.isArray(roh.programme) ? roh.programme.filter((id) => NACH_ID.has(id) && !NACH_ID.get(id).pflicht) : STANDARD,
    freigaben: typeof roh.freigaben === 'string' ? roh.freigaben : '',
    modus: MODI.includes(roh.modus) ? roh.modus : 'probe',
  };
}

/** Eingabe aus der Verwaltung prüfen. Gibt { wert } oder { fehler }. */
function vorgabePruefen(eingang) {
  const e = eingang && typeof eingang === 'object' ? eingang : {};
  if (!Array.isArray(e.programme)) return { fehler: 'programme muss eine Liste sein' };
  const unbekannt = e.programme.filter((id) => !NACH_ID.has(id));
  if (unbekannt.length) return { fehler: `Unbekannte Programme: ${unbekannt.join(', ')}` };
  if (e.modus !== undefined && !MODI.includes(e.modus)) return { fehler: `Unbekannter Modus '${e.modus}'` };
  const { fehler } = freigabenLesen(e.freigaben);
  if (fehler.length) return { fehler: fehler.join('; ') };
  return { wert: vorgabeNormal({ ...e, freigaben: String(e.freigaben || '') }) };
}

/** Der Zweig je Rechner: overrides.roles.windows.programme. */
function rechnerPruefen(zweig) {
  if (zweig === null || zweig === undefined) return {};
  if (typeof zweig !== 'object' || Array.isArray(zweig)) return { fehler: 'programme muss ein Objekt sein' };
  if (zweig.zusatz !== undefined && zweig.zusatz !== null) {
    if (!Array.isArray(zweig.zusatz)) return { fehler: 'programme.zusatz muss eine Liste sein' };
    const unbekannt = zweig.zusatz.filter((id) => !NACH_ID.has(id));
    if (unbekannt.length) return { fehler: `Unbekannte Programme: ${unbekannt.join(', ')}` };
  }
  if (zweig.modus !== undefined && zweig.modus !== null && !MODI.includes(zweig.modus)) {
    return { fehler: `Unbekannter Modus '${zweig.modus}'` };
  }
  if (zweig.freigaben !== undefined && zweig.freigaben !== null) {
    const { fehler } = freigabenLesen(zweig.freigaben);
    if (fehler.length) return { fehler: fehler.join('; ') };
  }
  return {};
}

/**
 * Was ein Rechner bekommt: Pflicht + Vorgabe + eigene Zusätze, mit Regeln.
 * `rechner` ist der Zweig overrides.roles.windows.programme (oder leer).
 */
function fuerRechner(vorgabe, rechner) {
  const v = vorgabeNormal(vorgabe);
  const r = rechner && typeof rechner === 'object' ? rechner : {};
  const ids = new Set([
    ...KATALOG.filter((p) => p.pflicht).map((p) => p.id),
    ...v.programme,
    ...(Array.isArray(r.zusatz) ? r.zusatz.filter((id) => NACH_ID.has(id)) : []),
  ]);
  const programme = KATALOG.filter((p) => ids.has(p.id))
    .map(({ id, name, regeln }) => ({ id, name, regeln }));
  // Gespeicherte Freigaben wurden beim Speichern geprüft; ungültige Zeilen
  // (etwa nach einer verschärften Regel) fallen hier still weg statt den
  // ganzen Rechner ohne Liste zu lassen.
  const freigaben = [
    ...freigabenLesen(v.freigaben).regeln,
    ...freigabenLesen(r.freigaben).regeln,
  ];
  const modus = MODI.includes(r.modus) ? r.modus : v.modus;
  const sperren = SPERREN.map(({ id, name, regeln }) => ({ id, name, regeln }));
  return { modus, programme, freigaben, sperren };
}

module.exports = {
  KATALOG, SPERREN, MODI, STANDARD,
  freigabeLesen, freigabenLesen, vorgabeNormal, vorgabePruefen, rechnerPruefen, fuerRechner,
};
