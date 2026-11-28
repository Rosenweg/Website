# Berechtigungen – wer darf was im Rosenweg-Portal

Stand: 28.11.2026 (ISP nur für Bewohner; vorher 17.11.2026, Sicherheitsprüfung PR #23). Massgebend ist, was der Code
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
| **Präsident** | `Präsident` (auch `praesident` wird erkannt) | volle Rechte wie Technik |
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
| `vmSicht`, `vmDarfVerwalten` (`api/lib/vollmacht-rechte.js`) | Vollmachten: Ausschuss und Verwaltung nur mit Seitenrecht `vollmachten` (lesen = Vollmachten ihrer STWEG(s) sehen, schreiben = Verwaltung für Dritte erfassen, Papier aktivieren); Vorgabe seit 28.11.2026: alle Ausschüsse lesen (Rechte-Migration) |
| `vmGeberErlaubt`, `vmOhneNachweis`, `vmDarfKiPruefen`, `vmSucheStwegs`, `vmVorlageBearbeiten` (`api/lib/vollmacht-rechte.js`), `signierenErlaubt` (`api/lib/stufen.js`) | Vollmachten (Entscheide 28.11.2026): erteilen und aktiv schalten nur Eigentümer/Wohnungs-Verwalter der Wohnung bzw. STWEG; IP, User-Agent, Authentik-Kennung nur T/P; KI-Prüfung nur Verwaltung der STWEG und T/P auf Knopfdruck; Personensuche nur in STWEGs mit Eigentümer-Sicht; Vorlagen je STWEG; Signieren nur frisch angemeldet, nie per PAT/MCP |
| `projektLesen`, `lesbareProjekte`, `auslageEmailSehen`, `kommentarOhneEmail` (`api/lib/projekte-rechte.js`) | Projekte je Projekt: Eigentümer ihrer STWEG und Kooperation, Ausschuss/Verwaltung (Recht `projekte`) ihrer STWEG und Kooperation, T/P alle; gilt auch für `projects-mini`, `doodle/projects`, Projekt-Umfragen, Suche und Projekt-Dateien |

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
| TV-Senderliste/Stream | Playlist/EPG (XML) offen; EPG als JSON (`/api/tv/jetzt`, `/api/tv/epg`) für jedes Konto; Stream mit Token | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

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
| Wohnungen, Kontakte, Archiv schreiben (protokolliert, `admin_protokoll` Bereich `objekte`) | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| Wohnung löschen (samt Kontakten und Historie; der Ausschuss archiviert stattdessen die Kontakte) | — | — | — | — | — | ✅ | ✅ |
| Import (kontakte.json) | — | — | — | — | — | ✅ | ✅ |
| Export Wohnungen/Eigentümer/Personen (XLSX/CSV, protokolliert) | — | — | — | ✅ 🅢 | ✅ 🅢 | ✅ | ✅ |
| Konto über einen Kontakt auslösen (Eigentümer/Verwalter automatisch, sonst mit Häkchen; protokolliert) | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| Kontakt-Historie | — | — | — | 👁 🅢 | 👁 🅢 | 👁 | 👁 |
| Personen lesen | — | (R) 🅢 | (R) 🅢 | 👁 🅢 | (R) 🅢 | 👁 | 👁 |
| Personen: Geburtsdatum | — | — | — | — | — | 👁 ✅ | 👁 ✅ |
| Personen: Notiz | — | — | — | 👁 ✅ | — | 👁 ✅ | 👁 ✅ |
| Personen ändern / zusammenführen (protokolliert, Bereich `personen`) | — | — | — | ✅ 🅢, **nicht** Personen mit eigenem Konto oder Wohnungen ausserhalb (→ 409) | ✅ 🅢 (Recht `wohnungsverwaltung` schreiben), gleiche Schutzregeln wie der Ausschuss | ✅ | ✅ |
| Benutzerkonten: Liste (Reiter „Bewohner“ nur, wenn erlaubt) | — | — | — | 👁 nur Konten der eigenen STWEG | — | 👁 alle | 👁 alle |
| Benutzerkonto anlegen (Recht `bewohner-verwaltung` write) | — | — | — | ✅ ohne Passwort, Name `vorname.nachname`, nur Bewohner-/Eigentümer-Gruppen 🅢 | ✅ falls Seed/Recht vorhanden, aber keine Gruppen vergebbar | ✅ | ✅ |
| Benutzerkonto ändern | — | — | — | ✅ 🅢; keine Technik-/Präsident-Konten, keine E-Mail, keine Aktivierung, keine Gruppen | — | ✅ | ✅ |
| Gruppen zuordnen (`/api/admin/groups`) | — | — | — | ✅ nur Bewohner-/Eigentümer-Gruppen 🅢, nur an Konten, die nur solche Gruppen haben oder schon in der STWEG sind | (R) | ✅ | ✅ |
| Benutzerkonto löschen | — | — | — | — | — | ✅ | ✅ |
| Vorgemerkte Löschungen (`loeschungen`): sehen, stoppen, Timer +30 Tage | — | — | — | ✅ 🅢 (R, seit 28.11.2026 vorgegeben) | ✅ 🅢 (R, seit 28.11.2026 vorgegeben) | ✅ | ✅ |
| Vorgemerkte Löschung: Eintrag entfernen | — | — | — | — | — | ✅ | — |
| Konto sofort löschen (frische Konto-Anmeldung, nicht mit Karte; siehe [`docs/konto-loeschung.md`](../docs/konto-loeschung.md)) | — | — | — | — | — | ✅ | ✅ |
| ZEV: eigene Rechnungen, PDF, „bezahlt“ | — | ✅ eigene | ✅ eigene + Wohnungen | ✅ eigene | ✅ eigene | ✅ | ✅ |
| ZEV-Konfiguration, Wohnungen/Aliase ansehen und abgleichen (nur Ausschuss/Verwaltung **dieser** STWEG, seit 28.11.2026) | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| ZEV: Rechnungen zuordnen und umhängen (protokolliert); PDF unzugeordneter und Allgemeinzähler-Rechnungen | — | — | — | ✅ 🅢 | (R `wohnungsverwaltung` schreiben) 🅢 | ✅ auch ohne STWEG | ✅ |
| Unterschriftenliste erzeugen / Rückläufe erfassen (protokolliert) | — | — | — | ✅ 🅢 | (R) 🅢 | ✅ | ✅ |
| Rückläufe ansehen (Ja/Nein mit Name) | — | — | — | 👁 🅢 | 👁 🅢 | 👁 | 👁 |
| Echtheitsprüfung Unterschriftenliste (30 / 10 Min.) | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| STWEG-Seiten (Module, Abschnitte; öffentlich, der Editor zeigt „öffentlich sichtbar“) | 👁 | 👁 | 👁 | ✅ 🅢 | — | ✅ | ✅ |
| Wohnungsliste der STWEG mit Belegung, Besonderheiten, Wertquote (`/api/stweg/:n/wohnungen`) | nur Anzahl | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 | 👁 |
| Kontaktliste der STWEG (Name, Mail, Telefon; nur Kontakte ab `gueltig_ab`) | — | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 alle | 👁 alle |
| STWEG-Termine lesen (`/api/stweg/:nr/events`, `/api/termine`, App Rosenweg Termine) | — | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 🅢 | 👁 alle | 👁 alle |
| STWEG-Termine anlegen, ändern, löschen (Recht `stweg-termine` schreiben, seit 28.11.2026 für alle Ausschüsse und Verwaltungen vorgegeben) | — | — | — | ✅ 🅢 (R) | ✅ 🅢 (R) | ✅ | ✅ |
| Verwaltungen (Firmen, Plattform-Zugänge) | 👁 öffentlicher Teil | — | — | 👁 eigene STWEG + übergreifende, ✅ nur eigene STWEG | eigener Eintrag 🅢: ✅ Kontaktpersonen und Kontaktdaten der Firma (Adresse, Telefon, E-Mail, Website, Öffnungszeiten); Vertrag, Plattform-Zugang, Sichtbarkeit fest; **ohne** Plattform-Passwort und Notizen | ✅ | ✅ |
| Kontakte der Verwaltungen | — | je nach Sichtbarkeitsstufe 🅢 | je nach Stufe 🅢 | je nach Stufe 🅢 | 👁 eigene Verwaltung 🅢 | 👁 | 👁 |
| Grundbuch: Status und Anteile | — | 👁 ohne Namen/Adressen | 👁 ohne Namen | 👁 vollständig 🅢 (Anteile ohne STWEG ohne Namen) | 👁 ohne Namen | 👁 | 👁 |
| Grundbuch: reservieren, erfassen | — | — | ✅ 🅢 (Anteile ohne STWEG: jede Eigentümerin) | ✅ 🅢 | — | ✅ | ✅ |
| Grundbuch: KI-Auslese (OpenRouter/Anthropic, 30 / Std.; nur auf Knopfdruck nach Hinweis, nie per PAT/MCP) | — | — | ✅ für den eigenen reservierten Anteil 🅢 | ✅ 🅢 | — | ✅ | ✅ |
| Grundbuch: verifizieren, Auszugsbild | — | — | nur eigenes Bild | ✅ 🅢 | — | ✅ | ✅ |
| Grundbuch: STWEG einer Parzelle zuordnen (protokolliert; Vorschlag aus Wertquoten, Anzahl und Adressen, nur nach Bestätigung übernommen) | — | — | — | — | — | ✅ | ✅ |
| MEG-Einstellplätze | freie Plätze | 👁 nur MEG-Mitglieder, ohne Fremddaten | 👁 nur MEG-Mitglieder, ohne Fremddaten | ✅ nur MEG-Ausschuss | ✅ nur MEG-Verwaltung | ✅ | ✅ |
| Projekte lesen (inkl. Kandidaten, Kontakte, Notizen, Kommentare) | öffentliche Projekte (eingeschränkt, siehe unten) | — (auch keine Titel, keine Projekt-Umfragen) | 👁 🅢 + Kooperation | 👁 🅢 + Kooperation (auch ohne Eigentümergruppe) | (R `projekte` lesen) 👁 🅢 + Kooperation | 👁 alle | 👁 alle |
| Projekte kommentieren (nur Name sichtbar, keine E-Mail; eigene Kommentare 15 Minuten ändern/löschen) | — | — | ✅ 🅢 + Kooperation | ✅ 🅢 + Kooperation | ✅ 🅢 + Kooperation (P10, 28.11.2026) | ✅ | ✅ |
| Projekt ganz löschen (mit Protokoll; sonst „archiviert“) | — | — | — | — | — | ✅ | ✅ |
| Auslagen eines Projekts: E-Mail der einreichenden Person | — | — | — (nur Name) | — (nur Name) | 👁 🅢 | 👁 | 👁 |
| Projekte bearbeiten (Kandidaten, Zeitplan, Anhänge, Budget, öffentlich) | — | — | — | ✅ 🅢 + Kooperation | (R `projekte` schreiben) 🅢 | ✅ | ✅ |
| Projekt öffentlich schalten (mit Bestätigung), Anhang einzeln öffentlich markieren | — | — | — | ✅ 🅢 + Kooperation | (R `projekte` schreiben) 🅢 | ✅ | ✅ |
| Vollmachten erteilen, signieren, eigene PDF hochladen | — | — (nur „Mich betreffend“) | ✅ als Eigentümer/Wohnungs-Verwalter der Wohnung bzw. STWEG | wie Eigentümer | wie Eigentümer | ✅ | ✅ |
| Vollmachten digital signieren | — | — | ✅ nur frisch angemeldet (≤ 15 Min.), nicht per PAT/MCP/Karte | dito | dito | dito | dito |
| Vollmachten: Versammlung und Weisung (Freitext) beim Erteilen; „Mich betreffend“ auch als Person oder Verwaltungsfirma | — | 👁 mich betreffend | ✅ | dito | dito | ✅ | ✅ |
| Vollmachten: „Wer vertritt wen“ je Versammlung (mit Wertquote, ohne Stimmenzählung) | — | — | — | (R `vollmachten` lesen) 🅢 | (R `vollmachten` lesen) 🅢 | 👁 alle | 👁 alle |
| Vollmachten der STWEG sehen | — | — | — | (R `vollmachten` lesen, Vorgabe) 🅢 | (R `vollmachten` lesen) 🅢 | 👁 alle | 👁 alle |
| Vollmachten: IP, User-Agent, Authentik-Kennung der Geber | — | — | — | — | — | 👁 | 👁 |
| Vollmachten: KI-Prüfung (PDF geht an OpenRouter/Anthropic, nur auf Knopfdruck) | — | — | — | — | (R `vollmachten` lesen) 🅢 | ✅ | ✅ |
| Vollmachten: Personensuche (Name, E-Mail) | — | — | 👁 🅢 | 👁 🅢 | (R) 🅢 | 👁 alle | 👁 alle |
| Vollmacht-Vorlagen anlegen, ändern, löschen | — | — | — | ✅ nur Vorlagen der eigenen STWEG | — | ✅ auch global | ✅ auch global |
| Vollmachten für andere erfassen, Papier-Vollmacht aktivieren | — | — | — | — | (R `vollmachten` schreiben) 🅢 | ✅ | ✅ |
| Vollmachten: Admin-Upload für alle Geber (`?als=admin`) | — | — | — | — | — | ✅ | ✅ |

Öffentliche Projekte (`/api/public/project/:slug`, Entscheid 28.11.2026): Titel, Beschreibung,
Status, Zeitachse und Kandidaten nur mit Name, Webseite, Status – ohne Offertbetrag,
Offertdetails, Bewertung, Kontakte, Notizen und Kommentare. Anhänge nur, wenn sie einzeln als
öffentlich markiert sind (`project_attachments.oeffentlich`, Vorgabe nein); beim Öffentlich-
Schalten werden bisherige Anhänge nicht öffentlich.

### 2.4 Finanzen, Handwerker, Mail

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| Auslagen einreichen, eigene sehen (`auslagen` read) | — | (R) | ✅ eigene | ✅ eigene | (R) 👁 alle 🅢 | ✅ | ✅ |
| Auslagen prüfen/genehmigen | — | — | — | ✅ 🅢 + ohne STWEG, **nicht eigene** | — | ✅ | ✅ |
| Auslagen als ausbezahlt markieren | — | — | ✅ eigene („erhalten“) | — | ✅ 🅢, genehmigte | ✅ | ✅ |
| Entwürfe sehen/ändern | — | nur Ersteller | nur Ersteller | nur Ersteller | nur Ersteller | 👁 | 👁 |
| Beleg-Scan (KI, 30 / Std.) | — | (R) | ✅ | ✅ | (R) | ✅ | ✅ |
| Auslagen-Stundensatz ändern | — | — | — | ✅ | — | ✅ | ✅ |
| Handwerker: Firmen lesen (gemeinsamer Stamm + eigene STWEG) | — | — | — | 👁 🅢 (Vorgabe `handwerker` lesen) | 👁 🅢 | 👁 | 👁 |
| Handwerker: Verträge, Einsätze (mit Kosten), Notfall-Zuordnungen | — | — | — | 👁 🅢 | ✅ 🅢 (Einträge „alle STWEG“ nur lesen) | ✅ | ✅ |
| Handwerker: Firma anlegen | — | — | — | — | ✅ (gehört dann zur eigenen STWEG) | ✅ (auch gemeinsamer Stamm) | ✅ |
| Handwerker: Stammdaten ändern (Name, Adresse, Nummern, Mitarbeiter; protokolliert, Bereich `handwerker`) | — | — | — | — | ✅ Firmen der eigenen STWEG und des gemeinsamen Stamms | ✅ | ✅ |
| Handwerker: Firma archivieren | — | — | — | — | ✅ nur Firmen der eigenen STWEG | ✅ | ✅ |
| Handwerker: Notfall-Arten (Event-Typen) anlegen, ändern, löschen; Firma hart löschen | — | — | — | — | — | ✅ | ✅ |
| Mail schreiben (Freigabe-Outbox, 50 / Std.) | — | — | — | ✅ | (R) | ✅ | ✅ |
| Mail-Empfänger-Stammdaten | — | — | — | 👁 eigene STWEG + STWEG-übergreifende | (R) eigene STWEG | ✅ | ✅ |
| Mail-Outbox ansehen, freigeben, ablehnen | — | — | — | — | — | ✅ freigeben nicht die eigene/selbst bearbeitete | ✅ freigeben nicht die eigene/selbst bearbeitete |
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
| Überschuss, LaMetric, Shelly, Solar live, Tarife, Strompreis je Haus (`/tarif`), Anlagen (`/anlagen`) | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| Eigene Zähler (persönlich oder über Gruppe zugeordnet), Verlauf, Export, Warnungen | — | 👁 eigene | 👁 eigene | 👁 eigene | 👁 eigene | 👁 alle | 👁 alle |
| Alle Zähler der eigenen STWEG(s) ohne Technikfelder (STWEG-Sicht, Schlüssel `energie-stweg`) | — | — | — | (R) mit `energie-monitor` | (R) mit `energie-monitor` (Seed: ja) | — (sieht alles) | — (sieht alles) |
| MQTT live `energy/<haus>/<bereich>`, `energy/alerts/<zähler>` | — | 👁 eigene | 👁 eigene | 👁 eigene + STWEG-Sicht | 👁 eigene + STWEG-Sicht | 👁 alle | 👁 alle |
| MQTT `energy/<anlage>/solar/*`, `energy/collector/status` | — | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| Alle Zähler, Zuordnungen, Technikfelder (`energie-config` read) | — | — | — | (R) | (R) | 👁 | 👁 |
| Zähler, Tarife, Zuordnungen ändern (`energie-config` write) | — | — | — | (R) | (R) | ✅ | ✅ |
| Technische Zählerübersicht `/api/zaehler-technik` (Schlüssel `zaehler-technik`) | — | — | eingeschränkt, nur `r9-eigentuemer` | — | eingeschränkt, nur STWEG 3 | 👁 voll | 👁 voll |
| Seite `energie-monitor.html` (Menü) | — | (R) | (R) | (R) | (R) | ✅ | ✅ |

**Abgeleitete Schlüssel für Apps** (`GET /api/auth/me`, `user.permissions` und
`user.energie`; nicht in der Rechteverwaltung einstellbar, sie folgen aus den Regeln
oben – dieselben Prüfungen wie die Routen):

- `energie-monitor: read` – automatisch, wenn der Person Zähler zugeordnet sind (wie bisher).
- `energie-stweg: read` – die STWEG-Sicht greift: Ausschuss oder Verwaltung einer STWEG
  **und** `energie-monitor` in der Rechteverwaltung vergeben. Das automatische
  `energie-monitor` der Zähler-Inhaber zählt dafür nicht. `energie.stweg_sicht` nennt die STWEGs.
- `zaehler-technik: read` – `/api/zaehler-technik` ist offen (Technik, Präsident,
  Verwaltung STWEG 3, `r9-eigentuemer`; `api/lib/zaehler-technik.js`).
  `energie.technik` ist `voll` (Technik, Präsident, `energie-config` read) oder `eingeschraenkt`.
- `energie.verwalten` – `energie-config` (`read`/`write`).

**MQTT-Regeln** (`/api/mqtt/aclcheck`): Menschen lesen nur, schreiben nie (ausser über
Topic-Regeln oder Service-User). Technik/Präsident sind Superuser. Sonst gilt dieselbe
Sicht wie per HTTP (eigene, Gemeinschaft, STWEG-Sicht; `energie-config` read: alles unter
`energy/`); Solarwerte jeder Anlage lesen alle Angemeldeten; `energy/<haus>/ueberschuss/<wohnung>`
nur, wer den Wohnungszähler sieht. Der MQTT-Zugang gilt 12 h, mit Karte/geteiltem
Telefon 30 min, und `DELETE /api/mqtt/token` widerruft ihn beim Abmelden.

Details: [`docs/energie-api.md`](../docs/energie-api.md) Abschnitt 8.

### 2.6 Technik und Betrieb

| Bereich | Anonym | Bewohner/Mieter | Eigentümer | Ausschuss | Verwaltung | Technik | Präsident |
|---|---|---|---|---|---|---|---|
| ISP: eigene Reverse-Proxy-Einträge, Weiterleitungen, Mail-Relays | — | ✅ eigene, Freigabe durch Admin | ✅ eigene | ✅ eigene | ✅ eigene | ✅ alle | ✅ alle |
| ISP: Haus-WLAN (Passwort, QR) | Gast-WLAN (offen) | ✅ nur wer dort **wohnt**, ab Einzug¹ | nur wenn selbst bewohnt¹ | wie Rolle | — (auch nicht als Wohnungs-Verwalter)¹ | ✅ | ✅ |
| ISP: alle WLAN-Passwörter (Häuser und private Netze) | — | — | — | — | — | 👁 auf Knopfdruck, **protokolliert**² | 👁 dito² |
| ISP: WLAN-Passwort des eigenen Netzes | — | ✅ Antragsteller, Mitnutzer | dito | dito | dito | 👁 fremde: protokolliert² | 👁 dito² |
| ISP: eigener Anschluss ansehen, Geräte-MAC ändern | — | ✅ nur wer dort wohnt, ab Einzug¹ | nur wenn selbst bewohnt¹ | wie Rolle | —¹ | ✅ alle, MAC auch leeren | ✅ dito |
| ISP: eigene VPN-Konten anlegen (max. 10, 10 / Std.) | — | ✅ nur ins VLAN der Einheit, in der man wohnt, ab Einzug¹ | nur wenn selbst bewohnt¹ | wie Rolle | —¹ | ✅ für jede Person, jedes VLAN | ✅ dito |
| ISP: VPN-Konfiguration und QR | — | 👁 eigene (nur Schlüssel vom Server) | dito | dito | dito | 👁 alle, fremde **protokolliert**² | 👁 dito² |
| ISP: VPN-Zugänge sperren, Liste „ohne Wohnsitz“, ISP-Protokoll | — | — | — | — | — | ✅ | ✅ |
| ISP: Netz-Antrag für eine Einheit | — | ✅ Einheit, in der man wohnt¹ | nur wenn selbst bewohnt¹ | wie Rolle | —¹ | ✅ alle | ✅ alle |
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

¹ **Nur Bewohner** (Entscheid Stefan 28.11.2026, `api/lib/isp-zugang.js`): Haus-WLAN,
Anschluss, VPN und Netz-Anträge richten sich allein nach den Wohnungs-Kontakten, nicht
nach den Authentik-Gruppen und nicht mehr nach der Strasse im Profil. „Wohnt“ heisst:
Rolle `mieter` oder `bewohner`, oder `eigentuemer` bei `bewohnt_von = 'eigentuemer'`;
Kontakt nicht archiviert; `gueltig_ab` leer oder erreicht. Nicht bewohnende Eigentümer,
Wohnungs-Verwalter (`verwalter`) und `sonstige` haben keinen Zugriff; künftige Mieter
erst ab dem Einzugsdatum. Reine Parkplatz-Nutzer bekommen das Kooperations-WLAN
(RK-Clients) nach derselben Regel. Eigene Netze (Antragsteller, Mitnutzer) hängen nicht
am Wohnsitz.
**Beim Auszug** (Kontakt archiviert, Rolle oder `bewohnt_von` geändert, Umzug in ein
anderes Haus) sperrt der Abgleich (täglich und kurz nach jeder Kontakt-Änderung) die
VPN-Zugänge der Person: Peer bei wg-control entfernt, Eintrag bleibt mit `gesperrt_am`.
Bei der **Kontolöschung** werden alle VPN-Zugänge der Adresse gesperrt. Zugänge von
Personen, die schon vor dem 28.11.2026 ausgezogen waren oder nie dort wohnten, sperrt
niemand von selbst: sie stehen in `GET /api/isp/vpn-accounts/wohnsitz` (ISP-Admin →
VPN → „Zugänge ohne Wohnsitz prüfen“). `VPN_AUSZUG_SPERREN=aus`: nur melden.
**VPN-Schlüssel:** Das Gerät erzeugt den Schlüssel und schickt nur den öffentlichen
(`public_key`); der Server speichert dann keinen privaten. Ohne ihn erzeugt der Server
den Schlüssel (Rückfall für ältere Geräte, `schluessel = 'server'`, gekennzeichnet).

² **Protokoll:** Sieht Technik oder Präsident alle WLAN-Passwörter (`/api/wifi?alle=1`),
das WLAN-Passwort eines fremden privaten Netzes
(`/api/isp/vlan-requests/:id/wlan-passwort`) oder die Konfiguration bzw. den QR-Code
eines fremden VPN-Zugangs an, entsteht ein Eintrag in `admin_protokoll` (Bereich `isp`,
`GET /api/isp/protokoll`), mit der Karte zusätzlich im Kartenprotokoll
(`admin-mit-karte`) mit Quittung. Gesperrt wird nichts (Regel „Karte wie Schlüssel“).
Die Listen der Netz-Anträge enthalten keine fremden WLAN-Passwörter mehr.
**Filter:** `?nur=meine` an `GET /api/isp/vpn-accounts`, `/vlan-requests` und
`/mailbox-requests` liefert auch Technik und Präsident nur die eigenen (Apps, „Mein Zugang“).

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
- Projekte sind seit 28.11.2026 STWEG-gebunden (Projekte ohne STWEG = Kooperation,
  für alle Eigentümer, Ausschüsse und Verwaltungen lesbar).
- Seit 28.11.2026 STWEG-gebunden: **Handwerker** (`api/lib/handwerker-rechte.js`;
  Verträge, Einsätze, Kosten und Notfall-Zuordnungen je STWEG, „alle STWEG“ und
  Event-Typen nur Technik/Präsident; Firmen mit `handwerker.stweg` NULL bilden den
  gemeinsamen Stamm) und **Grundbuch** (`api/lib/grundbuch-rechte.js`; Spalte
  `grundbuch_anteile.stweg`, je Parzelle von Technik/Präsident zugeordnet).
  Das Telefonbuch zeigt die Handwerker weiter für alle angemeldeten Personen.
- Nicht STWEG-gebunden sind bewusst: Briefe und E-Mail-Archiv.

---

## 4. Besondere Schutzregeln

- **Geschützte Personen:** Personen mit eigenem aktivem Konto oder mit Wohnungen
  ausserhalb der eigenen Ausschuss- bzw. Verwaltungs-STWEGs dürfen nur Technik und
  Präsident umbenennen, umadressieren oder zusammenführen (sonst **409**). Die Person
  ändert ihre Daten selbst im Profil. Dieselbe Regel gilt für Ausschuss und Verwaltung
  (`userCanEditPerson`, `personGeschuetztFuer`, `api/lib/personen-rechte.js`).
- **Zusammenführen** hängt alle Verweise auf die bleibende Person um: Wohnungs-Kontakte,
  Vollmachten (Geber und Bevollmächtigte, auch `vollmachten_vollmachtgeber`),
  Reklamationen, WhatsApp-Nachrichten und Rufgruppen-Mitglieder
  (`PERSONEN_VERWEISE`); vorher setzte das Löschen sie auf NULL.
- **Geburtsdatum und Notiz:** Das Geburtsdatum liefert die API nur Technik/Präsident,
  die Notiz nur Ausschuss und Technik/Präsident. Wer ein Feld nicht sieht, kann es
  auch nicht überschreiben (Werte im Body werden verworfen).
- **Protokoll Objekte und Personen:** Wohnung anlegen/ändern/löschen, Kontakt
  archivieren, Import, Export, Unterschriftenliste erzeugen, Rücklauf erfassen,
  Konten und Gruppen über Kontakte sowie Person anlegen/ändern/zusammenführen stehen
  im `admin_protokoll` (Bereiche `objekte`, `personen`, `verwaltungen`, `grundbuch`),
  mit Karte/QR/Handy zusätzlich im Kartenprotokoll (Karte wie Schlüssel: nur
  protokollieren, nie sperren).
- **Unterschriftenlisten:** Aufbewahrung 10 Jahre ab Erzeugung
  (`api/lib/unterschriftenliste-frist.js`, täglich 04:20); danach werden Liste,
  Rückläufe und PDF gelöscht. Der öffentliche Abruf per Hash bleibt bis dahin
  unverändert (Entscheid 21.11.2026).
- **Kontakte:** Eine `person_id` aus dem Formular wird verworfen; wechselt die E-Mail
  an einer Kontaktkarte (Mieterwechsel), hängt der Server den Kontakt an eine eigene
  Person. E-Mail oder Telefon, die einer anderen Person oder einem Konto gehören →
  **409**.
- **Auslagen:** Keine Selbstgenehmigung; Entwürfe sieht und ändert nur der Ersteller
  (und Technik/Präsident lesend); Positionen nur bis „eingereicht“.
- **Automatisches Löschen von Konten** nach Auszug nur, wenn **alle** Gruppen des
  Kontos Bewohner/Eigentümer dieser STWEG sind; storniert, sobald die Adresse wieder
  aktiver Kontakt ist. Konten mit weiteren Gruppen stehen in der Liste „manuell zu
  prüfen“. Nach der Löschung entfernt der Nachlauf auch Anlage-Daten, Nextcloud-Konto,
  zugeordnete Mailbox und Karten; Personen-Stammdaten und archivierte Kontakte werden
  3 Monate nach Auszug bzw. Löschung gelöscht bzw. anonymisiert
  ([`docs/konto-loeschung.md`](../docs/konto-loeschung.md)).
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

### 5.3 Präsident und `/api/zaehler-technik` (erledigt)

Früher liess `requireZaehlerTechnik` den Präsidenten nicht durch. Seit Befund W19
kommt er hinein und hat dort die volle Sicht wie die Technik. Die Regel steht in
`api/lib/zaehler-technik.js` (Technik, Präsident, Verwaltung STWEG 3, `r9-eigentuemer`).

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
