<?php
// php zpush/test_sicht.php — welches Verzeichnis bekommt ein Konto (Befund F1-7)?
require __DIR__ . '/sicht.php';

$fehler = 0;
function gleich($ist, $soll, $was) {
    global $fehler;
    if ($ist !== $soll) { $fehler++; fwrite(STDERR, "FEHLER $was: " . var_export($ist, true) . ' statt ' . var_export($soll, true) . "\n"); }
}

// alle
gleich(rw_sicht_schluessel(array('Technik')), 'alle', 'Technik');
gleich(rw_sicht_schluessel(array('Präsident')), 'alle', 'Praesident');
gleich(rw_sicht_schluessel(array('stweg2-ausschuss')), 'alle', 'Ausschuss');
gleich(rw_sicht_schluessel(array('meg-ausschuss')), 'alle', 'MEG-Ausschuss');
gleich(rw_sicht_schluessel(array('wohnungsverwaltung')), 'alle', 'wohnungsverwaltung');
gleich(rw_sicht_schluessel(array('Verwaltung')), 'alle', 'Übergang Verwaltung');
gleich(rw_sicht_schluessel(array_values(RW_VERWALTUNG)), 'alle', 'Verwaltung aller STWEGs');
// eigene STWEG(s)
gleich(rw_sicht_schluessel(array('r9-bewohner')), 's3', 'Bewohner Haus 9');
gleich(rw_sicht_schluessel(array('stweg5-eigentuemer', 'r9-eigentuemer')), 's3-5', 'zwei STWEGs');
gleich(rw_sicht_schluessel(array('stweg3-verwaltung')), 's3', 'Verwaltung STWEG 3');
gleich(rw_sicht_schluessel(array('meg-bewohner')), 's8', 'MEG');
// kein Treffer: nie alle
gleich(rw_sicht_schluessel(array()), 'keine', 'ohne Gruppen');
gleich(rw_sicht_schluessel(array('authentik admins', 'ad-benutzer')), 'keine', 'fremde Gruppen');
gleich(rw_sicht_schluessel(array('bewohner', 'eigentuemer')), 'keine', 'nur Elterngruppen');
gleich(rw_sicht_schluessel(array_slice(array_values(RW_VERWALTUNG), 0, 7)), 's1-2-3-4-5-6-7', 'sieben Verwaltungen');

// Sammlungen
gleich(rw_sicht_sammlungen('alle'), array('alle'), 'Sammlung alle');
gleich(rw_sicht_sammlungen('keine'), array('keine'), 'Sammlung keine');
gleich(rw_sicht_sammlungen('s3-5'), array('keine', 's3', 's5'), 'Sammlung s3-5');
gleich(rw_sicht_sammlungen('../alle'), array('keine'), 'Pfad-Trick');
gleich(rw_sicht_sammlungen('s9'), array('keine'), 'unbekannte STWEG');

// DN -> Gruppenname
gleich(rw_dn_cn('cn=r9-bewohner,ou=groups,dc=rosenweg4303,dc=ch'), 'r9-bewohner', 'DN');
gleich(rw_dn_cn('cn=Pr\\c3\\a4sident,ou=groups,dc=rosenweg4303,dc=ch'), 'präsident', 'DN mit Umlaut');
gleich(rw_dn_cn('CN=Technik,ou=groups,dc=x'), 'technik', 'DN gross');
gleich(rw_dn_cn('ou=groups'), null, 'kein cn');

if ($fehler) { fwrite(STDERR, "$fehler Fehler\n"); exit(1); }
echo "ok\n";
