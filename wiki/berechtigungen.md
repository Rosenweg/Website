# Berechtigungen – wer darf was im Rosenweg-Portal

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Massgebend ist, was der Code
der API durchsetzt (`api/server.js`, `api/middleware/auth.js`, `api/lib/groups.js`,
`api/routes/*.js`). Die Grundsätze und Grenzwerte stehen in
[`docs/sicherheit.md`](../docs/sicherheit.md) (Abschnitte 3, 4.3 und 5), die Routen
in [`docs/api.md`](../docs/api.md).

---

## 1. Woraus sich die Rechte ergeben

Rechte entstehen aus drei Quellen, die zusammenspielen:

1. **Authentik-Gruppen** der Person (beim Login in `users.groups_json` gespeichert).
   Eltern-Gruppen zählen mit (z. B. `r9-eigentuemer` → `eigentuemer`).
2. **Rechte-Tabelle `permissions`** (Seite × Gruppe → `none`/`read`/`write`),
   gepflegt in `rechteverwaltung.html`. Geprüft mit `requirePermission(seite, stufe)`.
   **Technik und Präsident bestehen jede `requirePermission`-Prüfung**, unabhängig von
   der Tabelle.
3. **Feste Regeln im Code**, die zusätzlich gelten und sich in der Rechteverwaltung
   **nicht** ausschalten lassen – vor allem die STWEG-Bindung (Abschnitt 3).

Eine Person kann mehrere Rollen haben; es gilt jeweils die weitestgehende.

### 1.1 Gruppen

| Rolle | Authentik-Gruppe(n) | Bemerkung |
|---|---|---|
| **Technik** | `technik` | volle Rechte |
| **Präsident** | `Präsident` (auch `praesident` wird erkannt) | volle Rechte wie Technik (Ausnahme siehe 5.3) |
| **Verwaltung** | `stweg1-verwaltung` … `stweg7-verwaltung`, `meg-verwaltung` (= STWEG 8) | Hausverwaltung mit Web-Login, gebunden an **diese** STWEG (wie der Ausschuss); keine Bewohnergruppe nötig. Verwaltet eine Firma alle STWEGs, steht ihr Konto in allen acht Gruppen. **Übergang:** die alte Gruppe `verwaltung` gilt bis zum Umhängen als Verwaltung aller STWEGs (`api/lib/groups.js`, Suche „ÜBERGANG“) |
| **Ausschuss** | `stweg1-ausschuss` … `stweg7-ausschuss`, `meg-ausschuss` (= STWEG 8) | gebunden an **diese** STWEG |
| **Eigentümer** | `stweg1-eigentuemer`, `stweg2-…`, `r9-eigentuemer` (STWEG 3), `stweg4-…`, `stweg5-…`, `r1-eigentuemer` (STWEG 6), `stweg7-…`, `meg-eigentuemer`; Eltern-Gruppe `eigentuemer` | Verwalter einer Wohnung (`wohnungen_kontakte.rolle='verwalter'`) werden wie Eigentümer in diese Gruppen gelegt. **Nicht verwechseln:** Das ist eine vom Eigentümer betraute Person, die ihn für diese Wohnung vertritt, **nicht** die Hausverwaltung (`stwegN-verwaltung`). Ein Konto in einer Verwaltungsgruppe legt der Abgleich nie in Eigentümer-/Bewohnergruppen |
| **Bewohner / Mieter** | `stweg1-bewohner`, …, `r9-bewohner` (STWEG 3), `r1-bewohner` (STWEG 6), `meg-bewohner`; Eltern-Gruppe `bewohner` | Mieter und Bewohner aus `wohnungen_kontakte` |
| **Anonym** | – | ohne Anmeldung |

