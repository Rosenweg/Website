# Berechtigungsstufen — Rosenweg STWEG-Plattform

Stand: 2026-05-22 · Quellen: Authentik-Gruppen + DB-Tabelle `permissions` + Code-Checks in `api/server.js`.

## Rollen-Übersicht

Authentifizierung via Authentik (OIDC). Die Rollen sind reine Gruppen-Memberschaften — eine Person kann mehrere haben. **Wichtig:** Die Gruppe `Präsident` wird mit Umlaut geschrieben.

| Rolle | Authentik-Gruppe(n) | Wer das ist |
|---|---|---|
| **Technik** | `technik` | Stefan (IT-Verantwortlicher) — voller Admin-Zugriff |
| **Präsident** | `Präsident` | Vorstands-Präsident — analog Technik, plus Repräsentation |
| **Verwaltung** (Firma) | `Verwaltung` (aktuell **kein User in dieser Gruppe** — siehe unten) | Externe Hausverwaltung als Firma. Mail-Empfänger-Rolle, kein Web-Login |
| **Verwalter** (Person) | — (keine Authentik-Gruppe, nur DB-Eintrag in `verwaltungs_kontakte`) | Konkreter Sachbearbeiter der Verwaltungs-Firma (Funktion: "Verwalter", "Buchhaltung", "Sekretariat") — nur als Mail-Empfänger gepflegt |
| **Ausschuss** | `ausschuss` (generisch) + `stwegN-ausschuss` (pro STWEG 1–8) | Ausschuss-Mitglieder pro STWEG — operatives Tagesgeschäft |
| **Eigentümer** | `eigentuemer` + `stwegN-eigentuemer` + `rX-eigentuemer` (Rosenweg-Hausnummern) | Wohnungsbesitzer — sieht eigene Daten + STWEG-übergreifend lesend |
| **Bewohner** | `bewohner` + `stwegN-bewohner` + `rX-bewohner` | Mieter / nicht-besitzende Bewohner — eingeschränkter Lesezugriff |

Hierarchie via Authentik-Group-Hierarchy: `r9-eigentuemer` ist automatisch auch in `eigentuemer` (z.B.).

---

## Matrix: Wer darf was

Legende: ✅ Vollzugriff (Write) · 👁 Nur Lesen · — kein Zugriff · 🅢 nur eigener STWEG

