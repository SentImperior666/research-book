# research-book — MCP server for the LLM Wiki

An MCP (Model Context Protocol) server that exposes every step of the LLM
Wiki desktop app's [Quick Start](../README.md#quick-start) workflow as
typed tools. Drop it into Cursor, Claude Code, or any other MCP-aware client
and your agents can create projects, configure providers, ingest documents,
query the knowledge base, walk the knowledge graph, run lint, and clear the
review queue — without ever touching the GUI.

> ⚠️ **The LLM Wiki desktop app must be running.** This server is a thin
> stdio adapter over a local HTTP daemon (`http://127.0.0.1:19827`) that ships
> with the desktop app. If the app isn't open, every tool call returns
> `daemon unreachable`.

## What you get

| Tool                    | Quick Start step | Description                                                                                  |
| ----------------------- | :--------------: | -------------------------------------------------------------------------------------------- |
| `create_project`        | 1                | Scaffold a new project from a template.                                                      |
| `configure_llm`         | 2                | Set provider / model / API key / context window.                                             |
| `configure_embedding`   |        —         | Configure the OpenAI-compatible embedding endpoint (recommended for high-quality retrieval). |
| `configure_search`      |        —         | Configure the web-search provider used by `deep_research`.                                   |
| `import_documents`      | 3                | Copy files into `raw/sources/` and run the ingest pipeline.                                  |
| `query`                 | 5                | Graph-augmented retrieval + LLM answer; optionally save to the wiki.                         |
| `graph`                 | 6                | Inspect communities / neighbors / surprising-connection insights.                            |
| `review`                | 7                | List items flagged for human review.                                                         |
| `resolve_review_item`   | 7                | Mark a review item as resolved.                                                              |
| `lint`                  | 8                | Structural and (optionally) semantic lint.                                                   |
| `deep_research`         |        —         | Web search + LLM synthesis, optionally saved to the wiki.                                    |
| `list_templates`        |        —         | Discover available project templates.                                                        |
| `list_projects`         |        —         | Recent projects + currently active one.                                                      |
| `open_project`          |        —         | Validate a project and add it to recents.                                                    |
| `select_project`        |        —         | Make a project active for subsequent calls.                                                  |
| `list_sources`          |        —         | Files currently under `raw/sources/`.                                                        |
| `delete_source`         |        —         | Remove a file from the project.                                                              |
| `list_pages`            |        —         | Wiki pages, optionally filtered by frontmatter `type`.                                       |
| `read_page`             |        —         | Markdown content of a single wiki page.                                                      |
| `job_status`            |        —         | Poll an async job (ingest / query / lint / research).                                        |
| `cancel_job`            |        —         | Abort an in-flight job.                                                                      |
| `health`                |        —         | Daemon ping + active project.                                                                |

Plus `wiki://*` **resources** for cheap context reads:

- `wiki://overview`, `wiki://index`, `wiki://schema`, `wiki://purpose`, `wiki://log`
- `wiki://page/{path}` — any page by project-relative path

And three **prompts** (load via `/mcp` in Claude Code or the prompt picker in
Cursor) that teach agents how to drive the tools, not just what each one
does:

| Prompt             | Arguments                                   | When to load                                             |
| ------------------ | ------------------------------------------- | -------------------------------------------------------- |
| `quickstart`       | —                                           | First call in a new session. Orients the agent.          |
| `research_sprint`  | `topic`, `sources?`, `project_path?`        | End-to-end: ingest + deep-research + save + audit.       |
| `wiki_audit`       | `semantic?` (`"true"` to enable), `project_path?` | Prep a reviewer-ready report before handing off to a human. |

For the full reference — including decision rules, concurrency gotchas, and
anti-patterns — see [`.claude/skills/research-book/SKILL.md`](../.claude/skills/research-book/SKILL.md)
in the repo root. Claude Code auto-loads it when the `research-book` MCP
server is connected; other clients can read it manually.

## Install

The server is published as a Node 20+ package. From source:

```bash
git clone https://github.com/<you>/research-book.git
cd research-book/mcp-server
npm install
npm run build
```

Binaries land in `dist/` and are exposed as:

- `research-book-mcp` — stdio MCP server (the main entry)
- `research-book` — optional human-friendly CLI wrapper over the same daemon

## Authentication

The desktop app generates a per-install bearer token on first launch and
stores it under your OS config dir:

