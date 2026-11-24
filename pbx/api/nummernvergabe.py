"""Persoenliche Nummern 3 HH WW P fuer neue Personen (docs/plans/telefon-nummernplan.md).

Regeln wie beim ersten Nummernplan (scripts/nummernplan.py, Entscheide Stefan 24.11.2026),
aber fortschreibend: vergebene Nummern bleiben unveraendert.

- Eine Nummer pro Person, Schluessel (E-Mail, Name) — Paare teilen sich oft eine E-Mail.
- Heimat-Wohnung: wo die Person wohnt (Bewohner, Mieter, selbst bewohnender Eigentuemer),
  sonst die erste vermietete Wohnung (Vermieter). Verwalter bekommen keine Nummer.
- HH/WW der Wohnung: wie schon vergeben; neue Wohnung: offizielle Nummer (RW1-03, 0103),
  sonst die naechste freie WW im Haus.
- P: naechste freie Ziffer 1-9 in der Wohnung.
- Ohne Wohnung (nur MEG): "Haus 00", 300WW1 mit der naechsten freien WW.
"""
import re

HAEUSER = {1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18}


def haus_von(bez):
    bez = (bez or "").strip()
    m = re.match(r"^RW\s*(\d{1,2})-(\d{2})\b", bez, re.I)   # RW1-03 -> Haus 1, Wohnung 03
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"^(?:RW)?\s*(\d{1,2})[.\-\s]", bez, re.I)
    if m:
        return int(m.group(1)), None
    m = re.match(r"^(\d{2})(\d{2})$", bez)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def _wohnt_dort(k, w):
    return k["rolle"] in ("bewohner", "mieter") or (
        k["rolle"] == "eigentuemer" and (w.get("bewohnt") or "") in ("eigentuemer", ""))


def neue_nummern(daten, bestehende):
    """daten: {wohnungen, kontakte, meg} von der Website (/api/pbx/personen).
    bestehende: Zeilen aus personen_nummern (nummer, email, name, wohnung, haus).
    -> (neue Zeilen [dict nummer,email,name,wohnung,haus,art], probleme [str])"""
    probleme = []
    wohnungen = {}
    for w in daten.get("wohnungen", []):
        h, ww = haus_von(w.get("bez"))
        if h in HAEUSER:
            wohnungen[str(w["id"])] = dict(w, bez=(w.get("bez") or "").strip(), haus=h, ww_offiziell=ww)

    vergeben = {(r["email"].lower(), r["name"].strip().lower()) for r in bestehende}
    emails_mit_nummer = {r["email"].lower() for r in bestehende}
    belegt = {r["nummer"] for r in bestehende}
    # Wohnung (Bezeichnung) -> (HH, WW) aus den schon vergebenen Nummern
    ww_der_wohnung = {}
    for r in bestehende:
        n = r["nummer"]
        if r.get("wohnung") and len(n) == 6 and n[1:3] != "00":
            ww_der_wohnung.setdefault(r["wohnung"].strip(), (int(n[1:3]), int(n[3:5])))

    def ww_fuer(w):
        if w["bez"] in ww_der_wohnung:
            return ww_der_wohnung[w["bez"]]
        h = w["haus"]
        im_haus = {ww for (hh, ww) in ww_der_wohnung.values() if hh == h}
        offiziell_andere = {x["ww_offiziell"] for x in wohnungen.values()
                            if x["haus"] == h and x["ww_offiziell"] and x["bez"] != w["bez"]}
        if w["ww_offiziell"] and w["ww_offiziell"] not in im_haus:
            ww = w["ww_offiziell"]
        else:
            ww = 1
            while ww in im_haus or ww in offiziell_andere:
                ww += 1
        if ww > 99:
            return None
        ww_der_wohnung[w["bez"]] = (h, ww)
        return h, ww

    def ordnung(k):
        w = wohnungen[k["wid"]]
        return (w["haus"], w["ww_offiziell"] or 99, w["bez"])

    personen = {}
    for k in daten.get("kontakte", []):
        k = dict(k, wid=str(k["wid"]), name=(k.get("name") or "").strip(), email=(k.get("email") or "").strip().lower())
        if not k["email"] or not k["name"] or k["rolle"] == "verwalter" or k["wid"] not in wohnungen:
            continue
        personen.setdefault((k["email"], k["name"]), []).append(k)

    neu = []
    for (email, name), ks in sorted(personen.items(), key=lambda x: min(str(k.get("created") or "") for k in x[1])):
        if (email, name.lower()) in vergeben:
            continue
        eigene = sorted([k for k in ks if _wohnt_dort(k, wohnungen[k["wid"]])], key=ordnung)
        if eigene:
            k, art = eigene[0], "automatisch: wohnt dort"
        else:
            vermietet = sorted([k for k in ks if k["rolle"] == "eigentuemer"], key=ordnung)
            if not vermietet:
                continue   # z.B. nur Notfallkontakt: keine Nummer
            k, art = vermietet[0], "automatisch: Vermieter"
        w = wohnungen[k["wid"]]
        hw = ww_fuer(w)
        if not hw:
            probleme.append(f"Haus {w['haus']}: keine freie Wohnungsnummer fuer {w['bez']}")
            continue
        h, ww = hw
        nummer = next((f"3{h:02d}{ww:02d}{p}" for p in range(1, 10) if f"3{h:02d}{ww:02d}{p}" not in belegt), None)
        if not nummer:
            probleme.append(f"Wohnung {w['bez']}: schon 9 Personen, {name} bekommt keine Nummer")
            continue
        belegt.add(nummer)
        vergeben.add((email, name.lower()))
        emails_mit_nummer.add(email)
        neu.append(dict(nummer=nummer, email=email, name=name, wohnung=w["bez"], haus=h, art=art))

    # MEG / ohne Wohnung: Haus 00
    for m in daten.get("meg", []):
        email = (m.get("email") or "").strip().lower()
        name = (m.get("name") or "").strip()
        if not email or not name or email in emails_mit_nummer or (email, name.lower()) in vergeben:
            continue
        ww = next((x for x in range(1, 100) if f"300{x:02d}1" not in belegt), None)
        if ww is None:
            probleme.append("Haus 00: keine freie Nummer mehr")
            break
        nummer = f"300{ww:02d}1"
        belegt.add(nummer)
        vergeben.add((email, name.lower()))
        emails_mit_nummer.add(email)
        neu.append(dict(nummer=nummer, email=email, name=name, wohnung=m.get("einheiten") or "",
                        haus=0, art="automatisch: MEG (ohne Wohnung)"))
    return neu, probleme
