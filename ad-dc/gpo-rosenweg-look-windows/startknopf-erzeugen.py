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
schaut das Windows-Symbol durch - in der ersten Fassung als blauer Rand
rechts neben dem Wappen.
  - Taskleiste zentriert (so will es Stefan): Windows-Knopf 45x48, Symbol
    (23x23) in dessen Mitte, also bei x = 22,5 vom linken Rand.
  - Taskleiste links: Knopf 55x48, weil 10 px Rand links dazukommen - das
    Symbol sitzt dann bei x = 32. Dafuer passt dieses Bild NICHT.
Darum 48x48 je Zustand und das Wappen (rund, innen deckend) mit 40 px
Durchmesser genau ueber dem Symbol, Mitte (22,5 | 24): die Ecken des Symbols
liegen 16,3 px von der Mitte, also sicher innerhalb des Wappens (20 px).
Gezeichnet in dreifacher Groesse (144x144 je Zustand): rosenweg-look.ps1 setzt
StartButtonSize=48, Open-Shell rechnet das mit der Anzeige-Skalierung hoch
und verkleinert dafuer aus dem Quellbild - so bleibt der Knopf bis 300 %
scharf. Der Windows-Knopf waechst im selben Verhaeltnis mit.

Aufruf (braucht Pillow):  python3 startknopf-erzeugen.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

HIER = Path(__file__).resolve().parent
QUELLE = HIER / 'bilder' / 'logo.png'
ZIEL = HIER / 'bilder' / 'startknopf.png'

F = 3                       # Zeichenfaktor (siehe oben)
BREITE, HOEHE = 48 * F, 48 * F  # ein Zustand
MITTE = (68, 72)            # = (22,5 | 24) * 3, auf ganze Pixel
LOGO = 40 * F               # Durchmesser normal/hover
LOGO_GEDRUECKT = 38 * F     # gedrueckt etwas kleiner - "gibt nach" wie bei Windows 11;
                            # deckt das Symbol noch (16,3 px < 19 px)
FLAECHE = (2, 6, 133, 137)  # Hover-Flaeche um das Wappen, symmetrisch zur Mitte
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
