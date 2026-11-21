#!/usr/bin/env python3
"""Erzeugt STWEG-Wappen aus dem STWEG-3-Wappen (logo-stweg3-rosenweg9.png).

Ring oben: «ROSENWEG <Hausnummern>», rotes Band unten: «STWEG <n>» bzw. «MEG».
Optional eine grosse Zahl über dem Bandtext (wie beim STWEG-3-Wappen), sonst "". Turm, Rose und Weg bleiben unverändert.

Aufruf:  python3 scripts/wappen/erzeuge.py <ziel.png> "<Ringtext>" "<Bandzahl>" "<Bandtext>"
Beispiel: python3 scripts/wappen/erzeuge.py logo-stweg2-rosenweg13-14-16.png "ROSENWEG 13/14/16" "" "STWEG 2"
Schrift: Inter ExtraBold (scripts/beispielmappe/.cache/fonts/inter-800.woff2, wird
von der Beispielmappe geladen) – sonst DejaVu Sans Bold.
"""
import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
BASIS = ROOT / 'logo-stweg3-rosenweg9.png'
FONT_KANDIDATEN = [ROOT / 'scripts/beispielmappe/.cache/fonts/inter-800.woff2',
                   Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')]

# Geometrie des Basis-Wappens (909 x 908 px), aus dem Bild ausgemessen.
CX, CY = 454, 454          # Mittelpunkt
R_TEXT_MITTE = 364         # Mitte der Schrift im weissen Ring
RING_INNEN, RING_AUSSEN = 316, 433   # weisser Ring zwischen den schwarzen Linien
WEISS = (250, 249, 247, 255)
ROT = (247, 14, 18, 255)
SCHWARZ = (20, 18, 18, 255)
# Bandtext «STWEG <n>» sitzt bei allen dort, wo im Original «STWEG3» steht (Mitte y=738).
# Textflächen im roten Band, die überdeckt werden («9» und «STWEG3»).
BAND_BOXEN = [(400, 600, 510, 708), (278, 706, 628, 772)]


def schrift(groesse):
    for f in FONT_KANDIDATEN:
        try:
            return ImageFont.truetype(str(f), groesse)
        except Exception:
            continue
    raise SystemExit('Keine Schrift gefunden')


def ring_leeren(img):
    """Weissen Ring oberhalb des Bandes neu weiss malen (alte Ringschrift weg)."""
    d = ImageDraw.Draw(img)
    maske = Image.new('L', img.size, 0)
    md = ImageDraw.Draw(maske)
    md.ellipse((CX - RING_AUSSEN, CY - RING_AUSSEN, CX + RING_AUSSEN, CY + RING_AUSSEN), fill=255)
    md.ellipse((CX - RING_INNEN, CY - RING_INNEN, CX + RING_INNEN, CY + RING_INNEN), fill=0)
    md.rectangle((0, CY + 120, img.width, img.height), fill=0)   # unten: Band nicht anfassen
    weiss = Image.new('RGBA', img.size, WEISS)
    img.paste(weiss, (0, 0), maske)


def bogentext(img, text, groesse, sperrung=0.05):
    """Text oben im Ring entlang des Kreises, zentriert, Buchstaben nach aussen stehend."""
    f = schrift(groesse)
    breiten = [f.getlength(c) for c in text]
    abstand = groesse * sperrung
    gesamt = sum(breiten) + abstand * (len(text) - 1)
    winkel_gesamt = gesamt / R_TEXT_MITTE
    if winkel_gesamt > math.radians(215):
        raise SystemExit(f'Ringtext zu lang ({math.degrees(winkel_gesamt):.0f}°), kleinere Schrift wählen')
    theta = -winkel_gesamt / 2
    asc, desc = f.getmetrics()
    for c, w in zip(text, breiten):
        mitte = theta + (w / 2) / R_TEXT_MITTE
        if c.strip():
            g = Image.new('RGBA', (int(w) + 20, asc + desc + 20), (0, 0, 0, 0))
            gd = ImageDraw.Draw(g)
            # Grossbuchstaben: optische Mitte = halbe Versalhöhe über der Grundlinie
            bbox = f.getbbox('H')
            gd.text((10, 10), c, font=f, fill=SCHWARZ)
            gross = g.rotate(-math.degrees(mitte), resample=Image.BICUBIC, expand=True)
            # Position: Punkt auf dem Kreis; Glyphenmitte (vertikal: Versalmitte) dorthin
            mx = CX + R_TEXT_MITTE * math.sin(mitte)
            my = CY - R_TEXT_MITTE * math.cos(mitte)
            # Versalmitte im ungedrehten Glyph relativ zu dessen Mitte
            gy_mitte = 10 + (bbox[1] + bbox[3]) / 2 - g.height / 2
            dx = -gy_mitte * math.sin(mitte) * -1
            dy = -gy_mitte * math.cos(mitte) * -1
            img.alpha_composite(gross, (int(round(mx - gross.width / 2 - dx)), int(round(my - gross.height / 2 - dy))))
        theta += (w + abstand) / R_TEXT_MITTE


def band(img, zahl, text):
    d = ImageDraw.Draw(img)
    for b in BAND_BOXEN:
        d.rectangle(b, fill=ROT)
    def mittig(t, f, y_mitte):
        bb = d.textbbox((0, 0), t, font=f)
        d.text((CX - (bb[0] + bb[2]) / 2, y_mitte - (bb[1] + bb[3]) / 2), t, font=f, fill=(255, 255, 255, 255))
    if zahl:
        mittig(zahl, schrift(132), 650)
        mittig(text, schrift(66), 740)
    else:
        mittig(text, schrift(74), 738)


def main():
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    ziel, ring, zahl, text = sys.argv[1:]
    img = Image.open(BASIS).convert('RGBA')
    ring_leeren(img)
    # Gleiche Versalhöhe wie das Original (ca. 63 px) -> Inter ExtraBold 88 px;
    # nicht verkleinern, damit alle Wappen gleich gross beschriftet sind.
    groesse = 88
    bogentext(img, ring, groesse)
    band(img, zahl, text)
    img.save(ROOT / ziel, optimize=True)
    print(f'{ziel}: Ringschrift {groesse}px')


if __name__ == '__main__':
    main()
