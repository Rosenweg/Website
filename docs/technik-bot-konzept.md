# Konzept: Technik-Assistent-Bot

> Stand 2026-06-27 · Status: Konzept (vor Bau) · Scope: **NUR Reklamationen** — Eingang via **App/Web-Formular · E-Mail (technik@) · WhatsApp** + selbsttätige Lifecycle-Verwaltung · Autonomie: **klare Fälle selbst, Rest vorschlagen**

## 1. Ziel & Scope

Ein KI-Assistent **ausschliesslich für Reklamationen** (Schadens-/Reparaturmeldungen) — vom
Eingang über **alle drei Wege** bis zur Erledigung:

- **App / Web-Formular** — bestehend: PWA „Reparatur melden" / `POST /api/reklamationen`
- **E-Mail** an den `technik@`-Verteiler (Bot-Mailbox `technikbot@rosenweg4303.ch`)
- **WhatsApp** — Befehl `/reklamation` + **Freitext** (LLM)

Er **handelt bei eindeutigen Fällen selbst** (Kategorie, Zuweisung, Anlegen) und **fragt bei
Unsicherheit nach** (1 Klick/Reply). Jede Aktion ist protokolliert und rückgängig machbar.

**Nicht im Scope** (bewusst): allgemeine Fragen/Smalltalk, Nicht-Reklamations-Mails, sonstige
Technik-Themen. Dafür bleiben der bestehende Command-Bot (`/menu`, `/handwerker`, …) und die
Menschen zuständig. Der Bot mischt sich nur ein, wenn es um eine **Reklamation** geht.

Kein Greenfield: bestehende Komponenten verdrahten + ein LLM davorsetzen.

## 1b. Ist-Zustand & Lücke (warum der Bot) — verifiziert 2026-06-27

Beide Kanäle sind heute **Einbahn-Notification-Friedhöfe**: Meldungen werden *rausgeschüttet*,
aber nichts *versteht* sie oder *schliesst den Kreis*.

- **WhatsApp Technik-Gruppe** (`120363407257445046@g.us`, 132 Nachrichten): praktisch nur
  **outbound System-Posts** (Reklamations-Events, ISP-Outbox, Bot-Menü) — teils **doppelt**
  (Rauschen, eigener Bug). **Kein Rückkanal:** schreibt jemand „erledigt" oder eine Frage,
  passiert nichts (Freitext wird nicht beantwortet).
