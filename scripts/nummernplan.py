#!/usr/bin/env python3
"""Entwurf der persoenlichen 3000er-Nummern (3 HH WW P) aus Wohnungen + Kontakten.
Regeln: docs/plans/telefon-nummernplan.md (Entscheide Stefan 24.11.2026)."""
import csv, re, sys, os, json
from collections import defaultdict

D = os.path.dirname(os.path.abspath(__file__))
HAEUSER = {1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18}

wohnungen = {}
for wid, stweg, bez, stock, bewohnt in csv.reader(open(f"{D}/w.csv", encoding="utf-8")):
    wohnungen[wid] = dict(id=wid, stweg=stweg, bez=bez.strip(), stock=stock, bewohnt=bewohnt)

probleme = []

def haus_von(bez):
    m = re.match(r"^RW\s*(\d{1,2})-(\d{2})\b", bez, re.I)   # RW1-03 -> Haus 1, Wohnung 03
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"^(?:RW)?\s*(\d{1,2})[.\-\s]", bez, re.I)
    if m:
        return int(m.group(1)), None
    m = re.match(r"^(\d{2})(\d{2})$", bez)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"^RW\s*(\d{1,2})-(\d{2})\b", bez, re.I)   # RW1-03 -> Haus 1, Wohnung 03
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None

def stock_key(w):
    s = (w["stock"] or "").lower()
    b = w["bez"].upper()
    if "unter" in s or "UG" in b.split("."):
        return -1
    if "erd" in s or ".EG" in b:
        return 0
    m = re.search(r"(\d)\.\s*ober", s) or re.search(r"\.(\d)OG", b)
    if m:
        return int(m.group(1))
    if "dach" in s or "mansard" in s.lower() or "MANSARDE" in b or "DG" in b:
        return 8
    return 5

# Wohnungsnummer WW je Haus
pro_haus = defaultdict(list)
for w in wohnungen.values():
    h, ww = haus_von(w["bez"])
    if h not in HAEUSER:
        probleme.append(f"Wohnung '{w['bez']}': Haus nicht erkennbar")
        continue
    w["haus"], w["ww_offiziell"] = h, ww
    pro_haus[h].append(w)
for h, ws in pro_haus.items():
    belegt = {w["ww_offiziell"] for w in ws if w["ww_offiziell"]}
    n = 1
    for w in sorted(ws, key=lambda w: (w["ww_offiziell"] is None, w["ww_offiziell"] or 0, stock_key(w), w["bez"])):
        if w["ww_offiziell"]:
            w["ww"] = w["ww_offiziell"]
            continue
        while n in belegt:
            n += 1
        w["ww"] = n
        belegt.add(n)
    if max(w["ww"] for w in ws) > 99:
        probleme.append(f"Haus {h}: mehr als 99 Wohnungen")

# Kontakte
kontakte = []
for row in csv.reader(open(f"{D}/wk.csv", encoding="utf-8")):
    wid, stweg, bez, stock, bewohnt, kid, rolle, name, email, sort, created = row
    kontakte.append(dict(wid=wid, kid=kid, rolle=rolle, name=name.strip(), email=email.strip(), sort=int(sort or 0), created=created))

firmen = sorted({(k["name"], wohnungen[k["wid"]]["bez"]) for k in kontakte if re.search(r"\b(AG|GmbH|Gemeinde|Einwohnergemeinde|Stiftung|Genossenschaft)\b", k["name"])})
ohne_email = sorted({(k["name"], wohnungen[k["wid"]]["bez"], k["rolle"]) for k in kontakte if not k["email"] and k["rolle"] != "verwalter"})
personen = defaultdict(list)   # Schluessel: (email, name) — Paare teilen sich oft eine E-Mail
for k in kontakte:
    if k["email"] and k["rolle"] != "verwalter" and "haus" in wohnungen[k["wid"]]:
        personen[(k["email"], k["name"])].append(k)

