---
name: research-book
description: Use the research-book MCP server to build, query, and maintain a persistent LLM Wiki. Load this skill whenever the `research-book` MCP server is available (tools include `health`, `create_project`, `configure_llm`, `import_documents`, `query`, `graph`, `lint`, `review`, `deep_research`, `wiki://*` resources) and the user asks you to ingest documents, answer questions from a knowledge base, audit a wiki, or do deep research that should be persisted. Covers the Quick Start order, decision rules, concurrency behavior, and common multi-agent patterns.
---

# research-book — LLM Wiki skill

The `research-book` MCP server wraps a local desktop app (LLM Wiki) that owns a
project folder on disk: raw sources under `raw/sources/`, curated pages under
`wiki/`, a vector index, and a knowledge graph. Every tool call flows through
the same code path the GUI uses, so edits you make are durable and a human can
review them at any time.

## When to use this skill

Use it whenever **all** of these are true:

1. The `research-book` MCP server is connected (check with the `health` tool).
2. The user wants persistent knowledge — not a one-shot answer. Ephemeral Q&A
   doesn't need this skill.
3. The task involves one or more of: ingesting documents, answering questions
   grounded in ingested content, mapping connections between topics, auditing
   or curating a knowledge base, running deep research that should be saved.

If the desktop app is not running, `health` returns `daemon unreachable`. Tell
the user to launch the app and stop — don't try to work around it.

## Mental model

- **Project**: a folder on disk. One project per topic/domain. All tools act on
  the *currently active* project unless you pass `projectPath`.
- **Raw sources** (`raw/sources/`): the untouched files you imported. Never
  edit these; they're the immutable ground truth.
- **Wiki pages** (`wiki/`): curated, linked, typed markdown the LLM Wiki
  pipeline produces and you as an agent extend. This is what agents *write*.
- **Graph**: automatically derived from `[[wikilinks]]` between pages. You
  don't build it; you just query it.
- **Review queue**: items the pipeline flagged as uncertain (conflicts,
  low-confidence merges). A human or a careful agent resolves them.

## Quick Start order

Follow this exact sequence the first time you work with a project. Skip any
step that's already done (check with `health`, `list_projects`, `get_llm_config`).

| #  | Tool                  | Why                                                                |
| -- | --------------------- | ------------------------------------------------------------------ |
| 1  | `health`              | Verify the daemon is up; learn the active project.                 |
| 2  | `list_projects`       | See existing projects before creating a new one.                   |
| 3  | `create_project`      | Only if the user's topic isn't already a project.                  |
| 4  | `select_project`      | Make the new project active so later calls can omit `projectPath`. |
| 5  | **Bootstrap `purpose.md` and `wiki/overview.md`** (see below) | Every new project ships with *templates* in these files, not content. Fill them before ingesting anything. |
| 6  | `configure_llm`       | Required before `query`, `lint --semantic`, or `deep_research`.    |
| 7  | `configure_embedding` | Strongly recommended — dramatically improves `query` quality.      |
| 8  | `configure_search`    | Only if the user wants `deep_research` (uses Tavily).              |
| 9  | `import_documents`    | Copies files into `raw/sources/` and runs the ingest pipeline.     |
| 10 | `query` / `graph` / `review` / `lint` | The actual productive work.                         |

Do **not** skip `configure_embedding`. Without it `query` falls back to keyword
search and the answers are noticeably worse.

### Step 5 — bootstrap the project's charter

Every new project is created with two *template* files that contain HTML-comment
prompts like `<!-- State the central question… -->` and empty bullet lists:

- `<projectPath>/purpose.md` — the project charter. Different templates
  (`research`, `reading`, `business`, …) lay out different sections (research
  question, hypothesis, scope, success criteria, or business goals / KPIs /
  stakeholders). Its sections shape every future `query` — leaving them blank
  is why a fresh wiki answers "this wiki appears to be uninitialized".
- `<projectPath>/wiki/overview.md` — the public-facing summary of what this
  wiki covers. This *is* indexed, so `query` and `graph` will reference it.

**What the agent should do:**

1. Read both files (`read_page` works for `wiki/overview.md`; use your
   regular file-read tool for `purpose.md` — it lives at the project root,
   not under `wiki/`).
2. **Interview the user** to fill the sections. Ask only the questions the
   template actually has placeholders for — don't invent scaffolding.
   Example opening: *"I need to fill out this project's charter before we
   ingest anything. What's the central question you want the wiki to
   answer? What's your current best hypothesis? Anything explicitly out of
   scope?"*
