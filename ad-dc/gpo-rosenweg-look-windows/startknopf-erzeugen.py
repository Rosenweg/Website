#!/usr/bin/env python3
"""Erzeugt bilder/startknopf.png, den Start-Knopf fuer Open-Shell, aus bilder/logo.png.

Open-Shell erwartet fuer einen eigenen Start-Knopf EIN Bild mit drei gleich
hohen Zustaenden untereinander: normal, darueber (hover), gedrueckt
(Src/StartMenu/StartMenuDLL/StartButton.cpp: Hoehe / 3). PNG mit Transparenz
geht, weil Open-Shell das Bild ueber WIC laedt.

Masse (26.11.2026 auf win11-1 bei 100 % ausgemessen, UI Automation, Fenster
der Taskleiste, Bildschirmfoto): Open-Shell legt seinen Knopf unter Windows 11
nur UEBER den Start-Knopf von Windows (an dessen linke Kante, das versteckte
Fenster "Start"), versteckt ihn aber nicht. Wo unser Bild durchsichtig ist,
schaut das Windows-Symbol durch - in der ersten Fassung (48x48, Wappen mittig
bei x=24) als blauer Rand rechts neben dem Wappen.
  - Taskleiste links (so gewollt, TaskbarAl=0): Windows-Knopf 55x48, weil
    links 10 px Rand dazukommen; das Symbol (23x23) sitzt bei x=21..43,
    y=13..35, Mitte (32 | 24).
  - Bei zentrierter Taskleiste waere der Knopf 45 breit und das Symbol 10 px
    weiter links - dafuer passt dieses Bild NICHT.
Darum 56x48 je Zustand (deckt den ganzen Windows-Knopf samt Klickflaeche,
ohne in die Programm-Symbole zu ragen, die bei x=57 beginnen) und das Wappen
(rund, innen deckend) mit 40 px Durchmesser genau ueber dem Symbol, Mitte
(32 | 24): die Ecken des Symbols liegen 15,6 px von der Mitte, also sicher
innerhalb des Wappens (20 px). Gezeichnet in dreifacher Groesse (168x144 je
Zustand): rosenweg-look.ps1 setzt StartButtonSize=56, Open-Shell rechnet das
mit der Anzeige-Skalierung hoch und verkleinert dafuer aus dem Quellbild - so
bleibt der Knopf bis 300 % scharf. Der Windows-Knopf waechst im selben
Verhaeltnis mit (bei 125 % 69 px, Symbolmitte 40).

Aufruf (braucht Pillow):  python3 startknopf-erzeugen.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

HIER = Path(__file__).resolve().parent
QUELLE = HIER / 'bilder' / 'logo.png'
ZIEL = HIER / 'bilder' / 'startknopf.png'

F = 3                       # Zeichenfaktor (siehe oben)
BREITE, HOEHE = 56 * F, 48 * F  # ein Zustand
MITTE = (32 * F, 24 * F)    # Mitte des Windows-Start-Symbols
LOGO = 40 * F               # Durchmesser normal/hover
LOGO_GEDRUECKT = 38 * F     # gedrueckt etwas kleiner - "gibt nach" wie bei Windows 11;
                            # deckt das Symbol noch (15,6 px < 19 px)
FLAECHE = (10 * F, 2 * F, 54 * F - 1, 46 * F - 1)  # Hover-Flaeche, mittig um das Wappen
RADIUS = 5 * F
# Grau mit wenig Deckkraft: sichtbar auf heller wie auf dunkler Taskleiste.
# Die Taskleiste folgt dem hellen/dunklen Modus, eine feste Farbe saehe in
# einem der beiden falsch aus.
HOVER = (128, 128, 128, 70)
GEDRUECKT = (128, 128, 128, 45)


def logo(groesse):
    src = Image.open(QUELLE).convert('RGBA')
    f = groesse / max(src.size)
    return src.resize((round(src.width * f), round(src.height * f)), Image.LANCZOS)


def zustand(hintergrund, logogroesse):
    bild = Image.new('RGBA', (BREITE, HOEHE), (0, 0, 0, 0))
    if hintergrund:
        ImageDraw.Draw(bild).rounded_rectangle(FLAECHE, RADIUS, fill=hintergrund)
    l = logo(logogroesse)
    bild.alpha_composite(l, (MITTE[0] - l.width // 2, MITTE[1] - l.height // 2))
    return bild


def main():
    streifen = Image.new('RGBA', (BREITE, 3 * HOEHE), (0, 0, 0, 0))
    for i, z in enumerate([zustand(None, LOGO), zustand(HOVER, LOGO), zustand(GEDRUECKT, LOGO_GEDRUECKT)]):
        streifen.alpha_composite(z, (0, i * HOEHE))
    streifen.save(ZIEL, optimize=True)
    print(f'{ZIEL} ({streifen.width}x{streifen.height})')


if __name__ == '__main__':
    main()
