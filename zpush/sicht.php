<?php
// Rosenweg: welches Verzeichnis bekommt ein Konto aufs Handy (Befund F1-7)?
// Dieselbe Regel wie das Portal-Telefonbuch (api/server.js GET /api/telefonbuch):
//
//   alle   Technik, Praesident, Ausschuss irgendeiner STWEG, eine Verwaltung
//          aller STWEGs (alle acht stwegN-/meg-verwaltung oder Übergangsgruppe
//          „Verwaltung“), wohnungsverwaltung, bewohner-verwaltung
//   sN-M   sonst die Personen der eigenen STWEG(s) (Bewohner-, Eigentuemer-,
//          Ausschussgruppe) und der verwalteten STWEG(s), dazu die Verwaltungen
//   keine  kein Treffer: nur Verwaltungen und die Telefonzentrale, NIE „alle“
//
// Gruppennamen wie api/lib/groups.js (STWEG_GROUPS, VERWALTUNG_GROUPS). Ein
// Test (api/test/zpush-sicht.test.js) vergleicht beide Listen.
// Reine Funktionen ohne Z-Push-Bezug: im Container als
// backend/rosenweg/sicht.php neben rosenweg.php, Test: php zpush/test_sicht.php.

const RW_STWEG_GRUPPEN = array(
    1 => array('stweg1-bewohner', 'stweg1-eigentuemer', 'stweg1-ausschuss'),
    2 => array('stweg2-bewohner', 'stweg2-eigentuemer', 'stweg2-ausschuss'),
    3 => array('r9-bewohner', 'r9-eigentuemer', 'stweg3-ausschuss'),
    4 => array('stweg4-bewohner', 'stweg4-eigentuemer', 'stweg4-ausschuss'),
    5 => array('stweg5-bewohner', 'stweg5-eigentuemer', 'stweg5-ausschuss'),
    6 => array('r1-bewohner', 'r1-eigentuemer', 'stweg6-ausschuss'),
    7 => array('stweg7-bewohner', 'stweg7-eigentuemer', 'stweg7-ausschuss'),
    8 => array('meg-bewohner', 'meg-eigentuemer', 'meg-ausschuss'),
);
const RW_AUSSCHUSS = array(
    'stweg1-ausschuss', 'stweg2-ausschuss', 'stweg3-ausschuss', 'stweg4-ausschuss',
    'stweg5-ausschuss', 'stweg6-ausschuss', 'stweg7-ausschuss', 'meg-ausschuss',
);
const RW_VERWALTUNG = array(
    1 => 'stweg1-verwaltung', 2 => 'stweg2-verwaltung', 3 => 'stweg3-verwaltung', 4 => 'stweg4-verwaltung',
    5 => 'stweg5-verwaltung', 6 => 'stweg6-verwaltung', 7 => 'stweg7-verwaltung', 8 => 'meg-verwaltung',
);
// ÜBERGANG wie api/lib/groups.js: alte Gruppe „Verwaltung“ = alle STWEGs
const RW_VERWALTUNG_UEBERGANG = 'verwaltung';
const RW_ALLE_GRUPPEN = array('technik', 'präsident', 'praesident', 'wohnungsverwaltung', 'bewohner-verwaltung');

// Wert des ersten RDN (cn=…) aus einer Gruppen-DN, LDAP-Maskierung (\c3\a4, \,) aufgeloest.
function rw_dn_cn($dn) {
    if (!preg_match('/^\s*cn=((?:[^,\\\\]|\\\\.)+)/i', (string)$dn, $t)) return null;
    $v = preg_replace_callback('/\\\\([0-9a-fA-F]{2})/', function ($m) { return chr(hexdec($m[1])); }, $t[1]);
    $v = preg_replace('/\\\\(.)/', '$1', $v);
    return mb_strtolower(trim($v), 'UTF-8');
}

// Gruppennamen (klein) -> 'alle' | 'keine' | 's3' | 's3-5'
function rw_sicht_schluessel($gruppen) {
    $g = array();
    foreach ((array)$gruppen as $x) { $x = mb_strtolower(trim((string)$x), 'UTF-8'); if ($x !== '') $g[$x] = true; }
    foreach (RW_ALLE_GRUPPEN as $n) if (isset($g[$n])) return 'alle';
    foreach (RW_AUSSCHUSS as $n) if (isset($g[$n])) return 'alle';
    if (isset($g[RW_VERWALTUNG_UEBERGANG])) return 'alle';
    $verwAlle = true;
    foreach (RW_VERWALTUNG as $n) if (!isset($g[$n])) { $verwAlle = false; break; }
    if ($verwAlle) return 'alle';
    $s = array();
    foreach (RW_STWEG_GRUPPEN as $nr => $namen) foreach ($namen as $n) if (isset($g[$n])) $s[$nr] = true;
    foreach (RW_VERWALTUNG as $nr => $n) if (isset($g[$n])) $s[$nr] = true;
    if (!$s) return 'keine';
    $nrn = array_keys($s); sort($nrn);
    return 's' . implode('-', $nrn);
}

// Schluessel -> Sammlungen unter /var/lib/zpush-contacts (von contacts-sync).
// Unbekannter Schluessel -> nur 'keine' (fail closed).
function rw_sicht_sammlungen($schluessel) {
    if ($schluessel === 'alle') return array('alle');
    if (!preg_match('/^s([1-8](?:-[1-8])*)$/', (string)$schluessel, $m)) return array('keine');
    $out = array('keine');
    foreach (explode('-', $m[1]) as $n) $out[] = 's' . $n;
    return $out;
}