3. Edit the two files in place with your file-editing tool, replacing the
   HTML-comment prompts and empty bullets with the user's answers. Keep
   frontmatter intact.
4. Confirm back to the user: *"Here's what I wrote to purpose.md and
   overview.md. OK to proceed to ingestion?"* — then continue to step 6.

This is the **one explicit exception** to the "never hand-write wiki
markdown" rule below. `purpose.md` and `wiki/overview.md` are *project
scaffolding*, not knowledge synthesis; filling them is the first act of
turning a template into a real wiki. After this step, revert to using
`query saveToWiki:true`, `deep_research`, and `import_documents` for all
other writes.

## Decision rules

### Reading

- **First look:** fetch `wiki://overview` and `wiki://index` as resources
  (cheap, cached). They tell you what the project is about and what pages
  exist. Do this once per session before anything else.
- **Specific page by name:** use `read_page` with the relative path from
  `list_pages`, or the `wiki://page/{path}` resource (equivalent).
- **Specific page by concept:** use `query` — it's graph-augmented and will
  also surface related pages, which a direct read won't.
- **"What do we know about X?"** → `query`, with `saveToWiki: true` if the
  question is likely to recur.
- **"How is X connected to Y?"** → `graph mode=neighbors page=X`.
- **"What's surprising / missing in this wiki?"** → `graph mode=insights`.
- **"What does the wiki cover overall?"** → `graph mode=communities`.

### Writing

- **Add new source material:** `import_documents` with a `paths` array. Always
  set `folderContext` to a short string describing the batch (e.g.
  `"2024 literature review"`) — this shows up in lint/review later.
- **Answer a user question and remember it:** `query` with
  `saveToWiki: true`. The answer lands under `wiki/queries/` and is ingested.
- **Fill a gap the user identified:** `deep_research topic="..."` — it does
  web search + synthesis and can save to the wiki.
- **Never hand-write wiki pages through shell/file tools.** Always go through
  `import_documents` (for sources) or `query saveToWiki:true` / `deep_research`
  (for synthesis). Direct writes bypass the ingest pipeline, so the vector
  index and graph fall out of sync and lint will flag the page.

### Maintenance

- **After a big ingest:** run `lint` (structural, fast). Optionally `lint
  semantic:true` (LLM-backed, slower) to catch contradictions.
- **Before handing back to a human:** run `review` and resolve obvious items
  with `resolve_review_item`. Leave ambiguous ones.
- **Broken-link warnings:** these mean an existing page references a wikilink
  whose target doesn't exist yet. Decide: (a) rename the link if it was a typo,
  (b) create the target page via `deep_research` or `query saveToWiki:true`, or
  (c) leave the warning if the target is genuinely a TODO. Don't mass-delete.

### Async vs blocking

All long-running tools (`import_documents`, `query`, `lint`, `deep_research`)
return a `jobId`. Three options:

- `wait: true` (default for `query` and `lint`) — the tool call blocks until
  done. Use for short jobs you need the result of *now*.
- `wait: false` — returns immediately with the `jobId`. Poll with
  `job_status id=<jobId>`. Use for long-running ingests so you can work in
  parallel.
- Subscribe to progress via the `progressToken` — the server forwards SSE
  frames as MCP progress notifications. Claude Code surfaces these automatically.

Rule of thumb: anything with more than ~3 files or `deep_research` should be
async; everything else can block.

## Concurrency (important)

The daemon enforces a **per-project exclusive write lock**. Mutating tools
(`import_documents`, `query saveToWiki:true`, `lint`, `deep_research`,
`configure_*`) on the **same project** are serialized. If you attempt a second
mutation while one is in flight, the server replies with **HTTP 409
Conflict** and `Retry-After: 5`. Your tool call will surface this as an error.

Correct behavior when you hit a 409:

1. Check `job_status` (no arg) to see which job is running.
2. Either wait for it (`job_status id=<jobId>` in a loop, or resubmit after
   `Retry-After` seconds) or cancel it (`cancel_job id=<jobId>`) — only if the
   user explicitly said to.
3. Don't fire-and-forget retries in a tight loop. You'll just starve the
   in-flight job.

Read-only tools (`list_*`, `read_page`, `graph`, `review`, `health`,
`wiki://*` resources) are never blocked by this lock and can fan out
arbitrarily.

## Example workflows

### 1. Onboard a research corpus from scratch