Die Zuordnung STWEG ↔ Gruppen steht in `api/lib/groups.js` (`STWEG_GROUPS`,
für die Verwaltung `VERWALTUNG_GROUPS` mit `verwaltungStwegs`, `isVerwaltungFor`).
Die Verwaltungsgruppen zählen absichtlich nicht als Mitglied der STWEG
(`getUserStwegs`). Wo die Verwaltung mitliest, nimmt der Code sie ausdrücklich dazu
(`getStwegsMitVerwaltung`): STWEG-Ordner lesen (auch Fileserver,
`fileserver-lxc/ordnerrechte/tabelle.txt`), Waschküche Räume/Belegung lesen,
Bewohner-Rundmails der STWEG empfangen (`api/lib/verteiler-verwaltung.js`).
Reservieren und abstimmen bleibt bei den Bewohnergruppen.
**Wichtig:** Eine allgemeine Gruppe `ausschuss` ohne STWEG-Nummer zählt im Code
nicht als Ausschuss (`isAusschussForAny` kennt nur die STWEG-Gruppen); sie wirkt
nur, wenn sie in der Rechteverwaltung Einträge hat.

### 1.2 Hilfsprüfungen im Code

| Prüfung | Wer besteht |
|---|---|
| `adminOnly` / `req.user.isAdmin` | Technik, Präsident (Konto-Rolle `admin`) |
| `requireTechnikOrPraesident`, `requireTechnik` (SSH), `nurTechnik` (Stationen), `ispIsAdmin` | Technik, Präsident |
| `requireMqttTechnik` (MQTT-Verwaltung, Anzeigen) | Technik, Präsident (über `isAdmin`) |
| `requireAusschussOrTechnik` | Technik, Präsident, Ausschuss **irgendeiner** STWEG |
| `requireEigentuemer` | Technik, Präsident, jede Gruppe mit `eigentuemer` im Namen |
| `canManageDocs` | Technik, Präsident, jede Gruppe, die auf `-ausschuss` endet, jede Verwaltungsgruppe (nur Projekt-Dokumente, `canWriteDocPath`) |
| `canViewKontakteHistory` | Technik, Präsident, jede Verwaltungsgruppe, jede `-ausschuss`-Gruppe |
| `requireStwegAccess` | Technik, Präsident, jede Gruppe (Ausschuss/Eigentümer/Bewohner) **dieser** STWEG, Verwaltung **dieser** STWEG |
| `requireStwegWrite` / `stwegSchreibErlaubt` | Technik, Präsident, Ausschuss **dieser** STWEG, Verwaltung **dieser** STWEG |
| `stwegSicht` (`api/lib/stweg-sicht.js`) | Reklamationen, Auslagen: Ausschuss und Verwaltung sehen ihre STWEG(s); Einträge ohne STWEG Ausschuss und eine Verwaltung aller STWEGs |
| `vmSicht`, `vmDarfVerwalten` (`api/lib/vollmacht-rechte.js`) | Vollmachten: Verwaltung nur mit Seitenrecht `vollmachten` (lesen = ihre STWEG(s) sehen, schreiben = für Dritte erfassen, Papier aktivieren) |

### 1.3 Seeds der Rechte-Tabelle

Beim Start legt `initDB()` diese Einträge an, falls sie fehlen (`ON CONFLICT DO
NOTHING` – geänderte Werte bleiben):

| Gruppe | Seite | Stufe |
|---|---|---|
| alle `*-ausschuss` (STWEG 1–8) | `wohnungsverwaltung`, `auslagen`, `auslagen-stundensatz`, `reklamationen`, `mail-compose` | write |
| alle `*-ausschuss` | `email-archiv`, `mail-empfänger` | read |
| `stweg3-ausschuss`, `stweg6-ausschuss` | `bewohner-verwaltung` | write |
| alle `*-eigentuemer` und `eigentuemer` | `auslagen` | read |
| `technik`, `Präsident` | `pbx-admin`, `loeschungen` | write |
| `stweg1-verwaltung` … `stweg7-verwaltung`, `meg-verwaltung` | `objektverwaltung`, `wohnungsverwaltung`, `reklamationen`, `handwerker`, `vollmachten`, `projekte`, `email-verteiler` write; `auslagen`, `zähler`/`zaehler`, `energie-monitor`, `waschküche-admin`/`waschkueche-admin`, `kontakte`, `verwaltung`, `bewohner-verwaltung` read | |
| `Verwaltung` *(Übergang; nur wenn die Tabelle beim ersten Start leer war)* | `bewohner-verwaltung` write; `energie-monitor`, `email-verteiler`, `zähler`, `kontakte`, `verwaltung` read; dazu immer (falls fehlend) `vollmachten` write | |

