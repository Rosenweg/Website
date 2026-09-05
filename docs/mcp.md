# MCP — das Portal für Agenten

`mcp.rosenweg4303.ch` ist die Anwendung, wie ein Agent sie sieht: dieselben
Handlungen wie im Portal, als Werkzeuge nach dem Model Context Protocol
(MCP), Transport Streamable HTTP. Code: `api/mcp/index.js`, eingehängt in
`api/server.js` neben den übrigen Routern.

## Was es ist — und was nicht

Eine **dünne Schicht über der REST-API**. Jedes Werkzeug ruft die API über
die Loopback-Adresse mit dem Token der Person auf. Es gibt keine zweite
Rechteverwaltung: Wer im Portal etwas nicht darf, darf es über den Agenten
auch nicht — die 584 Zugangsregeln der API gelten unverändert. Und es gibt
kein Dienstgeheimnis, das man verlieren könnte.

Der MCP-Server ist **zustandslos**. Pro Anfrage entsteht ein Server mit
genau den Werkzeugen, die die Scopes des Tokens erlauben.

## Ausweis

Ein persönlicher Zugangstoken aus dem Profil (`rw_pat_…`), als
`Authorization: Bearer …`. Die Prüfung ist dieselbe wie für jeden anderen
API-Aufruf (`api/middleware/auth.js`): SHA-256-Ablage, Ablaufdatum,
Widerruf, Scopes.

Ein Token darf nie ändern, womit man sich anmeldet — Passwort, Token,
Passkeys, OAuth, MQTT-Zugangsdaten sind für Token gesperrt
(`PAT_GESPERRT`). Das ist der Grund, warum ein geleakter Token widerrufbar
bleibt.

### Scopes

```
*                      alles, was der Person zusteht
all:read               alles lesen
segment:read|write|*   ein Bereich, z. B. wasch:*, reklamationen:write
segment/unter:…        feiner, z. B. isp/vpn-accounts:read
```

Ohne Scopes hat der Token alle Rechte der Person. `GET` zählt als `read`,
alles andere als `write` — deshalb braucht die Suche (`POST /api/ki-search`)
`ki-search:write`.

## Verbinden

```bash
claude mcp add rosenweg --transport http https://mcp.rosenweg4303.ch \
  --header "Authorization: Bearer rw_pat_…"
```

Für Claude Desktop und andere Clients:

```json
{ "rosenweg": { "type": "http", "url": "https://mcp.rosenweg4303.ch",
                "headers": { "Authorization": "Bearer rw_pat_…" } } }
```

`GET https://mcp.rosenweg4303.ch` ohne Ausweis zeigt die Visitenkarte:
Name, Werkzeuge, Anleitung.

## Frei oder bestätigt

Schreibende Werkzeuge sind nach Wirkung eingeteilt (Entscheid 5.9.2026):

- **frei** — läuft sofort: umkehrbar, betrifft nur die Person selbst, oder
  ein Antrag, den ein Mensch prüft. Waschküche reservieren, Schaden melden,
  Adressmutation, Telefonnummer.
- **bestätigt** — verlangt `bestaetigt=true`; ohne den Parameter kommt eine
  Vorschau zurück und nichts geschieht. Alles, was nach draussen sendet,
  etwas öffnet, löscht, Zugangsdaten erzeugt oder woran die Anmeldung hängt
  (E-Mail-Adressen).

Die Werkzeugbeschreibung trägt das Kennzeichen `[frei]` bzw. `[bestätigt]`
vorne, damit der Agent es sieht, bevor er ruft.

## Werkzeuge (Phase 1 — jede angemeldete Person)

| Werkzeug | Scope | Art |
|---|---|---|
| `profil_lesen` | me:read | liest |
| `profil_aendern` | me:write | frei; E-Mail-Adressen bestätigt |
| `adresse_melden` | me:write | frei (Antrag) |
| `uebersicht` | dashboard:read | liest |
| `reklamation_melden` | reklamationen:write | frei |
| `reklamation_meine` | reklamationen:read | liest |
| `wasch_raeume`, `wasch_belegung`, `wasch_meine_kosten` | wasch:read | liest |
| `wasch_reservieren`, `wasch_stornieren` | wasch:write | frei |
| `zaehler_daten` | zähler:read | liest |
| `zev_rechnungen` | zev:read | liest |
| `dokumente` | documents:read | liest |
| `telefonbuch` | telefonbuch:read | liest |
| `suche` | ki-search:write | liest (POST) |

## Werkzeuge (Phase 2 — nach Rolle)

Liegen in `api/mcp/werkzeuge-verwaltung.js`. Die Rolle entscheidet nur, ob
das Werkzeug in der Liste erscheint (`rolleErlaubt` in `index.js`); die
Rechte prüfen die Handler der API.