- **E-Mail `technik@`** (Verteiler #11 „Technischer Dienst"): eingehende Mail wird nur an die
  Menschen **gefanned-out**; niemand/nichts liest, kategorisiert oder verfolgt sie. Outbound =
  reine Notifications (`reklamation-eroeffnet`, …). **Exakt dasselbe Muster wie WhatsApp.**
- **Folge:** Triage + Lifecycle hängen komplett am Menschen. **Worked Example #2 (R13):**
  „Licht-Bewegungsmelder kaputt … Treppenabgang→Garage UG Rosenweg 13" lief als **`sonstige`**
  rein (falsch), wurde von Hand zugewiesen, hing seit 26.06. **offen** ohne Chat-Reaktion.
  → *Live-Demo 2026-06-27: Kategorie auf **Licht** korrigiert — genau diese semantische Auto-Triage
  macht der Bot automatisch.*

**Die Lücke, die der Bot füllt — für WhatsApp UND E-Mail gleichermassen:**
1. **Verstehen** eingehender Meldungen → Kategorie/Zuweisung (semantische Auto-Triage)
2. **Rückkanal**: Antworten/Aktionen aus Chat *und* Mail fliessen in den Reklamations-Lifecycle
3. **Nachfassen** bei Stillstand (kein Eskalieren)
4. **Entrauschen**: Reklamations-Notifications konsolidieren/deduplizieren statt N Einzel-Posts

## 2. Bestehende Bausteine (Wiederverwendung)

| Baustein | Wo | Nutzung im Bot |
|---|---|---|
| Reklamationen-API + DB | `api/server.js`, Tabellen `reklamationen`, `reklamation_events`, `reklamation_auto_assign` | Anlegen, Kategorisieren, Zuweisen, Verlauf |
| Auto-Zuweisung + Notify | `autoAssignReklamation`, `notifyReklAssignee` | Verantwortliche automatisch benachrichtigen |
| WhatsApp-Gateway | `api/lib/whatsapp.js` (`queueWhatsappMessage`, `resolveTechnikWhatsappGroupId`), Bot CT116, Gruppe `120363407257445046@g.us` | Empfangen + Senden in der Gruppe |
| WhatsApp-Command-Handler | `handleWhatsappCommand(person, body)` in server.js | Einstiegspunkt für Gruppen-/Direkt-Nachrichten |
| E-Mail: technik@-Verteiler | Mailcow-Alias (Native-Fanout), PMG, IMAP-Archivierung | Intake-Quelle |
| Mail↔WhatsApp-Bridge | `wa_forwards`, bestehende Bridge | Mail→Gruppe-Posting |
| Mail-Versand | `sendTemplated()`, `MAIL_FROM` | Antwort-Entwürfe/-Versand |
| LLM | OpenRouter-Key (bereits für Voicemail-KI), `transcribe_voicemail.py` | „Gehirn" |

Es fehlt nur die **Orchestrierungs-/Gehirn-Schicht**.

## 2b. Der Bot ergänzt Bestehendes (nicht ersetzen) — verifiziert

Bereits vorhanden und wird 1:1 weiterverwendet:

- **WhatsApp-Inbound** `POST /api/whatsapp/inbound` (Bot CT116 → API) → `handleWhatsappCommand`,
  Outbound via `whatsapp_messages`-Queue + `/api/whatsapp/outbox-poll`. Bestehende Befehle
  bleiben **unverändert**: `/menu`, `/notfall`, `/handwerker [kat]`, `/meineauslagen`,
  `/reklamation <text>`, `/hilfe`.
  → **Ergänzung:** Freitext, der KEIN `/`-Befehl ist, bekommt heute **keine Antwort** —
  genau hier hängt sich der **LLM-Fallback** ein („Whatsapps sinnvoll beantworten"). Deterministische
  Befehle behalten Vorrang.
- **E-Mail-Inbound** `POST /api/email/inbound` + Verteiler-Dispatch (`resolveVerteilerRecipients`,
  `email_verteiler`) existieren.
  → **Ergänzung:** `technikbot@rosenweg4303.ch` als **Mitglied im `technik@`-Verteiler** →
  erhält jede technik@-Mail mit → LLM-Klassifikation → Reklamation/Antwort.
- **LLM via OpenRouter ist bereits produktiv** (`anthropic/claude-haiku-4.5` in Grundbuch-OCR
  `api/routes/grundbuch.js` + KI-Suche `api/server.js`). → Bot nutzt **denselben Pfad/Key** —
  kein neues Infra, Datenschutz-Präzedenz vorhanden.
- **Reklamationen** (Anlegen/Kategorie/Zuweisung/Verlauf/Notify) + **Auto-Zuweisung** +
  **Handwerker-DB** sind die „Hände" des Bots.

**Kern:** Der Bot ist im Wesentlichen eine **LLM-Verstehens-/Fallback-Schicht in zwei
bestehende Endpoints** (`/api/whatsapp/inbound`, `/api/email/inbound`) + ein Cron für die
Lifecycle-Pflege. Nichts Bestehendes wird ersetzt.

## 3. Architektur

Neues Modul **`api/lib/technik-bot.js`** in der API (CT128) — sie hat bereits Reklamationen,
WhatsApp-Queue, Mail-Hooks und OpenRouter-Zugang. Kein separater Server nötig.

```
                ┌─────────────── INBOUND ───────────────┐
 WhatsApp-Gruppe ─┐                                      │
 technik@-Mail ───┼─→ technik-bot.js ──→ LLM (OpenRouter)│
 Reklam.-Events ──┘        │   (verstehen/klassifizieren/│
                           │    entwerfen, mit Confidence)│
                           ▼                              │
                  Entscheidung: klar? ──ja──→ AKTION ─────┤→ Reklamation anlegen/
                           │                              │  Kategorie/Zuweisung,
                           └─unsicher─→ VORSCHLAG ─────────┤  WhatsApp-Post, Mail-Entwurf
                                       (Gruppe, 1-Klick)   │
                  jede Aktion → bot_actions (Audit) + „↩ rückgängig"
```

**Inbound-Wege:**
- WhatsApp-Gruppe: Der Bot empfängt Gruppennachrichten bereits (Gateway → API). Neuer Hook
  im Command-Handler: erkennt @-Mention / Schlüsselwörter / freie Sprache.
- E-Mail: `technik@` zusätzlich auf eine **Bot-Mailbox** fanouten (oder IMAP-Poll wie die
  bestehende Archivierung), neue Mail → `technik-bot.js`.
- Reklamations-Events: bestehende Hooks beim Anlegen (für Auto-Kategorie/-Zuweisung).

## 4. Kanal 1 — WhatsApp-Gruppen-Assistent

**Auslöser:** @-Mention/Präfix oder erkannte **Reklamations-Absicht**. **Nur reklamationsbezogen** —
themenfremde/allgemeine Nachrichten ignoriert der Bot (kein Open-Domain-Chat).

**Kann (lesend, immer erlaubt):**
- Status beantworten: „Wie viele offene Meldungen?", „Status Aufzug?", „Wer hat #12?"
- Offene/überfällige Fälle als **Digest** posten (auch als Tages-Cron, z.B. 07:30)
- Lange Threads / weitergeleitete Mails **zusammenfassen**

**Kann (handelnd):**
- **Meldung aus einer Gruppennachricht anlegen**: „Bewegungsmelder Treppe→Garage RW13 kaputt"
  → Reklamation #X mit Kategorie-Vorschlag, postet „✅ #X angelegt (Kategorie: Licht) · ↩ rückgängig"
- Status setzen / zuweisen auf Zuruf („#12 an Andreas") — *bei klarer Referenz selbst, sonst Rückfrage*

**Beispiel-Dialog:**
```
[Gruppe] Stefan: Im UG RW13 flackert das Licht beim Bewegungsmelder
[Bot]    🔧 Klingt nach einer Meldung. Angelegt: #18 · Kategorie Licht · STWEG 6
         Auto-zugewiesen an Andreas (Regel). ↩ rückgängig | ✏️ ändern
```

## 5. Kanal 2 — E-Mail-Intake `technik@`

**Postfach:** eigene Bot-Mailbox **`technikbot@rosenweg4303.ch`**, eingetragen als **Mitglied
im `technik@`-Verteiler** → der Bot bekommt jede technik@-Mail mit, ohne den bestehenden
Verteiler-Fanout an die Menschen zu stören. Eingang über das bestehende `POST /api/email/inbound`.

**Pipeline:** eingehende Mail → LLM klassifiziert (Schadensmeldung? Rückfrage? Info? Spam?)
+ extrahiert (Ort, Kategorie, Dringlichkeit, Melder) **mit Confidence**.

- **Klar = Schadensmeldung (hohe Confidence):** → Reklamation **automatisch anlegen**
  (Melder via Absender-E-Mail auf `personen` matchen), **Kurz-Zusammenfassung in die Gruppe**
  posten, optional Eingangsbestätigung an den Absender (Entwurf/automatisch — Entscheid in §6).
- **Unsicher:** → Vorschlag in die Gruppe: „📧 Mail von X: '…' — Meldung anlegen? [Ja] [Nein]".
- **Keine Meldung (Info/Werbung):** nur als Zusammenfassung posten oder ignorieren.

Antwort-Entwürfe an den Absender werden generiert; **Versand an Bewohner = immer bestätigen**
(siehe Guardrails).

## 5b. Kanal 3 — Selbsttätige Reklamations-Verwaltung (Lifecycle)

Der Bot **begleitet jede Meldung über ihren ganzen Lebenszyklus** und schiebt sie proaktiv
voran (Cron alle paar Stunden über offene Meldungen + ereignisgesteuert bei neuen Events).

- **Triage-Vervollständigung:** offene Meldung ohne Kategorie/Zuweisung → Kategorie + (Regel-)
  Zuweisung *bei klarem Fall selbst setzen*, sonst vorschlagen.
- **Weiterleitung erkennen:** Verlauf/Chat „an Handwerker X weitergeleitet / Termin Di" →
  Status `weitergeleitet` + Handwerker verknüpfen, Notiz in den Verlauf.
- **Erledigung erkennen:** aus Chat/Mail/Verlauf („war da, repariert", „läuft wieder") →
  **Status `erledigt` vorschlagen** (nie autonom schliessen) + optional Melder-Bestätigung.
- **Nachfassen (KEIN Eskalieren):** keine Aktivität seit *N* Tagen (N je Dringlichkeit) →
  freundliche Erinnerung an den Zuständigen in der Gruppe; bei externem Handwerker →
  **Nachfass-Mail-Entwurf**. *Bewusst keine Eskalation* (kein „Hochmelden", keine Fristen-Alarme).
- **Priorität:** dringende Kategorien (Wasser/Strom/Aufzug) → früher nachfassen.
- **Close-Loop:** vor dem Schliessen optional den Melder fragen „behoben?" (nutzt das
  Melder-Self-Service-Archiv).
- **Konsolidierung:** Duplikate erkennen → Zusammenführen vorschlagen.
- **Report:** Tages-/Wochenübersicht offener Fälle nach Alter/Priorität/Zuständig in die Gruppe.

Autonomie hier: Erinnerungen/Verlaufs-Notizen/`weitergeleitet`/Kategorie = **selbst** (klar);
**Schliessen, Abweisen, Bewohner-Mail, externe Zuweisung = Vorschlag/Bestätigung**.

## 5c. Resolver-Spec — Erledigung aus dem Chat (strukturiert)

Erkennt der Bot eine Reklamation im Gruppen-Chat als erledigt, extrahiert er **strukturiert**
(LLM → JSON) und schreibt NICHT nur den Status, sondern den **echten Vorgang**:

    { "erledigt": true, "confidence": 0.96,
      "arbeitsschritt": "Bewegungsmelder ersetzt – funktioniert wieder",
      "ausgefuehrt_von": "Andreas De Bona",
      "zeitpunkt_iso": "2026-06-27T14:13:48Z",
      "evidence": "woertliches Chat-Zitat",
      "melder_nachricht": "kurze freundliche Nachricht an den Melder" }

Daraus entstehen **zwei** Verlaufseinträge (statt nur Status-Flip):
1. **Arbeitsschritt** — `who = ausgefuehrt_von`, `event = "🔧 <arbeitsschritt>"`,
   `created_at = zeitpunkt_iso` (echte Chat-Zeit) → die History zeigt die **Reparatur**.
2. **Erledigt-Vermerk** (Technik-Bot, mit confidence).

Plus: Status → `erledigt`; **Melder-Nachricht nur als Entwurf** (nicht autonom versenden);
Apply nur bei `confidence ≥ 0.8`. Endpoint: `POST /api/technik-bot/resolve/:id?apply=1`.
Diese Arbeitsschritte sind für den Melder sichtbar (PWA „Meine Meldungen" → Verlauf, owner-scoped).

## 6. Autonomie-Modell „klare Fälle selbst"

LLM liefert **strukturierte Ausgabe mit `confidence` (0–1)** + `action`. Schwellen + Whitelist:

| Aktion | Autonom ab Confidence | sonst |
|---|---|---|
| Reklamation aus Mail/WhatsApp anlegen | ≥ 0.8 | Vorschlag in Gruppe |
| Kategorie setzen | ≥ 0.8 | Vorschlag |
| Auto-Zuweisung anwenden (bestehende Regel) | immer (deterministisch) | — |
| Status `weitergeleitet` | ≥ 0.85 | Vorschlag |
| Digest/Report posten | immer | — |
| Erinnerung/Nachfass in Gruppe posten | immer | — |
| Verlaufs-Notiz hinzufügen | immer | — |
| **Status `erledigt`/`abgewiesen`** | **nie autonom** | Vorschlag + ggf. Melder-Bestätigung |
| **Nachfass-Mail an Handwerker** | **nie autonom** | Entwurf + Bestätigung |
| **Duplikate zusammenführen** | **nie autonom** | Vorschlag |
| **E-Mail an Bewohner senden** | **nie autonom** | immer Entwurf + Bestätigung |
| **Externen Handwerker zuweisen** | **nie autonom** | Vorschlag |

**Guardrails:**
- **Audit-Log** `bot_actions` (was, warum, confidence, Quelle, rückgängig-bar) — jede Aktion
  zusätzlich als Gruppen-Post mit **„↩ rückgängig"** (Zeitfenster z.B. 10 Min).
- **Rate-Limit** (max N Auto-Aktionen/Stunde) als Runaway-Schutz.
- **Kill-Switch**: `technik_bot_enabled` in einer settings-Tabelle (sofort aus).
- **Idempotenz/Doppel-Erkennung**: vor Anlegen gegen offene Meldungen prüfen (LLM + Heuristik)
  → „ähnlich wie #14, trotzdem anlegen?".

## 7. LLM & Kosten

- **Modell:** via OpenRouter, günstiges aber gutes Klassen-Modell (z.B. Claude Haiku /
  GPT-4o-mini-Klasse) für Klassifikation/Extraktion; ggf. stärkeres Modell nur für Entwürfe.
- **Strukturierte Ausgabe** (JSON-Schema: `{kategorie, stweg, dringlichkeit, ist_meldung,
  confidence, zusammenfassung, antwort_entwurf}`).
- **Kosten:** ~1–2k Token rein / ~0.5k raus pro Mail/Nachricht → **Bruchteile eines Rappens**;
  selbst mehrere hundert Vorgänge/Monat = wenige Franken. Vernachlässigbar.

## 8. Datenschutz / DSGVO

- Das LLM sieht Bewohner-Daten (Name, Adresse, Meldungstext). **Datenminimierung:** nur das
  Nötige senden; wo möglich pseudonymisieren (z.B. „Bewohner aus STWEG 6" statt Klarname).
- **Keine Klarnamen in öffentlichen/halböffentlichen Kontexten** (Gruppen-Posts) ohne Not.
- Option für später: **EU-/selbst-gehostetes Modell** (z.B. lokales Ollama/vLLM) für volle
  Datenhoheit — Architektur ist modell-agnostisch (nur Endpoint tauschen).
- **AVV/Transparenz:** im Rahmen der bestehenden OpenRouter-Nutzung (Voicemail-KI) klären/
  dokumentieren.

## 9. Datenmodell (neu)

```sql
CREATE TABLE technik_bot_actions (
  id SERIAL PRIMARY KEY,
  source        VARCHAR(20),    -- 'whatsapp' | 'email' | 'reklamation'
  source_ref    VARCHAR(200),   -- msg-id / mail-uid / reklamation-id
  action        VARCHAR(40),    -- 'create_reklamation' | 'set_kategorie' | 'suggest' ...
  payload       JSONB,
  confidence    NUMERIC(3,2),
  autonomous    BOOLEAN,        -- selbst gehandelt vs. nur vorgeschlagen
  reverted      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
-- + settings-Key technik_bot_enabled (Kill-Switch)
```

## 10. Phasenplan

- **Phase 0 — dieses Konzept** (✓)
- **Phase 1 — lesend + Digest (risikolos):** Bot beantwortet Status-Fragen in der Gruppe +
  Tages-Digest offener Reklamationen. Keine Mutationen. Vertrauen aufbauen.
- **Phase 2 — E-Mail-Intake:** technik@-Mails klassifizieren → klare Schadensmails **autonom**
  als Reklamation anlegen + Gruppen-Zusammenfassung; unsichere als Vorschlag. Audit + Undo.
- **Phase 3 — WhatsApp-Aktionen:** Meldung aus Gruppennachricht anlegen, Kategorie/Zuweisung
  auf Zuruf (klare Fälle selbst).
- **Phase 4 — Selbsttätige Lifecycle-Verwaltung (Kanal 3):** Cron über offene Meldungen —
  Triage-Vervollständigung, `weitergeleitet`-Erkennung, Nachfass/Eskalation, Erledigung
  *vorschlagen*, Tages-Report.
- **Phase 5 — Entwürfe & Feinschliff:** Antwort-Entwürfe an Melder (mit Bestätigung),
  Doppel-Erkennung/Konsolidierung, Close-Loop-Bestätigung, Priorisierungs-Feintuning.

## 11. Risiken & Mitigation

| Risiko | Mitigation |
|---|---|
| Falsch-Positiv (unnötige Meldung) | Confidence-Schwelle, Doppel-Erkennung, „↩ rückgängig", Audit |
| Falsch an Bewohner kommuniziert | Bewohner-Mail nie autonom; immer Entwurf + Bestätigung |
| Bot-Spam in der Gruppe | Rate-Limit, nur auf Auslöser/Mention, kompakte Posts |
| LLM-Ausfall/Halluzination | Fail-safe = nichts tun + an Mensch eskalieren; deterministische Pfade bevorzugen |
| Datenschutz | Minimierung, Pseudonymisierung, Option EU-/Self-Hosted-Modell |

## 12. Entscheide

**Festgelegt (2026-06-27):**
- Mail-Weg: eigene Mailbox **`technikbot@rosenweg4303.ch`** als **Mitglied im `technik@`-Verteiler**. ✓
- WhatsApp: Freitext **sinnvoll per LLM beantworten** (Befehle behalten Vorrang). ✓
- Lifecycle: **Nachfassen ja, Eskalieren nein**. ✓
- Modell: **OpenRouter `claude-haiku-4.5`** (wie bestehend) zum Start. ✓
- Grundprinzip: **bestehende Funktionen ergänzen, nichts ersetzen**. ✓

**Noch offen:**
1. Eingangsbestätigung an Melder bei Auto-Anlage: automatisch (still) oder nur Entwurf zur Freigabe?
2. Bot-Auslöser in der Gruppe: nur bei **@-Mention/Präfix**, oder **„immer mitlesen + bei Bedarf antworten"**?
