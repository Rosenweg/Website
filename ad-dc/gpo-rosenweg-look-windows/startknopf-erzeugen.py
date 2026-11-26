#!/usr/bin/env python3
"""Erzeugt bilder/startknopf.png, den Start-Knopf fuer Open-Shell, aus bilder/logo.png.

Open-Shell erwartet fuer einen eigenen Start-Knopf EIN Bild mit drei gleich
hohen Zustaenden untereinander: normal, darueber (hover), gedrueckt
(Src/StartMenu/StartMenuDLL/StartButton.cpp: Hoehe / 3). PNG mit Transparenz
geht, weil Open-Shell das Bild ueber WIC laedt.

Warum 144 px je Zustand: rosenweg-look.ps1 setzt StartButtonSize=48 (Breite bei
100 %, so hoch wie die Windows-11-Taskleiste). Open-Shell rechnet das mit der
Bildschirm-Skalierung hoch (ScaleForDpi) und verkleinert dafuer aus dem
Quellbild - mit 144 px bleibt der Knopf bis 300 % scharf, statt aus 48 px
aufgeblasen zu werden.

Aufruf (braucht Pillow):  python3 startknopf-erzeugen.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

HIER = Path(__file__).resolve().parent
QUELLE = HIER / 'bilder' / 'logo.png'
ZIEL = HIER / 'bilder' / 'startknopf.png'

PX = 144            # ein Zustand, quadratisch
LOGO = 108          # Logo normal/hover: ~36 px bei 100 %, wie ein Taskleisten-Symbol
LOGO_GEDRUECKT = 98  # gedrueckt etwas kleiner - so "gibt der Knopf nach" wie bei Windows 11
RAND = 10           # Abstand der Hover-Flaeche zum Rand
RADIUS = 14
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
    bild = Image.new('RGBA', (PX, PX), (0, 0, 0, 0))
    if hintergrund:
        ImageDraw.Draw(bild).rounded_rectangle(
            (RAND, RAND, PX - 1 - RAND, PX - 1 - RAND), RADIUS, fill=hintergrund)
    l = logo(logogroesse)
    bild.alpha_composite(l, ((PX - l.width) // 2, (PX - l.height) // 2))
    return bild


def main():
    streifen = Image.new('RGBA', (PX, 3 * PX), (0, 0, 0, 0))
    for i, z in enumerate([zustand(None, LOGO), zustand(HOVER, LOGO), zustand(GEDRUECKT, LOGO_GEDRUECKT)]):
        streifen.alpha_composite(z, (0, i * PX))
    streifen.save(ZIEL, optimize=True)
    print(f'{ZIEL} ({streifen.width}x{streifen.height})')


if __name__ == '__main__':
    main()
