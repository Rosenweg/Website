# Energie-Monitoring – Zähler, Seiten und wer was sieht

Stand: 17.11.2026. Dieses Dokument erklärt, wie die Stromzähler der Siedlung erfasst
und angezeigt werden und wer welche Daten sehen darf. Es ist bewusst ohne interne
Adressen geschrieben (es steht jeder angemeldeten Person auch über den
Portal-Agenten zur Verfügung). Die technische Beschreibung aller Routen, Fehlercodes
und Betriebsschritte steht in [`energie-api.md`](energie-api.md), die
Sicherheitsregeln in [`sicherheit.md`](sicherheit.md) Abschnitt 4.6.

## 1. Wie die Daten entstehen

```
Stromzähler (Modbus, Shelly, SmartFox)
    │  alle 5 Sekunden abgefragt
    ▼
Energy-Collector ──► Energie-Datenbank (Messwerte, Stunden- und Tageswerte, Tarife)
    │                └─ Zuordnung Zähler ↔ Person / Gruppe
    ▼
Portal-API (prüft Anmeldung und Zuordnung) ──► Webseiten, Apps, Agent
```

- Der **Energy-Collector** liest die Zähler, speichert Live-Werte und Zeitreihen und
  rechnet Überschuss, Eigenverbrauch und Tarife.
- Jeder Zähler kann einer **Person** (über ihre E-Mail-Adresse) und/oder einer
  **Gruppe** (z. B. alle Eigentümer einer STWEG) zugeordnet werden. Diese Zuordnung
  bestimmt, wer die Verbrauchsdaten sehen darf.
- **Tarife** (Netzstrom, Solarstrom) haben ein Gültigkeitsdatum; die Seiten rechnen
  Kosten immer mit dem am jeweiligen Tag gültigen Tarif.

## 2. Was offen ist und was eine Anmeldung braucht

Seit dem 17.11.2026 gilt:

| Daten | Wer sieht sie |
|---|---|
| Überschuss, Solarproduktion, Netzbezug/-einspeisung, Heizstab der Anlage Rosenweg 9; Tarife | **alle, ohne Anmeldung** – für Shelly-Geräte, LaMetric-Anzeigen und die Solar-Seite |
| Summe aller Wohnungen (auf der Solar-Seite) | alle, ohne Anmeldung – nur als Summe |
| Verbrauch einzelner Wohnungen (live und Verlauf) | **nur angemeldet**, nur die eigenen bzw. über die eigene Gruppe zugeordneten Zähler |
| Liste aller Zähler, Zuordnungen, Netzadressen und Seriennummern der Zähler | nur Technik, Präsident und wer das Recht „Energie-Konfiguration“ (lesen) hat |
| Zähler, Tarife und Zuordnungen ändern | nur mit dem Recht „Energie-Konfiguration“ (schreiben); Technik und Präsident haben es immer |

Früher lieferten die offenen Abfragen auch die Live-Leistung jeder einzelnen Wohnung
(Feld `consumers`). Daraus liess sich ablesen, wer zu Hause ist. Das Feld ist
entfernt; Geräte, die nur den Überschuss brauchen, merken davon nichts.

## 3. Seiten und Apps

| Seite | Für wen | Was |
|---|---|---|
| `energie-monitor.html` | Angemeldete mit Recht „Energie-Monitor“ | Verbrauch, Verlauf, Tagesansicht und Kosten der eigenen Zähler. Technik/Konfiguration sieht alle Zähler. Der Vergleich mit Solar- und Netzzähler erscheint nur, wenn diese Zähler der Person (oder ihrer Gruppe) zugeordnet sind. |
| `pwa/zaehler/` („Mein Zähler“) | jede angemeldete Person | eigene Zähler inkl. Gemeinschaftszähler, Live-Werte |
| `profil.html` | jede angemeldete Person | Liste der eigenen Zähler |
| `mqtt.html`, `pwa/mqtt/` | jede angemeldete Person | eigene Zähler für den MQTT-Zugang |
| `energie-config.html` | Recht „Energie-Konfiguration“ | Zähler anlegen/ändern/testen, Tarife, Zuordnungen zu Personen und Gruppen |
| `zaehler.html` | Recht „Zähler & Verbrauch“ | Zähler- und Verbrauchsdaten der STWEG |
| `pwa/technik/` und Werkzeug `zaehler_technik` | Technik; eingeschränkt Verwaltung und Eigentümer Rosenweg 9 | Status aller Zähler (online/offline). Ohne Konfigurationsrecht keine Netzadressen und Live-Werte nur von Netz, Produktion und eigenen Zählern. |
| `stweg3/pages/solaranlage-live.html`, `pwa/solar/` | alle | Solaranlage Rosenweg 9 live |
| `energie-info.html` | alle | Information zu ZEV und E-Ladeinfrastruktur |
| `shelly-emulator-howto.html` | alle | Bauanleitung virtuelles Shelly |