Alle weiteren Einträge (z. B. `handwerker`, `energie-config`, `energie-monitor` für
Bewohner, `wohnungsverwaltung` für die Verwaltung) gibt es nur, wenn sie in der
Rechteverwaltung gesetzt wurden. Den tatsächlichen Stand zeigt:

```sql
SELECT group_name, page, access FROM permissions ORDER BY page, group_name;
```

---

## 2. Rechte-Matrix

Legende: ✅ schreiben · 👁 lesen · — kein Zugriff · **🅢** nur eigene STWEG ·
**(R)** nur wenn in der Rechteverwaltung erteilt · **eigene** nur eigene Datensätze.
„Ausschuss“ meint den Ausschuss der betroffenen STWEG; Ausschuss einer anderen STWEG
hat dort keine Rechte, auch wenn er dort wohnt oder Eigentümer ist.

### 2.1 Konto, Profil, Allgemeines

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Anmelden, eigenes Profil, eigene Telefon/E-Mail, WhatsApp-Opt-in | — | ✅ eigene | ✅ eigene | ✅ eigene | ✅ eigene | ✅ | ✅ |
| Passwort ändern (frische Anmeldung ≤ 15 Min, 5/Std.) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zugangstoken (PAT), Passkeys, MQTT-App-Passwörter | — | ✅ eigene (nur im Browser) | ✅ eigene | ✅ eigene | ✅ eigene | ✅ | ✅ |
| Eigene Wohnung im Profil (`/api/me/wohnung`) | — | ✅ eigene | ✅ eigene | ✅ eigene | ✅ eigene | ✅ | ✅ |
| Adressmutation melden | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Telefonbuch | — | 👁 🅢, ohne Archivierte | 👁 🅢, ohne Archivierte | 👁 alle | 👁 🅢 ohne Archivierte (alle bei Verwaltung aller STWEGs) | 👁 alle | 👁 alle |
| KI-Suche (30/Min.) | — | 👁 nur Sichtbares | 👁 | 👁 + Wohnungen 🅢 | 👁 erweitert | 👁 alles | 👁 alles |
| Dashboard / Übersicht | — | 👁 eigene | 👁 eigene | 👁 + Freigaben 🅢 | 👁 eigene | 👁 alles | 👁 alles |
| Push-Benachrichtigungen | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TV-Senderliste/Stream | Playlist/EPG offen; Stream mit Token | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 2.2 Reparaturen, Waschküche, Zutritt

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Reparatur melden ohne Konto (E-Mail-Code, 8 Stellen, 5 Versuche) | ✅ | – | – | – | – | – | – |
| Reparatur melden angemeldet (5 / 10 Min.) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Eigene Meldungen, Verlauf, Foto | — | 👁 eigene | 👁 eigene | 👁 eigene | 👁 eigene | 👁 | 👁 |
| Reklamationsliste und Bearbeitung (`reklamationen`) | — | — | — | ✅ 🅢 + ohne STWEG | (R) 🅢 (ohne STWEG nur bei Verwaltung aller STWEGs) | ✅ alle | ✅ alle |
| Melde-Orte, Auto-Zuweisung | — | — | — | ✅ (Recht `reklamationen`) 🅢 | (R `reklamationen` schreiben) 🅢 | ✅ | ✅ |
| Waschküche: Räume, Belegung, reservieren | — | ✅ 🅢 | ✅ 🅢 | ✅ 🅢 | 👁 🅢 Räume und Belegung, reservieren nur mit Bewohnergruppe | ✅ alle | ✅ alle |
| Waschküche: eigene Läufe und Kosten | — | 👁 eigene | 👁 eigene | 👁 eigene | 👁 eigene | 👁 | 👁 |
| Waschküche-Admin (Räume, Einstellungen, Abrechnung, Türen) | — | — | — | — | — | ✅ | ✅ |
| Türen öffnen (Zutritt-PWA, 10 / 10 Min., protokolliert) | — | ✅ nach Policy | ✅ nach Policy | ✅ nach Policy | ✅ nach Policy | ✅ | ✅ |
| Eigene NFC-Karten, Kennzeichen | — | ✅ eigene | ✅ eigene | ✅ eigene | ✅ eigene | ✅ | ✅ |
| Zutritt-Admin (Benutzer, Besucher, Policies, Türgruppen, Sync) | — | — | — | — | — | ✅ | ✅ |