| Bereich | Verwaltung | Präsident | Technik | Ausschuss | Eigentümer | Bewohner |
|---|---|---|---|---|---|---|
| **Wohnungsverwaltung** (Kontakte, Wohnungsdaten) | 👁 | ✅ | ✅ | ✅🅢 | 👁 eigene | 👁 eigene |
| **Bewohnerverwaltung** (Personen, Telefon, Adressen) | ✅ | ✅ | ✅ | ✅🅢 (nur stweg3/6 aktuell) | 👁 eigene | — |
| **Auslagen** (Erstellen + Genehmigen) | — | ✅ | ✅ | ✅🅢 (Genehmigen) | 👁 + selbst einreichen | — |
| **Auslagen-Stundensatz** | — | ✅ | ✅ | ✅🅢 | — | — |
| **Reklamationen** | — | ✅ | ✅ | ✅🅢 | (kann melden via WA) | (kann melden via WA) |
| **Mail-Outbox / Approval** | — (Empfänger) | ✅ | ✅ | — | — | — |
| **Mail-Empfänger Verwaltung** | — | ✅ | ✅ | 👁🅢 | — | — |
| **Mail-Compose / Verteiler** | — | ✅ | ✅ | ✅🅢 | — | — |
| **Mail-Templates** | — | ✅ | ✅ | — | — | — |
| **Mail-Approval-Regeln** | — | ✅ | ✅ | — | — | — |
| **Email-Archiv** (gelesen) | — | ✅ | ✅ | 👁🅢 | — | — |
| **E-Mail-Verteiler** (Listen) | 👁 | ✅ | ✅ | — | — | — |
| **Handwerker / Lieferanten** | 👁 | ✅ | ✅ | ✅ (alle ausschuss) | — | — |
| **Handwerker-Verträge** | 👁 | ✅ | ✅ | ✅ (alle ausschuss) | — | — |
| **Verwaltungsverwaltung** (Verwaltungs-Stammdaten) | 👁 | ✅ | ✅ | — | — | — |
| **Energie-Monitor** | 👁 | ✅ | ✅ | 👁🅢 | 👁 (eigene Zähler) | 👁 (eigene Zähler) |
| **Zähler-Konfiguration** | 👁 | ✅ | ✅ | — | — | — |
| **Waschküche** (Reservierung + Sessions) | — | ✅ | ✅ | ✅🅢 (stweg3 only) | ✅ (eigene) | ✅ (eigene) |
| **Waschküche-Admin** (Settings, Türöffnen, Billing) | — | ✅ | ✅ | ✅🅢 (stweg3) | — | — |
| **Dokumente lesen** | (CIFS direkt) | ✅ alle | ✅ alle | ✅🅢 + `allgemein` + `projekte` | 👁 `allgemein` + `scans` + `projekte` + eigene STWEG | 👁 `allgemein` + `scans` + eigene STWEG |
| **Dokumente schreiben** | — | ✅ | ✅ | ✅🅢 + `allgemein` + `projekte` | — | — |
| **Kontakte-Historie** | ✅ | ✅ | ✅ | ✅🅢 | — | — |
| **WhatsApp-Bot Admin** | — | ✅ | ✅ | — | — | — |
| **WhatsApp Opt-In** (eigene Profile) | ✅ selbst | ✅ selbst | ✅ selbst | ✅ selbst | ✅ selbst | ✅ selbst |
| **PBX-Admin** (Telefonanlage, Ring-Group) | — | ✅ | ✅ | — | — | — |
| **Unterschriftenlisten** | — | ✅ | ✅ | ✅🅢 | 👁 eigene | — |
| **Projekte / Budget** | — | ✅ | ✅ | ✅🅢 | 👁 | 👁 |
| **Connection-Log / Audit** | — | ✅ | ✅ | — | — | — |
| **User-Verwaltung Authentik** | — | ✅ (via Sync) | ✅ (Admin) | — | — | — |
| **Rechteverwaltung (permissions)** | — | ✅ | ✅ | — | — | — |

---

## Spezielle Rechte / Sonderfälle

### Technik + Präsident (oberste Stufe)
- Implementiert via Helper `isTechnik(groups)` und `isPraesident(groups)` in `api/server.js`.
- Server setzt `req.user.isAdmin = true` wenn User in einer dieser Gruppen ist.
- **Mail-Outbox-Freigabe:** Beide können Outbox-Mails freigeben (Default 1 von 2 reicht).
- **Volldokument-Zugriff:** Alle CIFS-Ordner (auch fremde STWEGs).
- **WhatsApp-Bot:** Komplette Admin-UI inkl. Broadcast, QR-Re-Pairing.
- **PBX:** Komplette Telefonanlagen-Steuerung (Ring-Group, Geschäftszeiten, Test-Anrufe).

### Verwaltung (externe Hausverwaltung) — Firma als Ganzes
- Reine **Empfänger-Rolle** für alle offiziellen Mails (Auslagen-Auszahlung, Objekt-Änderungen, etc.).
- Aktuell **keine User-Accounts** in der Authentik-Gruppe `Verwaltung` — kein Web-Login.
- Permissions in der DB sind vorbereitet (read auf bewohner-verwaltung, kontakte, verteiler, energie, handwerker, verwaltung, zaehler), greifen aber erst sobald ein User in der Gruppe hinzugefügt wird.
- Kann CIFS-Documents direkt via Samba mounten (separater Mechanismus außerhalb der Web-UI, eigene SMB-Credentials).
- **Wirksamkeit-Datum:** Bei Verwaltungs-Wechsel werden gecachte Mails ab `wirksam_ab`-Datum an die neue Verwaltung umgeleitet (siehe Verwaltungsverwaltung).

### Verwalter (einzelner Sachbearbeiter der Verwaltungs-Firma)
- **Keine Authentik-Gruppe**, sondern Eintrag in DB-Tabelle `verwaltungs_kontakte` mit:
  - `name`, `funktion` (z.B. "Verwalter", "Buchhaltung", "Sekretariat"), `email`, `telefon`
  - Zugeordnet einer `verwaltung_id` (Firma)
