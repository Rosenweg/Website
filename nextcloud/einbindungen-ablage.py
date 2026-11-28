#!/usr/bin/env python3
"""Nextcloud-Einbindungen der STWEG-Ordner nach der Fileserver-Regel setzen.

Laeuft auf CT 104 (Nextcloud) als root, von Hand oder per Timer
(einbindungen-ablage.timer, stuendlich). Idempotent: aendert nur, was vom
Soll abweicht.

    einbindungen-ablage.py [--trocken]

Soll je STWEG (gleiche Regel wie fileserver-lxc/ordnerrechte/tabelle.txt und
api/lib/dok-stweg-sicht.js, Entscheid Stefan 28.11.2026):

  /stwegN           rw  <- Ausschuss der STWEG, technik, Präsident
  /stwegN           ro  <- Eigentuemer der STWEG, Verwaltung der STWEG,
                           verwaltung (Uebergang)
  /stwegN-bewohner  ro  -> nur stwegN/bewohner <- Bewohner der STWEG

Ein Mieter sieht also nur /stwegN-bewohner, ein Eigentuemer, der selbst
bewohnt, sieht beides. Die Bewohner-Einbindung braucht einen EIGENEN
Einbindungspunkt: Nextcloud 33 beachtet die Prioritaet beim Einbinden nicht
(ConfigAdapter nimmt getAllStoragesForUser, nicht getUniqueStorages). Bei
gleichem Punkt gewinnt eine beliebige Einbindung, im Test am 28.11.2026 die
Bewohner-Einbindung, und ein selbst bewohnender Eigentuemer saehe nur noch
bewohner/.

Gruppen, die es in der Nextcloud (noch) nicht gibt, werden uebersprungen. Die
Nextcloud legt eine Gruppe aus Authentik (user_oidc) erst an, wenn sich ein
Mitglied zum ersten Mal anmeldet. Der stuendliche Lauf traegt sie danach von
selbst nach (z. B. stwegN-verwaltung, meg-bewohner).

Sicherheit: Eine Einbindung ohne Gruppen und Konten gilt in der Nextcloud fuer
ALLE. Das Skript fuegt deshalb zuerst hinzu und entfernt danach, legt keine
Einbindung ohne vorhandene Gruppe an und bricht ab, bevor es einer Einbindung
die letzte Gruppe nimmt.
"""
import json
import subprocess
import sys

OCC = ['sudo', '-u', 'www-data', 'php', '/var/www/nextcloud/occ']
BASIS = '/mnt/cephfs-docs'
ADMIN = ['technik', 'Präsident']
UEBERGANG_VERWALTUNG = 'verwaltung'  # ÜBERGANG, siehe api/lib/groups.js

# Ordner -> (Praefix der Bewohner-/Eigentuemergruppen, Ausschuss, Verwaltung)
STWEGS = {
    'stweg1': ('stweg1', 'stweg1-ausschuss', 'stweg1-verwaltung'),
    'stweg2': ('stweg2', 'stweg2-ausschuss', 'stweg2-verwaltung'),
    'stweg3': ('r9', 'stweg3-ausschuss', 'stweg3-verwaltung'),
    'stweg4': ('stweg4', 'stweg4-ausschuss', 'stweg4-verwaltung'),
    'stweg5': ('stweg5', 'stweg5-ausschuss', 'stweg5-verwaltung'),
    'stweg6': ('r1', 'stweg6-ausschuss', 'stweg6-verwaltung'),
    'stweg7': ('stweg7', 'stweg7-ausschuss', 'stweg7-verwaltung'),
    'meg': ('meg', 'meg-ausschuss', 'meg-verwaltung'),
}

TROCKEN = '--trocken' in sys.argv[1:]