| OS      | Path                                                     |
| ------- | -------------------------------------------------------- |
| macOS   | `~/Library/Application Support/llm-wiki/api-token`       |
| Linux   | `$XDG_CONFIG_HOME/llm-wiki/api-token`                    |
| Windows | `%APPDATA%\llm-wiki\api-token`                           |

The MCP server reads the token from disk automatically. To override (e.g. when
running the server in a container that mounts the file elsewhere), set:

- `LLM_WIKI_API_TOKEN` — bearer token
- `LLM_WIKI_API_URL` — daemon base URL (defaults to `http://127.0.0.1:19827`)

## Wire it into Cursor

Edit `~/.cursor/mcp.json` (create it if it doesn't exist):

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

Restart Cursor. Open the Composer / Agent panel — the tools above should now
be available.

## Wire it into Claude Code

Claude Code's `mcp add` takes options, then the server name, then `--`, then the
command and its args.

**macOS / Linux**

```bash
claude mcp add research-book -- node /absolute/path/to/research-book/mcp-server/dist/index.js
```

**Windows (native, not WSL)** — wrap `node` in `cmd /c` so Claude Code spawns
it through the shell (this is Anthropic's documented workaround for
`Connection closed` errors on Windows stdio servers):

```powershell
claude mcp add research-book -- cmd /c node C:\absolute\path\to\research-book\mcp-server\dist\index.js
```

**Alternative — `add-json` (works identically on all platforms):**

```bash
claude mcp add-json research-book '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/research-book/mcp-server/dist/index.js"]
}'
```

Scope flags (optional, precede the server name):

- `--scope local` (default) — current project only, not checked in
- `--scope project` — writes `.mcp.json` at the repo root, shared with teammates
- `--scope user` — available to you in every project

Verify:

```bash
claude mcp list
claude mcp get research-book
```

In a Claude Code session, type `/mcp` to see `research-book` listed. When the
desktop app is running, all 23 tools become callable.

## Concurrency

The desktop daemon enforces a **per-project exclusive write lock**: only one
mutating operation (ingest, query/save, lint, research, config write) can run
against a given project at a time. Concurrent attempts return `409 Conflict`
with `Retry-After: 5`. Read-only tools (`list_*`, `read_page`, `graph`,
`review`, `health`) are unaffected.

For a team of researcher / engineer agents this means:

- Multiple agents can read the wiki in parallel.
- Mutating operations on the **same project** are serialized.
- Mutating operations on **different projects** run concurrently.

If you need to fan out an ingest job across many sources within a single
project, use a single `import_documents` call with a `paths` array — the
desktop app will batch them internally.

## Conversations created by agents

Every `query` tool call is recorded as a conversation in the desktop app's
chat sidebar with `source: "mcp"`. The GUI has an `Agent` filter toggle so a
human reviewer can audit exactly what agents have asked.

## Run the CLI

The same daemon is reachable via a thin CLI for humans (agents should use the
MCP server). Examples:

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

`research-book help` lists every command.

## Development

```bash
npm run dev        # tsx src/index.ts (live reload of the MCP server)
npm run cli        # tsx src/cli.ts -- <args>
npm test           # vitest unit + integration tests against an in-process fake daemon
npm run typecheck  # tsc --noEmit
```

The integration test in `src/__tests__/tools.test.ts` exercises every Quick
Start tool against an in-process Node HTTP server that mimics the daemon —
no Tauri app required. To exercise the full pipeline end-to-end, start the
real desktop app, then run:

```bash
LLM_WIKI_API_URL=http://127.0.0.1:19827 npm run cli -- health
```

## How it fits together

```
┌──────────────┐     stdio     ┌────────────────┐    HTTP+SSE    ┌──────────────────┐
│  MCP client  │  ───────────► │ research-book  │  ────────────► │  desktop daemon  │
│  (Cursor /   │  ◄─────────── │   MCP server   │  ◄──────────── │ (clip_server.rs) │
│  Claude /…)  │               │  (this pkg)    │                │                  │
└──────────────┘               └────────────────┘                └────────┬─────────┘
                                                                          │ Tauri events
                                                                          ▼
                                                                ┌──────────────────┐
                                                                │   renderer       │
                                                                │  (src/lib/*)     │
                                                                └──────────────────┘
```

The MCP server contains **no business logic** — every tool is a thin wrapper
over an `/api/*` HTTP endpoint that delegates to the live `src/lib/*` code in
the Tauri renderer. That's the same code path the GUI uses, so an agent's
`query` is identical to a human pressing the chat button.

## License

MIT.
