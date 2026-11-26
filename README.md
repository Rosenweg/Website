<p align="center"><img src="pwa/icons/icon-512.png" width="96" alt="Logo"></p>
<h1 align="center">Rosenweg Website</h1>
<p align="center">Website und Portal der STWEG-Kooperation Rosenweg in Kaiseraugst – für Bewohner, Ausschüsse und die Technik.</p>
<p align="center"><a href="https://www.rosenweg4303.ch">Zur Website</a> · <a href="docs/README.md">Dokumentation</a> · <a href="docs/entwickeln.md">Für Entwickler</a></p>

## Was drin ist

- Die öffentliche Website und die Seiten der 8 STWEGs (7 Wohnhäuser und die Tiefgarage).
- Das Portal für Bewohner: Anmeldung, Verteilerlisten, Waschküche, Energie-Monitor, Entsorgung, Salzvorrat.
- Verwaltung für Ausschuss und Technik: Bewohner, Rechte, Türschilder und Aushänge.
- Telefonanlage mit geteilten Smartphones und der Seite „Mein Telefon“.
- Die Download-Seite für alle Rosenweg-Apps (`/apps`).
- Betrieb der Stationen und Windows-Rechner (Active Directory, Gruppenrichtlinien).

## Läuft auf

Im Browser, auf Handy und PC; der Server läuft auf dem Proxmox-Cluster im Rosenweg.

## Entwickeln

HTML mit Tailwind und Vanilla JS, dahinter eine Node.js-API; Anmeldung über Authentik.
Architektur, Struktur und Ausrollen stehen in [docs/entwickeln.md](docs/entwickeln.md),
alles Weitere in der [Dokumentation](docs/README.md).
Das Repo ist öffentlich: keine Geheimnisse einchecken, siehe [docs/sicherheit.md](docs/sicherheit.md).

## Lizenz

Keine Lizenz hinterlegt – alle Rechte vorbehalten.