- Wird als **Mail-Empfänger** verwendet — alle Outbound-Mails an die Verwaltung gehen an die Email-Adressen aller Verwalter-Kontakte der aktiven Firma.
- Loggt sich nicht im Rosenweg-System ein.
- **UI-Verwaltung:** in der Verwaltungsverwaltung (`verwaltung-admin.html`) — Tech/Präsident kann Verwalter-Personen pflegen.

### Ausschuss (pro STWEG)
- Pro STWEG eigene Gruppe `stwegN-ausschuss` (für N = 1..8).
- **🅢 STWEG-Scope:** Sieht/bearbeitet nur Daten des eigenen STWEGs (Auslagen, Reklamationen, Wohnungsverwaltung, Email-Archiv).
- **Auslagen-Freigabe:** Eigene STWEG-Auslagen genehmigen/ablehnen.
- **Mail-Compose:** Eigene STWEG-Mailings versenden (Verteiler, Ad-hoc).
- **Generische Gruppe `ausschuss`:** zusätzlich Schreibrecht auf Handwerker-Datenbank (STWEG-übergreifend gemeinsam gepflegt).
- **Documents:** eigener STWEG-Ordner + `allgemein` + `projekte` (read+write).

### Eigentümer
- Lesezugriff auf eigene Wohnungsdaten + STWEG-übergreifende Übersichten (Eigentümer-Liste, Grundbuch-Anteile).
- **Auslagen einreichen:** Selbst Vorschüsse einreichen + Status der eigenen sehen.
- **Energie-Monitor:** Eigene Zähler sehen (auto-grant wenn Zähler zugewiesen).
- **Waschküche:** Reservieren + eigene Sessions sehen.
- **Hausnummer-spezifisch:** `r9-eigentuemer` sieht zusätzlich Rosenweg-9-Daten (eigene Liegenschaft).

### Bewohner
- Wie Eigentümer, aber **keine** Auslagen-Einreichung, keine Wohnungsdaten-Bearbeitung.
- Reklamationen melden via WhatsApp-Bot oder Web-Form.
- Eigene Zähler im Energie-Monitor.
- Waschküche-Reservation.

---

## Auto-Granted Permissions

Nicht alle Rechte stehen explizit in der `permissions`-Tabelle — manche sind im Code hartcodiert:

| Trigger | Auto-Gewährtes Recht |
|---|---|
| Hat zugewiesene Energie-Zähler | `energie-monitor: read` |
| In `technik` oder `Präsident` | `isAdmin = true` → alle Endpoints offen |
| In irgendeinem `stwegN-ausschuss` | Schreibrecht auf `bewohner-verwaltung` für stweg3+6 (Legacy) |
| In `eigentuemer` (generisch) | Auslagen-Lesen |
| In `*-ausschuss` | Auslagen-Schreiben für eigenen STWEG |
| In `ausschuss` (ohne Suffix) | Handwerker-Schreiben (STWEG-übergreifend) |

---

## Wie ändert man Berechtigungen?

1. **Gruppe zuweisen:** In Authentik (https://authentik.rosenweg4303.ch) den User in die gewünschte Gruppe legen.
2. **Permission ändern:** Tech/Präsident-User können in der **Rechteverwaltung** (UI: `rechteverwaltung.html`) per Click Toggle setzen — schreibt direkt in `permissions`-Tabelle.
3. **Code-Checks ändern:** Für Sonderfälle (z.B. neue auto-grants) Änderung in `api/server.js` nötig (siehe `requirePermission`, `requireTechnikOrPraesident`, `canManageDocs`, `canViewKontakteHistory`).

---

## Anhang: Aktuelle DB-Einträge (Stand 2026-05-22)

Nur die wichtigsten — vollständige Liste via SQL:
```sql
SELECT group_name, page, access FROM permissions ORDER BY page, group_name;
```

**Spezial-Zuweisungen:**
- `Verwaltung` hat read-Zugriff auf: bewohner-verwaltung, email-verteiler, energie-monitor, handwerker, kontakte, verwaltung, zaehler
- `Präsident` + `technik` haben pbx-admin write
- `stweg3-ausschuss` + `stweg6-ausschuss` haben Sonderrecht bewohner-verwaltung write
- Alle `stwegN-ausschuss` haben write auf: auslagen, auslagen-stundensatz, mail-compose, reklamationen, wohnungsverwaltung
- Alle `stwegN-ausschuss` haben read auf: email-archiv, mail-empfaenger
