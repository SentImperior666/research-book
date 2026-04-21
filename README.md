# research-book

<p align="center">
  <img src="logo.jpg" width="128" height="128" style="border-radius: 22%;" alt="research-book logo">
</p>

<p align="center">
  <strong>An MCP-driven research wiki for LLM agents.</strong><br>
  A stable, programmable knowledge base that coding agents (Cursor, Claude Code, …) can ingest into, query, audit, and extend — without ever touching the GUI.
</p>

<p align="center">
  <a href="#what-this-fork-is-for">Why this fork</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#mcp-tools">Tools</a> •
  <a href="#mcp-resources">Resources</a> •
  <a href="#mcp-prompts">Prompts</a> •
  <a href="#wire-it-into-an-mcp-client">Integrations</a> •
  <a href="#concurrency-model">Concurrency</a> •
  <a href="#build-from-source">Build</a>
</p>

---

## This is a fork

**Upstream:** [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) — a
cross-platform Tauri desktop app that implements
[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
Credit for the original architecture, two-step ingest pipeline, knowledge
graph, review system, and Chrome web clipper belongs entirely to the upstream
project.

**This fork** (`SentImperior666/research-book`) keeps the GUI and the pipeline
semantically identical to upstream and **adds a programmable automation layer
on top** so LLM agents can drive the same wiki end-to-end.

## What this fork is for

Upstream LLM Wiki is a beautiful human-first knowledge tool: you curate, the
LLM maintains. That's a great loop, but it stops at the edge of the GUI window
— if you want a team of coding agents to do literature reviews, triage a
research corpus overnight, or keep a shared wiki consistent across multiple
projects, you need the same pipeline exposed as a real API.

This fork's goal is exactly that: **a stable research wiki that supports
automated research with LLM agents**. Concretely, the fork adds:

| Addition | Where it lives | What it gives you |
| --- | --- | --- |
| Local HTTP API (`/api/*`) | `src-tauri/src/api/` | Token-authed REST + SSE surface over the live renderer logic. 23 endpoints cover every Quick Start step. |
| Per-project write lock | `src-tauri/src/api/locks.rs` | Mutating calls on the same project are serialized, so two agents can't corrupt the wiki. |
| MCP server | `mcp-server/` | Typed stdio MCP adapter over the HTTP API. 23 tools, 6 resources, 3 prompts. |
| CLI | `mcp-server/src/cli.ts` → `research-book` binary | Humans / scripts can talk to the same daemon. |
| Claude Code skill | `.claude/skills/research-book/SKILL.md` | Teaches agents *how* to use the tools — decision rules, concurrency gotchas, anti-patterns. |
| Per-install bearer token | OS config dir (see [Authentication](#authentication)) | Agents can't hit the daemon from random processes. |
| Agent/human coexistence in the GUI | `src/stores/chat-store.ts` + chat sidebar filter | Conversations started by the MCP server are tagged `source: "mcp"` and can be audited with a dedicated filter toggle. |
| Per-project store hygiene | `src/App.tsx` + `src/stores/*` | Fixed a class of bugs where review items and chat history from the previous project could leak into the next one (and then get silently written back to disk). |

The GUI itself is unchanged in behavior — human curation is still the
intended primary loop. The MCP server is an **additive second face on the
same daemon**, using the exact code path the GUI uses.

For everything about the GUI (three-column layout, ingest pipeline internals,
knowledge graph, Obsidian compatibility, Chrome web clipper, …) see
**[`docs/how-to-use-llm-wiki.md`](docs/how-to-use-llm-wiki.md)**.

## Architecture

```
┌──────────────────┐   stdio    ┌───────────────────┐   HTTP+SSE   ┌────────────────────┐
│   MCP client     │ ─────────► │  research-book    │ ───────────► │  desktop daemon    │
│  (Cursor /       │            │    MCP server     │              │  (tiny_http, Rust) │
│  Claude Code /   │ ◄───────── │ (mcp-server/*.ts) │ ◄─────────── │  src-tauri/src/api │
│  Claude Desktop) │            └───────────────────┘              └─────────┬──────────┘
└──────────────────┘                                                         │ Tauri events
                                                                             ▼
                                                                   ┌────────────────────┐
                                                                   │     renderer       │
                                                                   │  (src/lib/* logic) │
                                                                   │   — same code as   │
                                                                   │     the GUI uses   │
                                                                   └────────────────────┘
```

Key property: **the MCP server contains no business logic.** Every tool is a
thin wrapper over an `/api/*` endpoint that delegates to the renderer. The
renderer runs the same `src/lib/*` code that powers the GUI. An agent's
`query` tool call is therefore **identical** to a human clicking the chat
button — same retrieval pipeline, same LLM call, same persistence. Anything
the agent does, a human can see, and vice versa.

### Why this shape

- **Stability.** The ingest pipeline, graph, and LLM-client code are already
  battle-tested by the upstream GUI. Building agents on top means not
  re-implementing any of it.
- **Auditability.** Every agent query appears in the GUI's chat sidebar with
  an `Agent` badge. Humans can read exactly what the agent saw, asked, and
  saved.
- **Safety.** The daemon owns the project file lock. Concurrent mutations on
  the same project get `409 Conflict` instead of racing.
- **Observability.** Long jobs (ingest, query, lint, deep research) emit SSE
  progress events that the MCP server forwards as MCP progress notifications,
  so Claude Code can show a live progress bar.

## Requirements

- The **desktop app must be running** — the MCP server is a stdio adapter
  over a local daemon at `http://127.0.0.1:19827`. If the app isn't open,
  every tool call returns `daemon unreachable`.
- An MCP-aware client (Cursor, Claude Code, Claude Desktop, any MCP host).
- Node 20+ (the MCP server is a Node package).

## MCP tools

All 23 tools the agent can call. Mutating tools are marked — these acquire
the per-project write lock (see [Concurrency](#concurrency-model)).

### Project lifecycle

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `health` | — | Ping the daemon, report the active project. First call of every session. |
| `list_templates` | — | Enumerate project templates (`research`, `reading`, `business`, `general`, …). |
| `create_project` | ✓ | Scaffold a new project from a template. |
| `list_projects` | — | Recent projects + currently active one. |
| `open_project` | ✓ | Validate a path and add it to recents. |
| `select_project` | ✓ | Make a project active so later calls can omit `projectPath`. |

### Configuration

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `configure_llm` | ✓ | Provider / model / API key / context window. |
| `get_llm_config` | — | Read the current LLM configuration. |
| `configure_embedding` | ✓ | OpenAI-compatible `/v1/embeddings` endpoint. Strongly recommended — without it `query` quality degrades. |
| `configure_search` | ✓ | Web-search provider (Tavily) used by `deep_research`. |

### Sources & ingest

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `list_sources` | — | Files currently under `raw/sources/`. |
| `import_documents` | ✓ | Copy files into `raw/sources/` and run the two-step ingest pipeline. Accepts a `paths` array; use `wait: false` to stream progress. |
| `delete_source` | ✓ | Remove a source (with cascade cleanup of entity/summary pages). |

### Query & explore

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `query` | ✓ when `saveToWiki: true` | Graph-augmented retrieval + LLM answer. Optionally persists the answer to `wiki/queries/<slug>-<date>.md` and ingests it. |
| `graph` | — | Three modes: `communities` (Louvain clusters), `neighbors` (related pages), `insights` (surprising connections + knowledge gaps). |
| `list_pages` | — | Wiki pages, optionally filtered by frontmatter `type`. |
| `read_page` | — | Markdown content of a single page. |

### Review & audit

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `review` | — | List items flagged by the pipeline for human judgment. |
| `resolve_review_item` | ✓ | Mark a review item resolved with an action (`accepted`, `rejected`, `merged`, …). |
| `lint` | ✓ | Structural lint; pass `semantic: true` for the slower LLM-backed contradiction detector. |

### Deep research

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `deep_research` | ✓ | Web search (Tavily) + LLM synthesis. Optionally saves a research page to the wiki. Requires `configure_search`. |

### Job control

| Tool | Mutating | Purpose |
| --- | :---: | --- |
| `job_status` | — | Poll any async job by id, or list all running/pending jobs. |
| `cancel_job` | ✓ | Abort an in-flight job. |

Every long-running tool (`import_documents`, `query`, `lint`, `deep_research`)
returns a `jobId` and accepts `wait: boolean`. When `wait: true` the call
blocks until the job finishes. When `wait: false` it returns immediately and
the caller polls `job_status`. When a `progressToken` is supplied (Claude Code
does this automatically), SSE progress frames are forwarded as MCP progress
notifications so the client can show a live progress bar.

## MCP resources

Resources are read-only URIs; use them instead of tools when you just need
content, not computation.

| URI | Returns |
| --- | --- |
| `wiki://overview` | `wiki/overview.md` — public-facing summary of the wiki. |
| `wiki://index` | `wiki/index.md` — pages grouped by type. |
| `wiki://purpose` | `purpose.md` — the project charter. |
| `wiki://schema` | `schema.md` — page types, naming, frontmatter rules. |
| `wiki://log` | `wiki/log.md` — reverse-chronological edits. |
| `wiki://page/{path}` | Any page by project-relative path (e.g. `wiki://page/wiki/entities/openai.md`). |

Reading a resource is **cheaper and faster** than calling `read_page` and
should be an agent's default when it knows exactly which page it wants.

## MCP prompts

Server-side prompt templates the agent can load via `prompts/list` / `prompts/get`
(`/mcp` in Claude Code; prompt picker in Cursor). These teach the agent *how*
to chain the tools, not just what each one does.

| Prompt | Arguments | When to load |
| --- | --- | --- |
| `quickstart` | — | First call in a new session. Orients the agent on Quick Start order and the per-project lock. |
| `research_sprint` | `topic`, `sources?`, `project_path?` | End-to-end: ingest + deep-research + save + audit in one coordinated sprint. |
| `wiki_audit` | `semantic?`, `project_path?` | Prep a reviewer-ready report before handing off to a human. |

For the long-form reference (decision rules, async-vs-blocking heuristics,
anti-patterns, researcher-swarm patterns) see
[`.claude/skills/research-book/SKILL.md`](.claude/skills/research-book/SKILL.md).
Claude Code auto-loads the skill whenever the `research-book` MCP server is
connected; other clients can read the file manually.

## The core agent workflow

The intended shape of an automated research session:

1. **`health`** → verify the daemon is up, see the active project.
2. **`list_projects`** → if the topic has no project yet, `create_project`
   then `select_project`.
3. **Bootstrap the charter.** Every new project ships with *template*
   `purpose.md` and `wiki/overview.md` (placeholder sections, not content).
   The agent interviews the user and fills both before ingesting anything.
   This is the one explicit exception to "never hand-write wiki markdown"
   — these two files are project scaffolding.
4. **`configure_llm`**, optionally **`configure_embedding`** (strongly
   recommended), optionally **`configure_search`** (only if deep research is
   in scope).
5. **`import_documents`** with a `paths` array and a descriptive
   `folderContext`. Prefer `wait: false` for big batches; poll `job_status`.
6. **Read before asking.** Fetch `wiki://overview` + `wiki://index`. Use
   `query` for concepts, `graph mode=neighbors` for connections,
   `graph mode=insights` for gaps and surprises.
7. **`query` with `saveToWiki: true`** for answers worth remembering; new
   material flows back into the pipeline automatically.
8. **`deep_research`** to fill specific gaps.
9. **`lint`** (structural) and optionally `lint semantic: true` (LLM-backed)
   before handing back to a human.
10. **`review`** to list flagged items; `resolve_review_item` the obvious
    ones, leave the ambiguous ones for the human.

The `quickstart` prompt encodes exactly this flow.

## Wire it into an MCP client

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "research-book": {
      "command": "node",
      "args": ["/absolute/path/to/research-book/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Cursor. The tools, resources, and prompts above appear in the
Composer / Agent panel.

### Claude Code

macOS / Linux:

```bash
claude mcp add research-book -- node /absolute/path/to/research-book/mcp-server/dist/index.js
```

Windows (native, not WSL) — wrap `node` in `cmd /c` so Claude Code spawns
the server through the shell (documented workaround for Windows stdio servers
reporting `Connection closed`):

```powershell
claude mcp add research-book -- cmd /c node C:\absolute\path\to\research-book\mcp-server\dist\index.js
```

Cross-platform alternative:

```bash
claude mcp add-json research-book '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/research-book/mcp-server/dist/index.js"]
}'
```

Scope flags (optional, before the server name):

- `--scope local` (default) — current project only, not checked in.
- `--scope project` — writes `.mcp.json` at the repo root, shared with teammates.
- `--scope user` — available in every project.

Verify:

```bash
claude mcp list
claude mcp get research-book
```

In a Claude Code session, type `/mcp` to see `research-book` listed. When the
desktop app is running, all 23 tools become callable. The `research-book`
skill at `.claude/skills/research-book/SKILL.md` auto-loads and teaches the
agent the workflow above.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "research-book": {
      "command": "node",
      "args": ["/absolute/path/to/research-book/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop; the tools appear under the hammer icon.

## Authentication

The desktop app generates a **per-install bearer token** on first launch and
stores it under the OS config dir:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/llm-wiki/api-token` |
| Linux | `$XDG_CONFIG_HOME/llm-wiki/api-token` |
| Windows | `%APPDATA%\llm-wiki\api-token` |

The MCP server reads the token from disk automatically. To override (e.g. in
a container that mounts the token elsewhere), set:

- `LLM_WIKI_API_TOKEN` — bearer token
- `LLM_WIKI_API_URL` — daemon base URL (defaults to `http://127.0.0.1:19827`)

Every request to `/api/*` must carry `Authorization: Bearer <token>`.
Unauthenticated requests get `401`. The token is written with user-only
permissions; don't commit it.

## Concurrency model

The daemon enforces a **per-project exclusive write lock**:

- **Read-only calls** (`list_*`, `read_page`, `graph`, `review`, `health`,
  `wiki://*` resources) never block. Unlimited concurrency.
- **Mutating calls** on the **same project** serialize. A second mutation
  while one is in flight returns `HTTP 409 Conflict` with `Retry-After: 5`.
- **Mutating calls** on **different projects** run concurrently.

The lock is RAII in Rust (`src-tauri/src/api/locks.rs`): it releases
automatically when the renderer's reply finishes streaming, including on
error paths and client disconnects.

### Multi-agent patterns

- **Fan-out across projects.** Run N agents, one per project. No contention;
  fully parallel.
- **Fan-out within a project** (researcher swarm). Spawn N agents on the same
  project, each with a narrow subtopic. They naturally queue on the lock;
  expect `409`s and respect `Retry-After`. Don't spin in a tight retry loop
  — call `job_status` to see what's running, back off, then retry.
- **Ingest many files.** Don't loop `import_documents` per file. Use a single
  call with a `paths` array — the pipeline batches internally and only takes
  the lock once.

## Agent / human coexistence

Every `query` tool call is recorded as a conversation in the desktop app's
chat sidebar with `source: "mcp"`. The sidebar has an **Agent / You / All**
filter so a reviewer can see exactly what agents have asked, in what order,
with what citations.

This coexistence was hardened in this fork:

- Per-project stores (`review`, `chat`, `research`, `activity`, `lint`) now
  clear and reload on every project switch so the GUI never flashes the
  previous project's reviews or conversations.
- Auto-save only writes the currently active project's data to disk; the
  previous leak where A's reviews could be persisted into B's
  `.llm-wiki/review.json` is gone.

## CLI

Humans and scripts can hit the same daemon without MCP via the bundled CLI:

```bash
research-book health
research-book list-projects
research-book select-project /Users/me/wikis/my-research
research-book configure-llm --provider openai --model gpt-4o-mini --api-key sk-...
research-book import-documents ~/papers/*.pdf --folder-context "literature review"
research-book query "What did we conclude about retrieval-augmented agents?" --save-to-wiki
research-book graph --mode insights
research-book lint --semantic
research-book review
```

`research-book help` lists every command. The CLI is a thin wrapper over the
same `/api/*` endpoints the MCP server uses — agents should still prefer MCP
for structured tool use; the CLI is for humans scripting.

## Build from source

### Desktop app (required — the MCP server is useless without it)

```bash
# Prerequisites: Node 20+, Rust 1.70+
git clone https://github.com/SentImperior666/research-book.git
cd research-book
npm install
npm run tauri dev        # dev build with hot reload
npm run tauri build      # production .dmg / .msi / .deb / .AppImage
```

### MCP server

```bash
cd mcp-server
npm install
npm run build            # produces dist/index.js (MCP) + dist/cli.js (CLI)
```

Binaries exposed (symlinked via `bin` in `package.json`):

- `research-book-mcp` — stdio MCP server, the main entry
- `research-book` — CLI wrapper over the same daemon

### Chrome extension (optional)

See [`docs/how-to-use-llm-wiki.md`](docs/how-to-use-llm-wiki.md#chrome-extension).

## Develop and test

```bash
# MCP server
cd mcp-server
npm run dev              # tsx src/index.ts with live reload
npm run cli -- health    # run the CLI against the live daemon
npm test                 # vitest: tools + client + CLI against an in-process fake daemon
npm run typecheck        # tsc --noEmit

# Tauri app
npm run tauri dev        # at the repo root
npm test                 # renderer tests (if configured)
```

The integration test suite at `mcp-server/src/__tests__/tools.test.ts` runs
against an in-process Node HTTP server that mimics the daemon — no Tauri
app required. To exercise the full stack against the real daemon:

```bash
LLM_WIKI_API_URL=http://127.0.0.1:19827 npm run cli -- health
```

## Repository layout

```
research-book/
├── src/                    # React + Zustand renderer (the GUI)
│   ├── lib/                # Business logic — shared by GUI and MCP
│   └── stores/             # Zustand per-project stores
├── src-tauri/              # Tauri v2 Rust backend
│   ├── src/api/            # HTTP + SSE surface, auth, locks, bridge to renderer
│   └── src/clip_server.rs  # Chrome extension clip endpoint
├── mcp-server/             # The MCP adapter (this fork's main addition)
│   ├── src/index.ts        # Stdio MCP entry
│   ├── src/cli.ts          # Human-facing CLI
│   ├── src/tools.ts        # 23 MCP tools
│   ├── src/resources.ts    # wiki://* resources
│   ├── src/prompts.ts      # quickstart / research_sprint / wiki_audit
│   ├── src/client.ts       # Typed HTTP client for the daemon
│   └── src/__tests__/      # Vitest integration tests
├── extension/              # Chrome web clipper (unchanged from upstream)
├── .claude/skills/research-book/SKILL.md   # Claude Code skill
└── docs/how-to-use-llm-wiki.md             # GUI usage guide (upstream README)
```

## Credits

- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)**
  for the original LLM Wiki methodology.
- **[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)** for the concrete
  desktop implementation this fork builds on — the pipeline, graph, review
  system, and Chrome web clipper are all upstream.
- This fork adds the HTTP API, per-project write lock, MCP server, CLI, and
  Claude Code skill so agents can drive the same pipeline.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE). The MCP server
subpackage (`mcp-server/`) is MIT-licensed in its own `package.json` to
allow embedding in differently-licensed agents; the desktop app itself
remains GPL-3.0 as inherited from upstream.
