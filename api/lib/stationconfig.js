// Konfiguration einer Station zusammenbauen.
//
// Ersetzt das frühere private Config-Repo `Rosenweg/stationen-config`. Die
// Vorlagen stehen hier im Klartext; alles Geheime (AD-Beitrittskonto,
// MQTT-Zugang, root-Hash, SSH-Keys) kommt aus der Umgebung der API und
// landet damit weder in einem Repo noch auf einem Installationsmedium.
const STATION_TYPES = [
  {
    id: 'desktop',
    label: 'Arbeitsplatz',
    description: 'Mit Anmeldung — Dateien, Scannen, Drucken, Telefonie.',
  },
  {
    id: 'display',
    label: 'Anzeige',
    description: 'Digital Signage, kein Login, 24/7.',
  },
];

const DEFAULTS = {
  system: {
    timezone: 'Europe/Zurich',
    locale: 'de_CH.UTF-8',
    keymap: 'ch',
    volatile_root: { enabled: true, persist_label: 'STATIONPERSIST' },
  },
  domain: {
    enabled: true,
    realm: 'AD.ROSENWEG4303.CH',
    workgroup: 'ROSENWEG',
    // Ein NAME, keine IP — dieselbe Falle wie bei home.server. Kerberos kennt
    // Dienste nur unter ihrem Namen: zu '100.64.2.30' gibt es kein 'ldap/…',
    // und der KDC antwortet mit "Server not found in Kerberos database". Mit
    // der IP scheiterte am 3. August das Auslesen des Benutzerbilds aus dem AD.
    // Der Wert speist krb5.conf (kdc, admin_server), dort ist ein Name ebenso
    // richtig.
    controller: 'dc1.ad.rosenweg4303.ch',
    // Rechnerkonten landen in einer eigenen OU. Das Beitrittskonto hat auch
    // nur dort Rechte — es ist ausdrücklich kein Domänenadministrator.
    computer_ou: 'OU=Stationen,DC=ad,DC=rosenweg4303,DC=ch',
    allow_groups: ['rosenweg'],
    admin_groups: ['technik'],
  },
  admin: { user: 'rwadmin', ssh_enabled: false, ssh_from: '100.64.0.0/16' },
  security: { block_usb_storage: true, lock_bootloader: true, desktop_lockdown: 'normal' },
  mqtt: { host: '100.64.2.51', port: 1883, tls: false, status_topic_prefix: 'stations' },
  agent: {
    status_enabled: true,
    status_interval_seconds: 300,
    // Logs schiebt die Station an POST /api/stations/:id/logs — mit ihrem
    // eigenen Token, ohne Deploy-Key. Der frühere Weg über git ins private
    // Config-Repo ist mit dem Repo entfallen.
    log_push_enabled: true,
    log_push_interval_minutes: 60,
    // Wie lange die API die Einsendungen aufhebt. Es geht ums Nachsehen, wenn
    // etwas schiefging, nicht um ein Archiv.
    log_keep_days: 14,
  },
  updates: {
    auto_update: true,
    channel: 'main',
    window: '03:30',
    unattended_upgrades: true,
    auto_reboot: true,
    reboot_time: '04:30',
  },
};

