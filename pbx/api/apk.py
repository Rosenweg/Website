"""
Pruefung von Android-APKs ohne Android-Werkzeuge (gemeinsam fuer die PBX-API und den
adb-Updater der geteilten Telefone): Signer-Zertifikat und Manifest (Paket, versionCode).
"""
import hashlib

# SHA-256 des Rosenweg-Release-Zertifikats (alle Rosenweg-Apps)
SIGNATUR_SHA256 = "7b3bac26e82b6103546b96861dcf1bb89b3239424ff11fdf684975cf78c5a5ae"


def zertifikat_sha256(pfad):
    """SHA-256 des ersten Signer-Zertifikats aus dem APK-Signaturblock (v2/v3), sonst None.
    Nur die Herkunftspruefung beim Hochladen; die kryptografische Pruefung machen Android und
    der Updater beim Installieren."""
    import struct
    with open(pfad, "rb") as f:
        f.seek(0, 2)
        laenge = f.tell()
        f.seek(max(0, laenge - 65557))
        ende = f.read()
        eocd = ende.rfind(b"PK\x05\x06")
        if eocd < 0:
            return None
        cd = struct.unpack_from("<I", ende, eocd + 16)[0]
        if cd < 32:
            return None
        f.seek(cd - 24)
        groesse, magie = struct.unpack("<Q16s", f.read(24))
        if magie != b"APK Sig Block 42" or groesse > cd or groesse < 24:
            return None
        f.seek(cd - groesse - 8)
        block = f.read(groesse - 16)   # Laengenfeld + Paare, ohne Laenge+Magie am Ende
    paare, i = {}, 8   # Paare beginnen nach dem fuehrenden Laengenfeld
    while i + 12 <= len(block):
        plen, pid = struct.unpack_from("<QI", block, i)
        paare[pid] = block[i + 12:i + 8 + plen]
        i += 8 + plen
    wert = paare.get(0x7109871A) or paare.get(0xF05368C0)   # v2, sonst v3
    if not wert:
        return None
    try:
        def lp(b, o):   # laengenpraefigiertes Stueck
            n = struct.unpack_from("<I", b, o)[0]
            return b[o + 4:o + 4 + n], o + 4 + n
        signers, _ = lp(wert, 0)
        signer, _ = lp(signers, 0)
        signed, _ = lp(signer, 0)
        _digests, o = lp(signed, 0)
        zerts, _ = lp(signed, o)
        zert, _ = lp(zerts, 0)
    except struct.error:
        return None
    return hashlib.sha256(zert).hexdigest() if zert else None


def manifest(pfad):
    """(paket, versionCode, versionName) aus dem binaeren AndroidManifest.xml, sonst (None, None, None)."""
    import struct
    import zipfile
    try:
        with zipfile.ZipFile(pfad) as z:
            x = z.read("AndroidManifest.xml")
        if struct.unpack_from("<H", x, 0)[0] != 0x0003:
            return None, None, None
        o = struct.unpack_from("<H", x, 2)[0]
        texte, resids = [], []
        while o + 8 <= len(x):
            typ, hgr, gr = struct.unpack_from("<HHI", x, o)
            if typ == 0x0001:   # String-Pool
                anzahl, _stile, flags, start = struct.unpack_from("<IIII", x, o + 8)
                utf8 = bool(flags & 0x100)
                for k in range(anzahl):
                    p = o + start + struct.unpack_from("<I", x, o + hgr + 4 * k)[0]
                    if utf8:
                        p += 2 if x[p] & 0x80 else 1
                        n = x[p] & 0x7F
                        if x[p] & 0x80:
                            n = (n << 8) | x[p + 1]
                            p += 1
                        texte.append(x[p + 1:p + 1 + n].decode("utf-8", "replace"))
                    else:
                        n = struct.unpack_from("<H", x, p)[0]
                        if n & 0x8000:
                            n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", x, p + 2)[0]
                            p += 2
                        texte.append(x[p + 2:p + 2 + 2 * n].decode("utf-16-le", "replace"))
            elif typ == 0x0180:   # Ressourcen-IDs der Attributnamen
                resids = list(struct.unpack_from(f"<{(gr - hgr) // 4}I", x, o + hgr))
            elif typ == 0x0102:   # Start-Element
                name = struct.unpack_from("<I", x, o + 20)[0]
                if texte[name] == "manifest":
                    a_start, a_gr, a_anz = struct.unpack_from("<HHH", x, o + 24)
                    paket = vcode = vname = None
                    for k in range(a_anz):
                        a = o + 16 + a_start + k * a_gr
                        _ns, an, roh, _g, _r, dtyp, daten = struct.unpack_from("<IIIHBBI", x, a)
                        rid = resids[an] if an < len(resids) else 0
                        aname = texte[an] if an < len(texte) else ""
                        wert = texte[roh] if roh != 0xFFFFFFFF else (texte[daten] if dtyp == 0x03 else None)
                        if aname == "package":
                            paket = wert
                        elif rid == 0x0101021B or aname == "versionCode":
                            vcode = daten if dtyp in (0x10, 0x11) else (int(wert) if wert and wert.isdigit() else None)
                        elif rid == 0x0101021C or aname == "versionName":
                            vname = wert
                    return paket, vcode, vname
            if gr <= 0:
                break
            o += gr
    except (KeyError, zipfile.BadZipFile, struct.error, IndexError, ValueError, OSError):
        pass
    return None, None, None