| Rolle | Werkzeuge |
|---|---|
| Eigentümer | `projekte`, `projekt_kommentieren` (frei), `grundbuch_anteile`, `einstellplaetze` |
| Ausschuss · Präsidium · Verwaltung | `wohnungen`, `personen_suchen`, `personen_aendern` (frei), `verwaltungen`, `reklamationen_liste`, `reklamation_bearbeiten` (frei), `handwerker`, `handwerker_auftrag` (frei), `auslagen`, `auslage_erfassen` (frei), `zev_verwalten`, `zev_abgleich` (frei), `zev_zuordnen` (frei), `mail_ausgangskorb`, `mail_freigeben` (bestätigt), `mail_verlauf`, `mail_archiv`, `verteiler`, `verteiler_senden` (bestätigt), `mail_schreiben` (bestätigt), `mail_vorlagen`, `briefe`, `wasch_abrechnung`, `wasch_abrechnung_starten` (bestätigt), `zutritt_admin`, `zutritt_tuer_oeffnen_admin` (bestätigt), `benutzer`, `benutzer_gruppe` (bestätigt), `stweg_termin` (frei), `whatsapp_status`, `whatsapp_senden` (bestätigt), `telefonanlage`, `pbx_testanruf` (bestätigt), `isp_antraege`, `isp_antrag_entscheiden` (bestätigt), `stoerung_anlegen` (bestätigt), `rechte` |
| Technik | `noc`, `dienstwacht`, `ssh_matrix`, `stationen`, `pve_meldungen` (frei), `whatsapp_kopplung`, `zaehler_technik`, `proxmox`, `loeschungen`, `anzeige`, `anzeige_ankuendigen` (bestätigt) |

Ausschuss-Rolle heisst: Technik, Präsidium, Ausschuss irgendeiner STWEG oder
Gruppe `verwaltung`. Eigentümer-Rolle: Gruppe `eigentuemer` oder `*-eigentuemer`,
oder alles darüber.

## Ressourcen und Prompts

`api/mcp/erweiterungen.js`. Die Dateien aus `docs/*.md` sind Ressourcen unter
`rosenweg://docs/<name>` — Betriebsinterna (`NUR_TECHNIK`) sehen nur Technik
und Präsidium. Das Dockerfile kopiert `docs/*.md` ins Image.

Fünf Prompts: `reklamation_melden`, `adresse_aendern`, `waschkueche_reservieren`,
`vpn_einrichten`, `vollmacht_versammlung` — je ein Ablauf mit den richtigen
Rückfragen, bevor ein Werkzeug gerufen wird.

## Aufruf-Protokoll

Jeder Werkzeugaufruf steht in `mcp_aufrufe` (wer, Token, Werkzeug, ok,
Dauer, Fehler, Argumente gekürzt auf 300 Zeichen je Wert).
`GET /api/mcp/aufrufe?limit=100` liefert die letzten Einträge — Technik und
Präsidium. Die API-Aufrufe selbst laufen zusätzlich durch den Audit-Kontext
(`pat:<id>`).

Der Ops-MCP für die Infrastruktur ist ein eigener Server in einem eigenen
Repo (Phase 3).

## Neues Werkzeug hinzufügen

Ein Eintrag in `WERKZEUGE` in `api/mcp/index.js`:

```js
{
  name: 'wasch_raeume', pfad: 'wasch', methode: 'GET', frei: true, nurLesen: true,
  titel: 'Waschräume', beschreibung: '…',
  eingabe: { /* zod-Shape */ },
  async lauf(api, args) { return api('GET', '/api/wasch/rooms'); },
}
```

`pfad` und `methode` bestimmen nur, ob das Werkzeug in der Liste
erscheint. Erzwungen wird der Scope beim Loopback-Aufruf — wer den
Eintrag vergisst, bekommt ein Werkzeug, das 403 liefert, nie eines, das
zu viel darf.

## Betrieb

- Der Host `mcp.rosenweg4303.ch` ist ein Reverse-Proxy-Eintrag der
  Anwendung selbst (`isp_reverse_proxy_routes`) auf das core-backend
  (`http://100.64.2.52:3000`), `auth_required = false` — der Ausweis ist
  der Bearer-Token, nicht Authentik. DNS bei Cloudflare.
- An der Wurzel des Hosts wird intern auf `/mcp` umgeschrieben; am
  Hauptportal ist der Server ebenfalls unter `/mcp` erreichbar.
- Jeder Werkzeugaufruf schreibt eine Zeile `[MCP] <person> <werkzeug> ok|fehler`
  ins API-Protokoll; die API-Aufrufe selbst laufen wie gewohnt durch den
  Audit-Kontext (`pat:<id>`).

## Probe von Hand

```bash
T="rw_pat_…"
curl -s https://mcp.rosenweg4303.ch -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