### 2.3 STWEG-Verwaltung

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Öffentliche STWEG-Infos (Wohnungsliste ohne Namen, Übersicht, Ausschuss-/Technik-Kontakte, Verwaltung öffentlich, Verteilerliste) | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| STWEG-Kontakte (`/api/stweg/:nr/kontakte`, `/api/kontakte/:stweg`) | — | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 alle | 👁 alle |
| Wohnungen lesen (`wohnungsverwaltung` read + Gruppe der STWEG) | — | (R) 🅢 | (R) 🅢 | 👁 🅢 | (R) 🅢 | 👁 | 👁 |
| Wohnungen, Kontakte, Import, Archiv schreiben | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| Kontakt-Historie | — | — | — | 👁 🅢 | 👁 🅢 | 👁 | 👁 |
| Personen lesen | — | (R) 🅢 | (R) 🅢 | 👁 🅢 | (R) | 👁 | 👁 |
| Personen ändern / zusammenführen | — | — | — | ✅ 🅢, **nicht** Personen mit eigenem Konto oder Wohnungen ausserhalb (→ 409) | (R) wie Ausschuss | ✅ | ✅ |
| Benutzerkonten: Liste (Reiter „Bewohner“ nur, wenn erlaubt) | — | — | — | 👁 nur Konten der eigenen STWEG | — | 👁 alle | 👁 alle |
| Benutzerkonto anlegen (Recht `bewohner-verwaltung` write) | — | — | — | ✅ ohne Passwort, Name `vorname.nachname`, nur Bewohner-/Eigentümer-Gruppen 🅢 | ✅ falls Seed/Recht vorhanden, aber keine Gruppen vergebbar | ✅ | ✅ |
| Benutzerkonto ändern | — | — | — | ✅ 🅢; keine Technik-/Präsident-Konten, keine E-Mail, keine Aktivierung, keine Gruppen | — | ✅ | ✅ |
| Gruppen zuordnen (`/api/admin/groups`) | — | — | — | ✅ nur Bewohner-/Eigentümer-Gruppen 🅢, nur an Konten, die nur solche Gruppen haben oder schon in der STWEG sind | (R) | ✅ | ✅ |
| Benutzerkonto löschen | — | — | — | — | — | ✅ | ✅ |
| Vorgemerkte Löschungen (`loeschungen`) | — | — | — | — | — | ✅ | ✅ |
| ZEV: eigene Rechnungen, PDF, „bezahlt“ | — | ✅ eigene | ✅ eigene + Wohnungen | ✅ eigene | ✅ eigene | ✅ | ✅ |
| ZEV-Konfiguration und Abgleich | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| ZEV: unzugeordnete Rechnungen zuordnen | — | — | — | ✅ 🅢, nur unzugeordnete | (R `wohnungsverwaltung` schreiben) 🅢, nur unzugeordnete | ✅ auch umhängen | ✅ |
| Unterschriftenliste erzeugen / Rückläufe erfassen | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| Echtheitsprüfung Unterschriftenliste (30 / 10 Min.) | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| STWEG-Seiten (Module, Inhalte, Abschnitte) | 👁 | 👁 | 👁 | ✅ 🅢 | — | ✅ | ✅ |
| STWEG-Termine lesen (`/api/stweg/:nr/events`, `/api/termine`, App Rosenweg Termine) | — | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 alle | 👁 alle |
| STWEG-Termine anlegen, ändern, löschen (Recht `stweg-termine` schreiben, seit 28.11.2026 für alle Ausschüsse und Verwaltungen vorgegeben) | — | — | — | ✅ 🅢 (R) | ✅ 🅢 (R) | ✅ | ✅ |
| Verwaltungen (Firmen, Plattform-Zugänge) | 👁 öffentlicher Teil | — | — | 👁 eigene STWEG + übergreifende, ✅ nur eigene STWEG | — | ✅ | ✅ |
| Kontakte der Verwaltungen | — | je nach Sichtbarkeitsstufe 🅢 | je nach Stufe 🅢 | je nach Stufe 🅢 | 👁 eigene Verwaltung 🅢 | 👁 | 👁 |
| Grundbuch: Status und Anteile | — | 👁 ohne Namen/Adressen | 👁 ohne Namen | 👁 vollständig | 👁 ohne Namen | 👁 | 👁 |
| Grundbuch: reservieren, erfassen, OCR (30 / Std.) | — | ✅ eigene Reservation | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grundbuch: verifizieren, Auszugsbild | — | nur eigenes Bild | nur eigenes Bild | ✅ (jede STWEG) | — | ✅ | ✅ |
| MEG-Einstellplätze | freie Plätze | 👁 ohne Fremddaten | 👁 ohne Fremddaten | ✅ nur MEG-Ausschuss | — | ✅ | ✅ |
| Projekte lesen, kommentieren | öffentliche Projekte | — | 👁 ✅ Kommentar | 👁 | — | ✅ | ✅ |
| Projekte bearbeiten (Kandidaten, Zeitplan, Anhänge, Budget, öffentlich) | — | — | — | ✅ (jede STWEG) | — | ✅ | ✅ |
| Vollmachten: eigene erfassen, signieren, PDF hochladen | — | ✅ eigene | ✅ eigene | ✅ eigene | ✅ | ✅ | ✅ |
| Vollmachten der STWEG sehen | — | — | — | 👁 🅢 | (R `vollmachten` lesen) 🅢 | 👁 alle | 👁 alle |
| Vollmachten für andere erfassen, Papier-Vollmacht aktivieren | — | — | — | — | (R `vollmachten` schreiben) 🅢 | ✅ | ✅ |
| Vollmachten: Admin-Upload für alle Geber (`?als=admin`) | — | — | — | — | — | ✅ | ✅ |

