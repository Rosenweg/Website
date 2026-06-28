# Konzept: Aufwand-Erfassung vereinheitlichen + Quittungs-Scanner (PWA)

Status: **Planung** (noch nicht gebaut). Stand 2026-06-28.

## 0. Kernerkenntnis: es ist schon ein System

Arbeitszeiterfassung und Auslagen teilen sich **dieselbe Tabelle `auslagen`**:
- PWA „Arbeit" (`pwa/arbeit/`) erzeugt `auslagen`-Zeilen mit `kategorie='Arbeitszeit'`,
  Betrag = Stunden × Stundensatz, dazu eine Position `position_typ='arbeitszeit'`.
- `auslagen.html` = Desktop-Verwaltung derselben Daten (alle Kategorien, Review, Auszahlung).
- Vorhandene Bausteine: `auslagen` (Status-Workflow eingereicht→genehmigt→ausbezahlt,
  + `entwurf` aus Reklamation), `auslagen_positionen` (gemischte Typen: arbeitszeit/material/…),
  `auslagen_belege` (Multi-Beleg), `reklamation_id` (Verknüpfung), `/api/auslagen/scan-beleg` (KI-Vision).

**Folge:** Es braucht **keine Daten-Migration** und kaum neues Backend. Die „Vereinheitlichung"
ist primär eine **UI-Konsolidierung** + der Quittungs-Scanner in der PWA.

## 1. Zielbild

Aus der PWA „Arbeit" wird **„Aufwand erfassen"**: ein Eintrag = mein Aufwand für eine Sache,
bestehend aus beliebiger Kombination von **Zeit** (Stundensatz) und **Material/Spesen** (Quittungen),
mit **mehreren Belegen**, optional **an eine Reklamation gehängt** — eine Einreichung, eine Genehmigung.

`auslagen.html` bleibt die **Desktop-/Verwaltungssicht** (Review, Auszahlung, Korrektur).

## 2. Entscheidungen (vom Auftraggeber)

1. **Kategorie flexibel** — Auswahl statt fix; pro Auslage (und perspektivisch pro Position):
   Material, Reparatur, Verpflegung, Reisekosten, Porto/Versand, Reinigung, Arbeitszeit, Sonstiges
   (= bestehende `AUSLAGEN_KATEGORIEN`).
2. **Anhängbar** — eine Quittung kann an einen **bestehenden Eintrag** (dieselbe Auslage:
   weitere Position + weiterer Beleg) **oder an eine Reklamation** (`reklamation_id`) gehängt werden,
   statt immer eine separate Spesen-Auslage zu sein.
3. **Mehrere Belege** — pro Auslage kumulierbar (`POST /api/auslagen/:id/belege`, mehrfach).
4. **Offline-Puffer** — Pflicht (siehe §5).

## 3. Datenmodell — was fehlt?

Strukturell fast nichts. Zu prüfen/ergänzen:
- `auslagen_positionen.kategorie` (heute Kategorie nur auf Auslage-Ebene) — optional, falls
  „Kategorie pro Position" gewünscht. Für v1 reicht Kategorie auf Auslage-Ebene.
- Betrag-Logik: Auslage-`betrag_chf` = Summe aller Positionen (Zeit + Material). `updatePosTotal`
  macht das in auslagen.html bereits; in der PWA analog.

## 4. PWA-Plan „Aufwand erfassen"

**Modi:** ⏱️ Stoppuhr · ✏️ Manuell (Zeit) · **📷 Quittung** (neu).
Gemeinsam: Datum, STWEG, gemerkte IBAN, „Meine"-Liste, Erfolgs-Screen, Auth.

**Quittungs-Flow:**
1. Foto: `<input type="file" accept="image/*" capture="environment">` (Handy-Kamera; PDF/Galerie auch).
2. **Downscale im Browser** (Canvas, ~1600px, JPEG ~0.8) vor Upload — wegen 15-MB-Limit/Tempo;
   HEIC (iPhone) → JPEG konvertieren.
3. KI-Scan `POST /api/auslagen/scan-beleg` → Datum, Lieferant→Beschreibung, Positionen, Total, Währung.
4. **Plausi-Check** (wie auslagen.html): Positionssumme vs. KI-Total → Warnung bei Abweichung.
5. **Ziel wählen:** „neue Auslage" | „an letzten/offenen Eintrag anhängen" | „an Reklamation #…".
6. Einreichen über bestehende Endpoints (keine neuen):
   - neu: `POST /api/auslagen` (kategorie wählbar, betrag=Total, datum, beschreibung, stweg, iban, ggf. reklamation_id)
   - anhängen: bestehende `:id` verwenden
   - dann `POST /api/auslagen/:id/belege` (Foto + Währungs-/Kursinfo) und Positionen ergänzen.

## 5. Offline-Architektur (Pflicht)

KI-Scan braucht Netz → Belege müssen offline **gepuffert** werden:
- Aufnahme offline → Bild + Metadaten in **IndexedDB** („Ausstehend") ablegen.
- Bei Online (Event `online` / App-Start / Background-Sync) Queue abarbeiten:
  Scan → Auslage anlegen/anhängen → Beleg hochladen → Position setzen.
- UI: Badge „⏳ wartet auf Upload (n)" + manueller „Jetzt senden"-Knopf; Idempotenz pro Queue-Eintrag.
- Gilt sinnvollerweise auch für die **Zeit-Einträge** (Manuell/Timer) → robust bei Funkloch.
- Service-Worker cached `/api/` nicht (Live) — bleibt so; Queue ist App-Logik, nicht SW-Cache.

## 6. UI-Konsolidierung (die größere Frage)

- **Kurzfristig:** PWA „Arbeit" → „Aufwand" mit Quittungs-Modus; auslagen.html unverändert (Verwaltung).
- **Mittelfristig:** „Meine Auslagen"-Liste in der PWA zeigt **alle** Kategorien (Zeit + Spesen) gemeinsam,
  inkl. Entwürfe aus Reklamationen (die bereits in `auslagen` liegen). Ein Ort für „mein Aufwand".
- **Optional:** Launcher-Kachel „Arbeit" → „Aufwand"; Begriffe vereinheitlichen.

## 7. Aufwand / Phasen

- **P1 (Frontend):** Quittungs-Modus + Scan + Plausi + Submit (neue Auslage). ~½ Tag inkl. Handy-Test.
- **P2 (Frontend):** Anhängen an bestehenden Eintrag/Reklamation; Mehr-Beleg-UI; Kategorie-Auswahl. ~½ Tag.
- **P3 (Frontend):** Offline-Queue (IndexedDB) für Quittung + Zeit. ~1 Tag.
- Kein Build/Backend nötig (Endpoints existieren); Deploy nur `pwa` (CT130).
  Ausnahme: falls „Kategorie pro Position" → kleine Backend-Erweiterung.

## 8. Offene Punkte

- „Anhängen": an **welche** bestehenden Einträge? (nur eigene, Status `entwurf`/`eingereicht`, letzte N?)
- Kategorie pro **Position** vs. pro **Auslage** (v1: pro Auslage).
- Soll Offline-Queue auch Zeit-Einträge umfassen (empfohlen: ja).
- Begriff/Branding der PWA („Aufwand" vs. „Arbeit & Spesen").
