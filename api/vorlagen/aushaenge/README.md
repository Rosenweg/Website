# Druckvorlagen: Türschilder und Poster

A4-Vorlagen für Türschilder (Heizung, Waschküche, Lift, Telekom, Hauptverteilung,
Tiefgarage) und die Waschküche-Poster.

## QR-Codes mit Token

Die Vorlagen enthalten Platzhalter `{{QR:<thema>}}`. Beim Druck über
`tuerschilder.html` (Login, Recht `reklamationen`) ersetzt
`GET /api/raum-qr/druck/<vorlage>` sie durch lokal erzeugte QR-Codes auf
`/raum.html?t=<token>`.

- Räume werden auf `tuerschilder.html` angelegt (Tabelle `raum_orte`): Typ, Haus-Kurzname, Standort.
  `{{ORT}}` in den Vorlagen wird durch den Standort ersetzt.
- Ein Token je Raum und Thema (Tabelle `raum_qr`, Spalte `raum` = `<typ>-<kurz>`), 16 Zeichen zufällig.
- Schlüsselhalter: Authentik-Gruppe `schluessel-<typ>-<kurz>` (z. B. `schluessel-waschkueche-r9`);
  angezeigt werden Name und Attribut `telefon`.
- `/raum.html` zeigt Inhalte nur mit gültigem Token (`GET /api/raum-qr/info/<token>`);
  ohne Token nur «Bitte QR-Code scannen».
- «Codes erneuern» macht alle alten Ausdrucke eines Raums ungültig.
- Inhalte der Raumseiten je Typ: `TYPEN` in `api/routes/raum-qr.js`.

Die Vorlagen liegen bewusst im API-Image und nicht im öffentlichen Docroot:
Das Repo ist öffentlich, Tokens dürfen nie in Dateien stehen.

## Neue Vorlage

1. HTML hier ablegen, QR-Bilder als `<img src="{{QR:<thema>}}">`.
2. In `VORLAGEN` (`api/routes/raum-qr.js`) eintragen, Typ zuordnen.
3. Das Thema muss eine Abschnitts-ID des Typs in `TYPEN` sein.
