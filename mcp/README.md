# Rosenweg MCP-Server

MCP-Server fuer die Rosenweg-Website. Ermoeglicht KI-Agents (Claude Desktop, Cursor, Hermes, OpenClaw, ...) im Namen eines Users zu handeln — mit dessen Rechten, jederzeit widerrufbar.

## Setup

### 1. Personal Access Token (PAT) erstellen

Login auf https://www.rosenweg4303.ch/profil.html → Section "🔑 API-Tokens" → "+ Neuen Token erstellen". Name vergeben (z.B. "Claude Desktop"), optional Ablauf + Scopes setzen. **Token wird nur einmal angezeigt — kopieren und sicher aufbewahren.**

### 2. Installation

```bash
cd mcp/
npm install
```

### 3. Konfiguration im Agent

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) bzw. `%APPDATA%\Claude\claude_desktop_config.json` (Win):

```json
{
  "mcpServers": {
    "rosenweg": {
      "command": "node",
      "args": ["/PFAD/ZU/Website/mcp/src/index.js"],
      "env": {
        "ROSENWEG_API": "https://www.rosenweg4303.ch",
        "ROSENWEG_TOKEN": "rw_pat_XXXXXXXXXXXX..."
      }
    }
  }
}
```

Anschliessend Claude Desktop neu starten.

#### Cursor / OpenClaw / Andere

MCP-Spezifikation: stdio-Transport. Server-Befehl: `node /PFAD/src/index.js`. Env-Variablen `ROSENWEG_API` + `ROSENWEG_TOKEN`.

#### Hermes (mobile)

Hermes laeuft typischerweise als Remote-MCP. Hosting-Optionen:
- Selbst hosten auf einem Server (Cloudflare Worker, eigener VPS)
- Lokaler MCP via stdio gerade nicht moeglich → benoetigt eigenen MCP-Adapter

## Verfuegbare Tools

Generic:
- `whoami` — Welcher User, welche Rechte, welcher Token
- `list_endpoints` — Alle 285 API-Endpoints des Backends
- `api_call(method, path, body?)` — Generischer Fallback fuer jeden Endpoint

Vollmachten:
- `vollmachten_list`, `vollmachten_get`, `vollmachten_create_draft`
- `vollmachten_sign_digital`, `vollmachten_upload_signed`, `vollmachten_verify_ai`
- `vollmachten_revoke`, `vollmachten_get_pdf`, `vollmachten_delete`
- `vollmachten_templates_list/create/update/delete`
- `vollmachten_lookup_verwaltungen/personen/my_kontakte/my_wohnungen`

Auslagen:
- `auslagen_list`, `auslagen_get`, `auslagen_create`, `auslagen_update`
- `auslagen_stundensatz_list/get/save`

Reklamationen:
- `reklamationen_list`, `reklamationen_update_status`

Personen & Wohnungen:
- `personen_list`, `personen_get`
- `wohnungen_list_for_stweg`, `wohnungen_get`, `wohnungen_save_kontakte`

Handwerker:
- `handwerker_list`, `handwerker_get`, `handwerker_search`
- `handwerker_events_list/complete`

Mail & Verteiler:
- `verteiler_list`, `verteiler_get_recipients`, `email_archive_list/get`
- `mail_templates_list`, `mail_compose_send`

Dokumente:
- `documents_list`, `documents_get_pdf`, `documents_search`

WhatsApp:
- `whatsapp_send_to_person`, `whatsapp_list_recent_messages`

PBX:
- `pbx_status`, `pbx_list_calls`, `pbx_list_ring_members`

Waschkueche:
- `wasch_list_rooms`, `wasch_my_reservations`, `wasch_reserve`, `wasch_cancel`

STWEG/Energie/Diverses:
- `stweg_info`, `energie_my_consumption`, `proxmox_list_vms`
- ... siehe `list_endpoints` fuer Vollumfang

## Sicherheit

- Token wirkt wie ein Passwort. Bei Verlust **sofort widerrufen** im Profil.
- Scopes empfohlen: gib dem Agent nur was er braucht (z.B. `vollmachten:read` statt `*`).
- Audit: jeder Token-Call wird mit token_id im Server-Log getrackt.
- Token-Verwaltung (erstellen/widerrufen) ist ueber PAT BEWUSST blockiert — geht nur via Browser-Login.

## Entwicklung

Server ist ein einzelnes `src/index.js` mit Tool-Definitionen via Zod-Schemas. Neue Tools einfach in die `TOOLS`-Liste appenden — der Handler delegiert standardmaessig an die Backend-API.