### 2.4 Finanzen, Handwerker, Mail

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Auslagen einreichen, eigene sehen (`auslagen` read) | — | (R) | ✅ eigene | ✅ eigene | (R) 👁 alle 🅢 | ✅ | ✅ |
| Auslagen prüfen/genehmigen | — | — | — | ✅ 🅢 + ohne STWEG, **nicht eigene** | — | ✅ | ✅ |
| Auslagen als ausbezahlt markieren | — | — | ✅ eigene („erhalten“) | — | ✅ 🅢, genehmigte | ✅ | ✅ |
| Entwürfe sehen/ändern | — | nur Ersteller | nur Ersteller | nur Ersteller | nur Ersteller | 👁 | 👁 |
| Beleg-Scan (KI, 30 / Std.) | — | (R) | ✅ | ✅ | (R) | ✅ | ✅ |
| Auslagen-Stundensatz ändern | — | — | — | ✅ | — | ✅ | ✅ |
| Handwerker, Verträge, Aufträge, Notfallliste | — | — | — | (R) | (R) | ✅ | ✅ |
| Mail schreiben (Freigabe-Outbox, 50 / Std.) | — | — | — | ✅ | (R) | ✅ | ✅ |
| Mail-Empfänger-Stammdaten | — | — | — | 👁 | (R) | ✅ | ✅ |
| Mail-Outbox ansehen, freigeben, ablehnen | — | — | — | — | — | ✅ | ✅ |
| Mail-Vorlagen, Freigabe-Regeln | — | — | — | — | — | ✅ | ✅ |
| E-Mail-Verteiler (Listen, senden, Mitglieder) | Liste je STWEG 👁 | — | — | — | — | ✅ | ✅ |
| An geschützte STWEG-Verteiler schreiben, Bewohner-Rundmails empfangen | — | nach Gruppe | nach Gruppe | nach Gruppe | ✅ nur Verteiler ihrer STWEG(s) (Gruppe oder Vertrag) | ✅ | ✅ |
| E-Mail-Archiv lesen, Löschantrag stellen | — | — | — | 👁 ✅ **ganzes Archiv** (jede STWEG) | — | ✅ | ✅ |
| Löschantrag bestätigen (4-Augen) | — | — | — | ✅ nicht den eigenen | — | ✅ nicht den eigenen | ✅ nicht den eigenen |
| E-Mail-Log, Versandstatus, DMARC, SMTP-Kontingent | — | — | — | — | — | 👁 | 👁 |
| Briefe (Fotos versendeter Briefe) | — | — | — | ✅ (jede STWEG) | — | ✅ | ✅ |
| Dokumente lesen | — | 👁 `allgemein`, `scans`, aus der eigenen STWEG nur `stwegN/bewohner/` (Datenschutz, 28.11.2026) | + `projekte`, ganzer Ordner der eigenen STWEG | + `fotos_von_versendeten_briefen` | 👁 `allgemein`, `scans`, ihre STWEG(s), mit Recht „projekte“ die Projekte ihrer STWEG(s) und ohne STWEG | 👁 alles | 👁 alles |
| Dokumente schreiben, verschieben, löschen | — | — | — | ✅ `allgemein`, eigene STWEG, `projekte/<Projekt>` der eigenen STWEG bzw. ohne STWEG | ✅ `projekte/<Projekt>` ihrer STWEG(s) mit Recht „projekte“ = schreiben | ✅ | ✅ |
| Gesperrte Ordner `auslagen/`, `anzeigen/`, `reklamationen/`, `unterschriftenlisten/`, `grundbuch-bilder/` über die Dokumenten-API | — | — | — | — | — | ✅ | ✅ |

