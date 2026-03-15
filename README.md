# Zefix MCP

> ⚠️ **Unofficial** MCP server for [zefix.ch – Switzerland Central Business Name Index](https://www.zefix.ch).
\
This project is not affiliated with or endorsed by the Federal Department of Justice and Police (FDJP) - Federal Office of Justice (FOJ) who are developing and maintaining zefix.ch.

## Features and Use-cases

- Allows your AI-assistant to search for companies incorporated in Switzerland by their name or UID (`CHE-nnn.nnn.nnn`) with optional filters by canton of incorporation, legal form, location, previous names, etc. (mimics all filters in Zefix GUI).
- Equips your AI-assistant with full company details available in Zefix (business names and identifiers, purpose, address,  auditors, change history, capital, names of legal representatives, merges & acquisitions) to build further automation workflows or answer business-specific questions. 

## Sample questions MCP can answer

**Company lookup**
- *"Find if Google has a legal body in Switzerland and show me their registered address."*
- *"Was ist der vollständige rechtliche Name und die UID des Unternehmens, das als Migros bekannt ist?"*
- *"Recherche le CHE-169.865.482 et dis-moi tout ce que tu sais à son sujet."*

**Filtering & discovery**
- *"List all active Treuhand companies headquartered in canton Schaffhausen."*
- *"Finde Einzelunternehmen im Bereich Malerei, die irgendwo in der Grossregion Zürich eingetragen sind."*
- *"Dresse une liste des adresses et des représentants légaux de toutes les banques en Romandie."*

**History & changes**
- *"What is the new name of the company formerly known as 'SwissAir'?"*
- *"Zeig mir die vollständige Namens- und Eigentümergeschichte von Credit Suisse."*
- *"Y a-t-il des entreprises qui ont repris ou fusionné avec UBS AG ?"*

**Due diligence & research**
- *"Who is listed as auditor for Zurich Insurance Group?"*
- *"Ich stehe kurz vor der Unterzeichnung eines Vertrags mit Hans Müller als Vertreter von Lindt & Sprüngli – ist er dazu bevollmächtigt?"*
- *"Vérifie que Bollinger est une entreprise active spécialisée dans la plomberie, et dis-moi depuis combien de temps elle existe et quel est son capital enregistré."*

## Requirements

- MCP host application (Claude, LLM Studio, VSCode+GHCP/Cline, Cursor, Dive, LibreChat, DeepChat, Chainlit etc.)
- LLM that supports Tool calling (GPT-4.1+ Claude Sonnet/Opus, Gemini, Llama 3.1+, Qwen3.5, etc.)
- (optional) [Node.js](https://nodejs.org/) 24+ (*for development or local run without npx*)

## Installation

### As a Claude Desktop Extension (easiest)

1. Go to the [Releases page](https://github.com/zahhar/zefix-mcp/releases) and download the latest `zefix.mcpb` file.
2. Double-click it — Claude Desktop opens automatically.
3. Click **Install**.

Restart Claude Desktop if you do not see `zefix` tool in the list of available tools.

### Via npx (recommended for all other MCP hosts)

Add to your MCP host config:

```json
{
  "mcpServers": {
    "zefix": {
      "command": "npx",
      "args": ["-y", "zefix-mcp-unofficial"]
    }
  }
}
```
npx downloads, caches, and runs the package automatically. No local install required.

### From source

```bash
git clone https://github.com/your-org/zefix-mcp-unofficial.git
cd zefix-mcp-unofficial
npm install
npm run build
```

Than add this section to config file of your MCP host application (syntax may vary, check documentation for your MCP host app):

```json
{
  "mcpServers": {
    "zefix": {
      "command": "node",
      "args": ["/absolute/path/to/zefix-mcp-unofficial/dist/index.js"]
    }
  }
}
```

## Tool reference

### `get_companies`

Search the Zefix registry. All parameters except `name_or_uid` are optional.

| Parameter | Type | Description |
|---|---|---|
| `name_or_uid` | string | Company name or UID (`CHE-nnn.nnn.nnn`). |
| `language_key` | string | Response language: `en`, `de`, `fr`, `it`. Default: `en`. |
| `cantons` | string[] | Filter by canton codes, e.g. `["ZH", "BE"]`. |
| `locations` | string[] | Filter by legal seat town names, e.g. `["Zurich", "Bern"]`. |
| `legalForms` | string[] | Filter by legal form, e.g. `["AG", "GmbH"]`. |
| `exactSearch` | boolean | Search from start of name (default: `true`). Set `false` for substring/wildcard (`*`) search. |
| `phoneticSearch` | boolean | Enable phonetic/fuzzy matching. |
| `includeDeleted` | boolean | Include deregistered companies (default: `false`). |
| `includeFormerNames` | boolean | Also search former company names (default: `false`). |

**Tips:**
- If you know the UID, use it — it will return the most accurate full-detail result.
- If `exactSearch: true` returns no results, retry with `exactSearch: false` and `phoneticSearch: true` combination.
- Results are returned in Markdown, with detail level depending on amount of found companies:
   - 1 result → full details;
   - 2–10 → detailed summaries, but without full history and list of legal representatives;
   - 11+ → name/UID/status list only.
- Results are capped at 100 items.
- The server communicates over stdio (MCP standard transport) — it won't print anything to the terminal when run directly.
- When MCP server queries Zefix REST API at `https://www.zefix.ch/ZefixREST/api/v1/` (public, no authentication required) it submits `User-Agent: zefix-mcp-unofficial` for transparency. You may want to change uf if using this MCP as part of your larger solution. 

---

## Development and Debugging

### Build

```bash
npm run build
# Compiled output goes to dist/index.js
```

### Inspect

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to interactively call tools and inspect responses:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The first run will prompt you to install `@modelcontextprotocol/inspector`. After startup, open the URL shown in the terminal (usually `http://localhost:5173`) to access the inspector UI.

**Workflow:**
1. Select the `get_companies` tool in the left panel.
2. Fill in parameters (e.g. `name_or_uid: "Berg Digital"`).
3. Click **Run** and inspect the raw response.

### Publishing a new release

Pushing a `v*` tag triggers the GitHub Actions release workflow, which runs two jobs **in parallel**:

| Job | What it does | Where it lands |
|---|---|---|
| **Publish to npm** | `npm run build`, `npm publish` | [npmjs.com](https://www.npmjs.com/package/zefix-mcp-unofficial) |
| **Publish Claude plugin** | `npm run build`, `npx @anthropic-ai/mcpb pack`, uploads the `.mcpb` asset | GitHub Releases |

```bash
# 1. Bump version in BOTH files (npm will reject publishing over an existing version):
#    - package.json  → "version": "x.y.z"
#    - manifest.json → "version": "x.y.z"

# 2. Commit, tag, push — the tag MUST point to the version-bump commit:
git add package.json manifest.json
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

> ⚠️ **Common mistake:** creating the tag *before* editing `package.json`/`manifest.json`.
> CI publishes whatever version string is in `package.json` at the tagged commit — the tag name itself is ignored by npm.
> If you tagged too early, move the tag to the correct commit:
> ```bash
> git tag -d vX.Y.Z                   # delete local tag
> git push origin :refs/tags/vX.Y.Z   # delete remote tag
> # edit package.json + manifest.json, then:
> git add package.json manifest.json
> git commit -m "chore: release vX.Y.Z"
> git tag vX.Y.Z
> git push && git push --tags
> ```

> **First-time setup (one-off):**
> - **npm token:** create an *Access token* at npmjs.com → add it as a *Repository secret* named `NPM_TOKEN` in *GitHub → Settings → Secrets and variables → Actions*; token lifetime is 90 days (max) - update regularly.
> - **GitHub releases:** no extra setup needed — the workflow uses the built-in `GITHUB_TOKEN` with `contents: write` permission

---

## License

- [MIT](LICENSE).