```
health
list_projects
create_project name="protein-folding" path="/home/me/wikis" templateId="research"
select_project path="/home/me/wikis/protein-folding"

# ── Bootstrap the charter (step 5). Read templates, interview the user,
#    then edit the two files in place with your file-editing tool. ──
read_page path="wiki/overview.md"                      # (via MCP)
# open /home/me/wikis/protein-folding/purpose.md       # (via regular file tools)
# ask user → fill Research Question, Hypothesis, Scope, Success Criteria
# write both files

configure_llm provider="anthropic" model="claude-sonnet-4" apiKey="sk-…"
configure_embedding enabled=true endpoint="https://api.openai.com/v1" apiKey="sk-…" model="text-embedding-3-large"
import_documents paths=["/home/me/papers/alphafold.pdf", "/home/me/papers/rosettafold.pdf", …] folderContext="2024 folding survey" wait=false
# (poll job_status until done)
query question="What are the main differences between AlphaFold2 and RoseTTAFold?" saveToWiki=true
lint
review
```

### 2. Researcher-swarm pattern

Spawn N sub-agents, each with a narrow topic. Each sub-agent:

1. Calls `select_project` on the shared project (first) — or passes
   `projectPath` on every call (safer when running concurrently).
2. Does `deep_research topic="<their slice>" wait=false`.
3. Polls its own `jobId` to completion.

Because only one mutation per project runs at a time, the sub-agents will
*naturally queue*. That's the point — the wiki ends up consistent. Expect to
see 409s in the middle agents; they should wait, not abort.

### 3. Engineer agent reading a researcher-produced wiki

```
health                        # confirm active project is the research one
wiki://overview                # read the summary
wiki://index                   # list pages by type
graph mode=insights            # surface surprising connections + gaps
query question="What architecture should I use for X given the research?"
# (do NOT save this to the wiki — engineering decisions belong in your own repo)
```

Engineer agents should almost never mutate the wiki. If they notice gaps,
they should tell the user, not patch the research themselves.

### 4. Human-review prep

```
lint semantic=true wait=true
review
# resolve obvious typos / merges with resolve_review_item
# leave contradictions for the human to read
```

Then tell the user: "I've run structural + semantic lint and resolved N review
items. M items remain that need your judgment — they are: …".

## Common mistakes to avoid

- **Calling `query` without `configure_embedding`.** Works but gives weak
  results. Always check `get_llm_config` state first, configure if missing.
- **Shell-reading wiki files directly.** Use `read_page` or `wiki://page/{…}`
  — they respect the project's canonical path handling and don't trip up the
  file watcher.
- **Parallel mutations on the same project from one agent.** Never do this.
  If you need to issue 10 ingests, use a single `import_documents` call with
  a `paths` array — the pipeline batches internally.
- **Hand-writing wiki markdown.** Always go through `query saveToWiki:true`,
  `deep_research`, or `import_documents`. Direct writes desync the index.
  *The only exception* is the one-time bootstrap of `purpose.md` and
  `wiki/overview.md` when a project is freshly created — see "Step 5" above.
- **Treating `review` items as errors.** They're *hints* for humans. Don't
  auto-resolve contradictions without explicit user permission.

## Quick reference card

| Intent                                  | Tool                                 |
| --------------------------------------- | ------------------------------------ |
| Is the daemon up?                       | `health`                             |
| What projects exist?                    | `list_projects`                      |
| Create + activate a project             | `create_project` → `select_project`  |
| Wire providers                          | `configure_llm` / `configure_embedding` / `configure_search` |
| Load files                              | `import_documents` (use a `paths` array) |
| List what we know about                 | `wiki://index` (resource)            |
| Learn the project's purpose             | `wiki://overview` (resource)         |
| Answer "what do we know about X?"       | `query`                              |
| Save an answer for posterity            | `query saveToWiki:true`              |
| Find connections                        | `graph mode=neighbors page=X`        |
| Find gaps / surprises                   | `graph mode=insights`                |
| Fresh web research                      | `deep_research topic=…`              |
| Audit the wiki                          | `lint` (+ `lint semantic:true`)      |
| Work for a human to review              | `review`                             |
| Resolve a review item                   | `resolve_review_item id=… action=…`  |
| Check on a long job                     | `job_status id=…`                    |
| Cancel a long job                       | `cancel_job id=…`                    |

When you're unsure, read `wiki://overview` first, then ask yourself: *"Will
the answer to this question help the next agent?"* If yes, use `query
saveToWiki:true`. If no, use `query` and move on.