### 2.5 Energie

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Überschuss, LaMetric, Shelly, Solar live, Tarife | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| Eigene Zähler (persönlich oder über Gruppe zugeordnet), Verlauf, Export | — | 👁 eigene | 👁 eigene | 👁 eigene | 👁 eigene | 👁 alle | 👁 alle |
| Alle Zähler, Zuordnungen, Technikfelder (`energie-config` read) | — | — | — | (R) | (R) | 👁 | 👁 |
| Zähler, Tarife, Zuordnungen ändern (`energie-config` write) | — | — | — | (R) | (R) | ✅ | ✅ |
| Technische Zählerübersicht `/api/zaehler-technik` | — | — | eingeschränkt, nur `r9-eigentuemer` | — | eingeschränkt | 👁 voll | siehe 5.3 |
| Seite `energie-monitor.html` (Menü) | — | (R) | (R) | (R) | (R) | ✅ | ✅ |

Details: [`docs/energie-api.md`](../docs/energie-api.md).

### 2.6 Technik und Betrieb

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| ISP: eigene Reverse-Proxy-Einträge, Weiterleitungen, Mail-Relays | — | ✅ eigene, Freigabe durch Admin | ✅ eigene | ✅ eigene | ✅ eigene | ✅ alle | ✅ alle |
| ISP: eigene VPN-Konten (max. 10, 10 / Std.) | — | ✅ eigene VLANs | ✅ | ✅ | ✅ | ✅ | ✅ |
| ISP: Postfach beantragen (10 / Std., max. 3 automatisch) | — | ✅ wenn Relay die Gruppe erlaubt | ✅ | ✅ | ✅ | ✅ | ✅ |
| ISP-Admin (Freigaben, Abonnenten, feste IPs, VLAN, Router, Wartung) | Wartungsmeldungen, Status-Zusammenfassung 👁 | — | — | — | — | ✅ | ✅ |
| NOC | gekürzte Sicht (falls `NOC_PUBLIC_OPEN`) | — | — | — | — | 👁 voll | 👁 voll |
| Proxmox, PVE-Meldungen, Verbindungen | — | — | — | — | — | ✅ | ✅ |
| PBX-Verwaltung, Anrufliste, Testanruf | — | — | — | — | — | ✅ | ✅ |
| WhatsApp-Bot-Verwaltung, Rundschreiben, Kopplung | — | — | — | — | — | ✅ | ✅ |
| MQTT-Verwaltung, Anzeigen/Displays, Ankündigungen | — | — | — | — | — | ✅ | ✅ |
| Eigener MQTT-Zugang | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSH: eigene Schlüssel, GitHub-Abgleich | — | ✅ eigene (nur im Browser) | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSH-Matrix, Hosts, Sitzungen, Dienste | — | — | — | — | — | ✅ | ✅ |
| Stationen verwalten | — | — | — | — | — | ✅ | ✅ |
| Rechteverwaltung (`rechteverwaltung`) | — | — | — | (R) | (R) | ✅ | ✅ |
| MCP-Aufrufprotokoll | — | — | — | — | — | 👁 | 👁 |