## 4. Häufige Fragen

**Ich sehe meinen Zähler nicht.** Der Zähler ist Ihrer E-Mail-Adresse noch nicht
zugeordnet, oder Sie sind mit einer anderen Adresse angemeldet. Melden Sie sich bei
der Technik; die Zuordnung erfolgt in der Energie-Konfiguration. Zähler, die einer
Gruppe zugeordnet sind (Gemeinschaftsstrom), erscheinen in „Mein Zähler“ zusätzlich.

**Die Seite meldet „Kein Zugriff auf diesen Zähler“.** Sie haben eine Zähler-ID
aufgerufen, die Ihnen nicht zugeordnet ist. Das ist gewollt.

**Die Seite meldet „Energy-Collector nicht erreichbar“.** Der Erfassungsdienst ist
gerade nicht erreichbar. Bitte später erneut versuchen; dauert es länger, die
Technik informieren.

**Der Überschuss zeigt 0, obwohl die Sonne scheint.** Wenn weder der Hauptzähler
noch die SmartFox-Steuerung in den letzten zwei Minuten einen Wert geliefert haben,
meldet das System absichtlich 0, damit kein Gerät ohne bestätigten Überschuss
einschaltet. Die Technik prüft dann die Zähler.

## 5. Geräte am Überschuss (Shelly, LaMetric)

Für Geräte gibt es offene Abfragen ohne Anmeldung. Anleitungen:

- Shelly 1PM/2PM bei Überschuss schalten: [`scripts/shelly-surplus-switch.md`](../scripts/shelly-surplus-switch.md)
- Shelly-Skript mit virtuellen Werten (Variante A): [`wiki/shelly-virtual-pv-ueberschuss.md`](../wiki/shelly-virtual-pv-ueberschuss.md)
- Virtuelles Shelly Pro 3EM (Variante B): [`wiki/shelly-virtual-pv-emulator.md`](../wiki/shelly-virtual-pv-emulator.md)
- LaMetric „My Data DIY“ und alle Parameter: [`energie-api.md`](energie-api.md) Abschnitt 2

## 6. ZEV-Rechnungen

Die Stromrechnungen aus dem Zusammenschluss zum Eigenverbrauch (ZEV) sieht jede
Person im Portal unter ihren eigenen Rechnungen (`/api/zev/meine-rechnungen`, PDF
je Rechnung). Eine Rechnung sieht, wer als Rechnungsempfänger eingetragen ist; wer
an derselben Wohnung als Kontakt hängt, sieht sie, solange der Empfänger noch
aktueller Kontakt der Wohnung ist (frühere Bewohner nicht); Eigentümer sehen die
Rechnungen ihrer Wohnungen, wenn die entsprechende Einstellung aktiv ist.

- ZEV-Einstellungen und Wohnungen mit Aliasen **ansehen**: Technik, Präsident, der
  Ausschuss und die Verwaltung (`stwegN-verwaltung`) **dieser** STWEG. Eine andere
  Gruppe der STWEG reicht nicht (seit 28.11.2026, vorher genügte z. B. der Ausschuss
  einer anderen STWEG mit Wohnung im Haus).
- ZEV-Einstellungen ändern und die Aliase mit Mailcow abgleichen: dieselben, mit Recht
  `wohnungsverwaltung` schreiben. Alias-Domain und -Prefix nur Technik und Präsident.
- Unzugeordnete Rechnungen zuordnen und bereits zugeordnete umhängen (seit 27.11.2026,
  jede Änderung in `admin_protokoll`): Technik, Präsident, Ausschuss und Verwaltung der
  STWEG der Rechnung. Rechnungen ohne STWEG: nur Technik und Präsident.
- PDF fremder Rechnungen: Ausschuss und Verwaltung der STWEG nur für **unzugeordnete**
  und **Allgemeinzähler**-Rechnungen (zum Zuordnen). Wohnungsrechnungen bleiben privat.
- „Aliase abgleichen“ heisst: Mail-Aliase in Mailcow anlegen bzw. umbiegen. Eine
  Schnittstelle zu smart-me gibt es nicht; die Rechnungen stellen smart-me/Axova aus.

App **Rosenweg ZEV** (`Rosenweg/rosenweg-zev`): dieselben Funktionen und Rechte, dazu
`GET /api/zev/uebersicht` (welche STWEGs einen ZEV haben, Rechte je STWEG),
`/meine-statistik` (Verbrauch und Solaranteil je Jahr, Regel auf dem Server),
`/neuigkeiten` (für Benachrichtigungen im Hintergrund), `/wechsel/:stweg`
(Meldungen an Axova) und den ElCom-Strompreis zum Vergleich
(`GET /api/strompreis/elcom`, nie in Tarife).

Details: [`../wiki/berechtigungen.md`](../wiki/berechtigungen.md).
