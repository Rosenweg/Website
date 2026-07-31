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
    controller: '100.64.2.30',
    allow_groups: ['rosenweg'],
    admin_groups: ['technik'],
  },
  admin: { user: 'rwadmin', ssh_enabled: false, ssh_from: '100.64.0.0/16' },
  security: { block_usb_storage: true, lock_bootloader: true, desktop_lockdown: 'normal' },
  mqtt: { host: '100.64.2.51', port: 1883, tls: false, status_topic_prefix: 'stations' },
  agent: {
    status_enabled: true,
    status_interval_seconds: 300,
    log_push_enabled: false,
    log_push_interval_minutes: 60,
    log_keep_days: 30,
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
    look: {
      gtk_theme: 'Mint-Y-Blue',
      icon_theme: 'Mint-Y',
      font: 'Ubuntu 10',
      mint_themes_version: '2.4.0',
      mint_icons_version: '1.9.2',
    },
    home: { server: '100.64.2.28', share: 'homes', roaming_profile: true, roaming_interval_minutes: 10 },
    shares: ['dokumente', 'scans'],
    printing: { enabled: true },
    scanning: { enabled: true, target_dir: '~/scans' },
    flatpaks: ['org.linphone.Linphone'],
  },
  display: {
    url: 'https://display.rosenweg4303.ch',
    allowed_domains: ['display.rosenweg4303.ch'],
    reload_interval_minutes: 30,
    screen_schedule: { on: '06:00', off: '23:00' },
  },
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
  const cfg = merge(merge(DEFAULTS, secrets()), {
    station: {
      id: station.id,
      hostname: station.hostname || station.id,
      role,
      standort: station.standort || '',
      notiz: station.notiz || '',
    },
    roles: { [role]: ROLE_DEFAULTS[role] || {} },
  });
  return merge(cfg, station.overrides || {});
}

module.exports = { STATION_TYPES, buildConfig, missingSecrets, merge };