---

## 3. STWEG-Bindung (Mandantentrennung)

Seit dem 17.11.2026 gilt in allen schreibenden STWEG-Bereichen:

- **Ausschuss** schreibt nur in **seiner** STWEG. Wer Ausschuss in STWEG 5 ist und
  in STWEG 3 wohnt oder dort Eigentümer ist, hat in STWEG 3 nur die Rechte eines
  Bewohners bzw. Eigentümers. Vorher reichte `wohnungsverwaltung:write` plus
  irgendeine Gruppe der STWEG.
- **Verwaltung** schreibt nur in STWEGs, in deren Gruppen sie selbst steht, und nur,
  wenn sie das Seitenrecht hat.
- Gilt für Wohnungen, Kontakte, Import, Archiv, ZEV-Konfiguration und -Abgleich,
  Unterschriftenlisten und Rückläufe (`requireStwegWrite`), ausserdem für
  Reklamationen (Liste und alle `:id`-Routen; fremde Meldungen ergeben **404**),
  Auslagen, Personen, Benutzer- und Gruppenverwaltung, Verwaltungen, STWEG-Seiten,
  STWEG-Termine (`api/lib/termine.js`),
  Waschküche und Telefonbuch.
- Datensätze **ohne STWEG** (z. B. Reklamationen oder Auslagen ohne Zuordnung) sehen
  und bearbeiten alle Ausschüsse.
- Nicht STWEG-gebunden sind bewusst: Projekte, Briefe, E-Mail-Archiv, Grundbuch-
  Verifikation und – falls erteilt – Handwerker (gemeinsam gepflegt).

---

## 4. Besondere Schutzregeln

- **Geschützte Personen:** Personen mit eigenem aktivem Konto oder mit Wohnungen
  ausserhalb der eigenen Ausschuss-STWEGs dürfen nur Technik und Präsident
  umbenennen, umadressieren oder zusammenführen (sonst **409**). Die Person ändert
  ihre Daten selbst im Profil.