def occ(*args, json_out=False):
    cmd = OCC + list(args) + (['--output=json'] if json_out else [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"occ {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout) if json_out else r.stdout


def tun(beschreibung, *args):
    print(('  [trocken] ' if TROCKEN else '  ') + beschreibung)
    if not TROCKEN:
        occ(*args)


def main():
    gruppen = set(occ('group:list', json_out=True).keys())
    einb = occ('files_external:list', json_out=True)
    fehlend = set()

    def vorhanden(liste):
        fehlend.update(g for g in liste if g not in gruppen)
        return [g for g in liste if g in gruppen]

    def finde(punkt, datadir, ro):
        for m in einb:
            ist_ro = str(m.get('options', {}).get('readonly')).lower() in ('true', '1')
            if m['mount_point'] == punkt and m['configuration'].get('datadir') == datadir and ist_ro == ro:
                return m
        return None

    for ordner, (pre, ausschuss, verw) in STWEGS.items():
        punkt = '/' + ordner
        soll = [
            ('rw', punkt, f'{BASIS}/{ordner}', False, vorhanden([ausschuss] + ADMIN)),
            ('ro', punkt, f'{BASIS}/{ordner}', True, vorhanden([f'{pre}-eigentuemer', verw, UEBERGANG_VERWALTUNG])),
            ('bewohner', punkt + '-bewohner', f'{BASIS}/{ordner}/bewohner', True, vorhanden([f'{pre}-bewohner'])),
        ]
        print(f'{punkt}')
        for art, punkt, datadir, ro, gr in soll:
            m = finde(punkt, datadir, ro)
            if m is None:
                if not gr:
                    print(f'  {art}: keine der Gruppen vorhanden, nicht angelegt')
                    continue
                if TROCKEN:
                    print(f'  [trocken] anlegen {art} {datadir} <- {",".join(gr)}')
                    continue
                # In einem Schritt mit Gruppen anlegen (Import): mit create und
                # danach applicable gaebe es einen Moment ohne Gruppe = fuer alle.
                opts = {'enable_sharing': True, 'filesystem_check_changes': '1'}
                if ro:
                    opts['readonly'] = True
                neu = [{'mount_point': punkt, 'storage': '\\OC\\Files\\Storage\\Local',
                        'authentication_type': 'null::null', 'configuration': {'datadir': datadir},
                        'options': opts, 'applicable_users': [], 'applicable_groups': gr}]
                r = subprocess.run(OCC + ['files_external:import', '-'],
                                   input=json.dumps(neu), capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(f'import {datadir}: {r.stderr.strip() or r.stdout.strip()}')
                # Der Import nennt die neue Nummer nicht: neu einlesen und suchen.
                einb[:] = occ('files_external:list', json_out=True)
                m = finde(punkt, datadir, ro)
                if m is None:
                    raise RuntimeError(f'import {datadir}: Einbindung danach nicht gefunden')
                mid = m['mount_id']
                print(f'  [{mid}] angelegt {art} {datadir} <- {",".join(gr)}')
                continue
            mid = m['mount_id']
            ist = list(m.get('applicable_groups') or [])
            if m.get('applicable_users'):
                print(f'  [{mid}] WARNUNG: gilt auch fuer Konten {m["applicable_users"]} - nicht angefasst')
            for g in gr:
                if g not in ist:
                    tun(f'[{mid}] + {g}', 'files_external:applicable', str(mid), '--add-group', g)
            weg = [g for g in ist if g not in gr]
            if weg and not gr:
                raise SystemExit(f'[{mid}] haette keine Gruppe mehr (gilt dann fuer alle) - Abbruch')
            for g in weg:
                tun(f'[{mid}] - {g}', 'files_external:applicable', str(mid), '--remove-group', g)
            opt = m.get('options', {})
            if str(opt.get('filesystem_check_changes')) != '1':
                tun(f'[{mid}] filesystem_check_changes=1', 'files_external:option', str(mid), 'filesystem_check_changes', '1')
    if fehlend:
        print('In der Nextcloud (noch) nicht vorhanden, uebersprungen: ' + ', '.join(sorted(fehlend)))


if __name__ == '__main__':
    main()