def wohnt_dort(k):
    w = wohnungen[k["wid"]]
    return k["rolle"] in ("bewohner", "mieter") or (k["rolle"] == "eigentuemer" and w["bewohnt"] in ("eigentuemer", ""))

def w_ord(wid):
    w = wohnungen[wid]
    return (w["haus"], w["ww"])

zuhause = {}  # email -> kontakt (in der Heimat-Wohnung)
for schluessel, ks in personen.items():
    eigene = sorted([k for k in ks if wohnt_dort(k)], key=lambda k: w_ord(k["wid"]))
    if eigene:
        zuhause[schluessel] = (eigene[0], "wohnt dort" + (f" (wohnt in {len({k['wid'] for k in eigene})} Wohnungen)" if len({k['wid'] for k in eigene}) > 1 else ""))
    else:
        vermietet = sorted([k for k in ks if k["rolle"] == "eigentuemer"], key=lambda k: w_ord(k["wid"]))
        if vermietet:
            zuhause[schluessel] = (vermietet[0], "Vermieter")

pro_wohnung = defaultdict(list)
for schluessel, (k, art) in zuhause.items():
    pro_wohnung[k["wid"]].append((k, art))

zeilen = []
for wid, ps in pro_wohnung.items():
    w = wohnungen[wid]
    ps.sort(key=lambda x: (0 if x[0]["rolle"] == "eigentuemer" else 1, x[0]["sort"], x[0]["created"]))
    if len(ps) > 9:
        probleme.append(f"Wohnung {w['bez']}: {len(ps)} Personen (> 9)")
    for p, (k, art) in enumerate(ps, start=1):
        nr = f"3{w['haus']:02d}{w['ww']:02d}{p}"
        zeilen.append(dict(nummer=nr, name=k["name"], email=k["email"], wohnung=w["bez"], haus=w["haus"],
                           ww=w["ww"], p=p, rolle=k["rolle"], art=art))
# MEG / ohne Wohnung: "Haus 00" (Entscheid 24.11.), fortlaufend in der Reihenfolge der Eingabe
schon = {z["email"] for z in zeilen}   # MEG: wer schon eine Wohnungs-Nummer hat
ww = 0
for email, name, einheiten, created in csv.reader(open(f"{D}/meg.csv", encoding="utf-8")):
    if email in schon:
        continue
    ww += 1
    zeilen.append(dict(nummer=f"300{ww:02d}1", name=name.strip(), email=email, wohnung=einheiten, haus=0,
                       ww=ww, p=1, rolle="eigentuemer", art="MEG (ohne Wohnung)"))
zeilen.sort(key=lambda z: z["nummer"])
doppelt = [n for n in {z["nummer"] for z in zeilen} if sum(1 for z in zeilen if z["nummer"] == n) > 1]
if doppelt:
    probleme.append(f"Doppelte Nummern: {doppelt}")

# Ausgabe
with open(f"{D}/nummernplan-entwurf.json", "w", encoding="utf-8") as f:
    json.dump(zeilen, f, ensure_ascii=False, indent=1)
os.chmod(f"{D}/nummernplan-entwurf.json", 0o600)
print(f"{len(zeilen)} Personen mit Nummer, {len(pro_wohnung)} Wohnungen, "
      f"{sum(1 for z in zeilen if z['art']=='Vermieter')} Vermieter, {len(ohne_email)} Kontakte ohne E-Mail (ohne Nummer)")
akt = None
for z in zeilen:
    if z["haus"] != akt:
        akt = z["haus"]
        print(f"\n## Haus {akt}")
    print(f"{z['nummer']}  {z['wohnung']:<14} {z['name']:<32} {z['rolle']:<11} {z['art']}")
print("\n## Ohne E-Mail (keine Nummer)")
for n, b, r in ohne_email:
    print(f"   {b:<14} {n:<32} {r}")
print("\n## Firmen/Koerperschaften (bekommen auch eine Nummer)")
for n, b in firmen:
    print(f"   {b:<14} {n}")
print("\n## Probleme")
for p in probleme or ["keine"]:
    print("  -", p)