const ROLE_DEFAULTS = {
  desktop: {
    environment: 'auto',
    web_url: 'https://www.rosenweg4303.ch',
    screen_lock_seconds: 300,
    inactivity_timeout_seconds: 900,
    // Spaetestens nach einem Tag ohne jede Eingabe wird abgemeldet — auch am
    // Sperrbildschirm. Sonst bleibt eine Sitzung uebers Wochenende stehen:
    // Shares eingehaengt, Roaming-Profil in der Schwebe, und ein naechtlicher
    // Update-Neustart traefe sie offen an. 0 schaltet es ab.
    session_idle_logout_seconds: 86400,
    // Leerlaufanzeige: dieselbe Seite wie auf den Anzeigestationen als
    // Bildschirmschoner. Standardmässig aus — im Sitzungszimmer oder im
    // Eingang sinnvoll, im Büro der Verwaltung eher störend. Sie ersetzt die
    // Sperre nicht, sondern kommt davor; deshalb muss nach_sekunden kleiner
    // sein als screen_lock_seconds, sonst zieht die Station sie selbst vor.
    leerlauf_anzeige: {
      enabled: false,
      url: 'https://display.rosenweg4303.ch',
      nach_sekunden: 120,
    },
    look: {
      gtk_theme: 'Mint-Y-Blue',
      icon_theme: 'Mint-Y',
      // Keine feste Schrift: fonts-ubuntu gibt es in Trixie nicht mehr. Ohne
      // Angabe wählt die Station selbst, was tatsächlich installiert ist.
      mint_themes_version: '2.4.0',
      mint_icons_version: '1.9.2',
    },
    // Ein NAME, keine IP: die Freigaben werden mit sec=krb5 eingehaengt, und
    // Kerberos kennt Dienste nur unter ihrem Namen. Mit '100.64.2.28' quittierte
    // der KDC jede Anfrage mit KRB5KDC_ERR_S_PRINCIPAL_UNKNOWN — pam_mount
    // scheiterte beim Anmelden, und dokumente/scans blieben leere Ordner.
    // server_ip ist nur die Rueckfallebene, solange der DNS-Eintrag fehlt.
    home: {
      server: 'fileserver.ad.rosenweg4303.ch',
      server_ip: '100.64.2.28',
      // 'home', nicht 'homes': so heisst die Freigabe auf dem Fileserver
      // (/mnt/cephfs-userdata/home, darunter je ein Ordner pro Benutzer). Mit
      // 'homes' zeigte die Einhaengung ins Leere und das Home blieb lokal.
      share: 'home',
      roaming_profile: true,
      roaming_interval_minutes: 10,
    },
    // 'scans' steht hier bewusst NICHT: die Freigabe auf CT 106 hat
    // 'valid users = ROSENWEG\scanner' und gehoert damit einem einzigen Konto.
    // Als Vorgabe scheiterte bei JEDER Anmeldung eine Einhaengung und
    // hinterliess einen Fehler im Protokoll, ohne dass jemand etwas davon hatte.
    shares: ['dokumente'],
    printing: { enabled: true },
    // Zielordner im Home, nicht auf der Scans-Freigabe. Das Home liegt ohnehin
    // auf dem Fileserver — die Scans landen also dort, wo die Person sie an
    // jeder Station wiederfindet.
    scanning: { enabled: true, target_dir: '~/scans' },
    // OnlyOffice als Flatpak: rund 800 MB pro Station, dafür auf jeder
    // Station dieselbe Version — und die Dokumente auf den Shares lassen
    // sich ohne Umweg über den Browser öffnen.
    flatpaks: ['org.onlyoffice.desktopeditors'],
  },
  display: {
    url: 'https://display.rosenweg4303.ch',
    allowed_domains: ['display.rosenweg4303.ch'],
    reload_interval_minutes: 30,
    screen_schedule: { on: '06:00', off: '23:00' },
  },
};

// Was je Rolle von den Vorgaben abweicht.
const ROLE_OVERRIDES = {
  // Eine Anzeige hat keinen Anmeldebildschirm — sie braucht die Domäne
  // nicht. Der Beitritt wäre ein Rechnerkonto und ein Fehlerpunkt ohne
  // Gegenwert, und er würde die Einrichtung abbrechen, wenn der DC gerade
  // nicht erreichbar ist.
  display: { domain: { enabled: false } },
};

// Tiefes Zusammenführen: spätere Objekte gewinnen, Arrays werden ersetzt.
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v);
  return out;
}

function envList(name) {
  return (process.env[name] || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Die Geheimnisse, die eine Station braucht — ausschliesslich aus der Umgebung. */
function secrets() {
  return {
    system: { root_password_hash: process.env.STATION_ROOT_PASSWORD_HASH || '' },
    domain: {
      join_user: process.env.STATION_AD_JOIN_USER || '',
      join_password: process.env.STATION_AD_JOIN_PASSWORD || '',
    },
    admin: {
      ssh_enabled: envList('STATION_ADMIN_SSH_KEYS').length > 0,
      ssh_authorized_keys: envList('STATION_ADMIN_SSH_KEYS'),
    },
    mqtt: {
      username: process.env.STATION_MQTT_USER || '',
      password: process.env.STATION_MQTT_PASSWORD || '',
    },
  };
}

/** Fehlt etwas, das die Station zwingend braucht? Namen der Felder zurückgeben. */
function missingSecrets() {
  const need = {
    STATION_ROOT_PASSWORD_HASH: process.env.STATION_ROOT_PASSWORD_HASH,
    STATION_AD_JOIN_USER: process.env.STATION_AD_JOIN_USER,
    STATION_AD_JOIN_PASSWORD: process.env.STATION_AD_JOIN_PASSWORD,
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}

/**
 * station.json für eine registrierte Station bauen.
 * @param {{id,role,hostname,standort,notiz,overrides}} station Zeile aus der DB
 */
function buildConfig(station) {
  const role = station.role;
  const cfg = merge(merge(merge(DEFAULTS, ROLE_OVERRIDES[role] || {}), secrets()), {
    station: {
      id: station.id,
      hostname: station.hostname || station.id,
      role,
      standort: station.standort || '',
      notiz: station.notiz || '',
      // Wer die Station aufgesetzt hat. Die Station braucht das selbst: nur
      // diese Person und die Technik dürfen dort auf den vollen Desktop
      // umschalten (station-desktop-modus).
      eingerichtet_von: station.registered_by || '',
    },
    roles: { [role]: ROLE_DEFAULTS[role] || {} },
  });
  return merge(cfg, station.overrides || {});
}

module.exports = { STATION_TYPES, buildConfig, missingSecrets, merge };