- **Kontakte:** Eine `person_id` aus dem Formular wird verworfen; wechselt die E-Mail
  an einer Kontaktkarte (Mieterwechsel), hängt der Server den Kontakt an eine eigene
  Person. E-Mail oder Telefon, die einer anderen Person oder einem Konto gehören →
  **409**.
- **Auslagen:** Keine Selbstgenehmigung; Entwürfe sieht und ändert nur der Ersteller
  (und Technik/Präsident lesend); Positionen nur bis „eingereicht“.
- **Automatisches Löschen von Konten** nach Auszug nur, wenn **alle** Gruppen des
  Kontos Bewohner/Eigentümer dieser STWEG sind; storniert, sobald die Adresse wieder
  aktiver Kontakt ist.
- **Konten-Bindung:** Eine Benutzerzeile gehört einem Authentik-Konto
  (`users.authentik_sub`); ein zweites Konto mit derselben E-Mail wird abgewiesen.
- **Zugangstoken (PAT):** wirken mit den Rechten der Person, eingeschränkt durch
  Scopes; Passwort, Token, Passkeys, MQTT-Zugangsdaten und Profil-Login sind für
  Token gesperrt (siehe [`docs/api.md`](../docs/api.md)).

---

## 5. Sonderfälle und bekannte Eigenheiten

### 5.1 Verwalter, Mieter, Bewohner in `wohnungen_kontakte`

| Rolle | Login-Zugang (`authentik_zugang`) Standard | Authentik-Gruppen | Rechte |
|---|---|---|---|
| `eigentuemer` | ja | `<stweg>-eigentuemer` | Eigentümer |
| `verwalter` | ja | wie Eigentümer | wie Eigentümer |
| `mieter` | nein (manuell) | `<stweg>-bewohner` | Bewohner |
| `bewohner` | nein (manuell) | `<stweg>-bewohner` | Bewohner |

### 5.2 Verwaltungs-Firmen und Sachbearbeiter

Die Verwaltungs-Firmen (`verwaltungen`) und ihre Sachbearbeiter
(`verwaltungs_kontakte`) sind in erster Linie Mail-Empfänger. Wer davon ein
Web-Login braucht, bekommt ein Konto in der Gruppe `verwaltung` **und** eine Gruppe
der betreuten STWEG; sonst greifen die STWEG-gebundenen Schreibrechte nicht.

### 5.3 Präsident ohne Zugang zu `/api/zaehler-technik`

`requireZaehlerTechnik` lässt nur `technik`, `verwaltung` und `stweg3-eigentuemer`
durch. Ein Präsident ohne eine dieser Gruppen bekommt dort 403, obwohl er die volle
Sicht hätte, wenn er durchkäme. Alle anderen Energie-Routen behandeln Präsident wie
Technik.

### 5.4 Benutzer anlegen durch die Verwaltung

Hat die Gruppe `Verwaltung` das Seed-Recht `bewohner-verwaltung:write`, kann sie
über `POST /api/admin/users` Konten **ohne Gruppen** anlegen (Gruppen darf sie keine
vergeben, weil sie keine Ausschuss-STWEG hat), die Benutzerliste aber nicht lesen.

---

## 6. Wie ändert man Berechtigungen?

1. **Gruppe zuweisen:** In Authentik (`https://authentik.rosenweg4303.ch`) die Person
   in die Gruppe legen – oder im Portal unter Benutzerverwaltung (Ausschuss: nur
   Bewohner-/Eigentümer-Gruppen der eigenen STWEG). Die neue Gruppe wirkt ab der
   nächsten Anmeldung bzw. dem nächsten Gruppen-Sync.
2. **Seitenrecht ändern:** Technik/Präsident in `rechteverwaltung.html` (schreibt in
   `permissions`). Wirkt sofort.
3. **Feste Regeln** (STWEG-Bindung, Technik-only-Bereiche) ändern nur über den Code
   (`api/server.js`, `api/lib/groups.js`, `api/middleware/auth.js`).
