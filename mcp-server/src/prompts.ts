/**
 * MCP prompts.
 *
 * These are *server-side prompt templates* — any MCP client (Cursor, Claude
 * Code, Claude Desktop, …) can list them via `prompts/list` and load them
 * via `prompts/get`. They complement `tools/list` by teaching the client
 * *how* to use the tools (workflow ordering, concurrency, decision rules)
 * rather than just what each individual tool does.
 *
 * The content here is intentionally short and actionable. For the full
 * reference, see `.claude/skills/research-book/SKILL.md` in the repo.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

function user(text: string): { role: "user"; content: { type: "text"; text: string } } {
  return { role: "user", content: { type: "text", text } }
}

export function registerPrompts(server: McpServer): void {
  // ── 1. Quick Start orientation ─────────────────────────────────────────────
  server.registerPrompt(
    "quickstart",
    {
      title: "Quick Start — orient yourself in the LLM Wiki",
      description:
        "Read this before your first call. Explains the Quick Start workflow, when to use which tool, and the per-project write lock. Takes no arguments.",
    },
    async () => ({
      description: "LLM Wiki Quick Start orientation",
      messages: [
        user(`You are about to work with the LLM Wiki via the \`research-book\` MCP server.
Follow this workflow:

1. **Check the daemon.** Call \`health\`. If it returns \`daemon unreachable\`, tell
   the user to launch the desktop app and stop — don't try to work around it.
2. **Find or create a project.** Call \`list_projects\`. If the user's topic has no
   project yet, call \`create_project\` with a template id from \`list_templates\`,
   then \`select_project\` so subsequent calls can omit \`projectPath\`.
3. **Bootstrap the project charter (CRITICAL for new projects).** Every
   freshly created project ships with two *template* files, not content:
     - \`<projectPath>/purpose.md\` — the charter (research question /
       hypothesis / scope / success criteria, or equivalent for non-research
       templates).
     - \`<projectPath>/wiki/overview.md\` — the public summary (this one is
       indexed, so \`query\` will cite it).
   Read both (\`read_page\` for \`wiki/overview.md\`; your file-read tool for
   \`purpose.md\` at the project root). **Interview the user** to fill the
   sections the templates expose — ask only what the placeholders ask for,
   don't invent structure. Edit both files in place with your file-editing
   tool, preserving frontmatter. This is the **one exception** to the
   "never hand-write wiki markdown" rule below — \`purpose.md\` and
   \`wiki/overview.md\` are scaffolding, not synthesis. Skipping this step
   is why fresh wikis return "this wiki appears to be uninitialized" to
   every query.
4. **Wire providers.** Check \`get_llm_config\`. If unset or missing for this
   session's needs: \`configure_llm\`, then \`configure_embedding\` (strongly
   recommended — without it \`query\` quality degrades sharply), then
   \`configure_search\` only if deep research is in scope.
5. **Ingest sources.** Use a single \`import_documents\` call with a \`paths\`
   array. Always set \`folderContext\` to a short label (e.g.
   \`"2024 literature review"\`). Prefer \`wait: false\` for >3 files and poll
   \`job_status\`.
6. **Read before asking.** Fetch the \`wiki://overview\` and \`wiki://index\`
   resources to understand what exists. Use \`read_page\` for a specific page,
   \`query\` for a concept ("what do we know about X?"), \`graph mode=neighbors\`
   for connections, \`graph mode=insights\` for gaps and surprises.
7. **Save answers that will recur** with \`query saveToWiki:true\`. Never
   hand-write markdown into the wiki via shell/file tools — it desyncs the
   vector index and graph. Always go through \`query saveToWiki:true\`,
   \`deep_research\`, or \`import_documents\`. *(Exception: the one-time
   bootstrap of \`purpose.md\` and \`wiki/overview.md\` in step 3.)*
8. **Audit before handing back.** \`lint\` for broken links / structural
   issues, \`lint semantic:true\` for contradictions (slower). \`review\` to
   see what the pipeline flagged for humans.

**Concurrency.** The daemon enforces a per-project exclusive write lock.
Mutating tools (\`import_documents\`, \`query saveToWiki:true\`, \`lint\`,
\`deep_research\`, \`configure_*\`) on the same project are serialized. A second
mutation while one is in flight returns HTTP 409 with \`Retry-After: 5\`.
Handle it by calling \`job_status\` to see who holds the lock, then either
wait for that job or (only if the user asked) \`cancel_job\`. Don't spin in a
tight retry loop. Read-only tools are never blocked.

**Where to write.** Raw files live in \`raw/sources/\` and are immutable —
never modify them. Curated pages live in \`wiki/\` and are produced via the
pipeline. The knowledge graph is derived automatically from \`[[wikilinks]]\`.

Start now: call \`health\`, then \`list_projects\`, and tell the user what you
found before taking any action.`),
      ],
    }),
  )

  // ── 2. Research sprint (fan-out pattern) ──────────────────────────────────
  server.registerPrompt(
    "research_sprint",
    {
      title: "Research sprint — ingest sources and answer a question",
      description:
        "End-to-end research workflow: ingest a batch of documents, run deep research on gaps, answer the user's question with saved-to-wiki citations, then audit.",
      argsSchema: {
        topic: z
          .string()
          .min(1)
          .describe("The research question or topic the user wants an answer to."),
        sources: z
          .string()
          .optional()
          .describe(
            "Optional. Paths or folder globs of source material to ingest first. If omitted, work from whatever is already in the wiki.",
          ),
        project_path: z
          .string()
          .optional()
          .describe("Absolute path to an existing project. Omit to use the active project."),
      },
    },
    async ({ topic, sources, project_path }) => {
      const projectClause = project_path
        ? `Pass \`projectPath: "${project_path}"\` on every mutating call for this sprint.`
        : `Confirm the active project with \`health\` first. If none, ask the user which project to use and call \`select_project\`.`
      const ingestClause = sources
        ? `Sources to ingest (expand globs if needed):
\`\`\`
${sources}
\`\`\`
Call \`import_documents\` **once** with the full \`paths\` array and
\`folderContext\` set to something descriptive (e.g. a dated label for this
sprint). Use \`wait: false\` and poll \`job_status\` while you plan.`
        : `No new sources were provided — work from existing wiki content. Start by reading \`wiki://overview\` and \`wiki://index\`.`
      return {
        description: `Research sprint on: ${topic}`,
        messages: [
          user(`You are running a research sprint for this topic:

> ${topic}

Execute it in this order and narrate each step to the user so they can follow along.

**0. Setup.** ${projectClause}

**1. Ingest (if new sources).** ${ingestClause}

**2. Survey.** While ingest runs (or up front if no new sources), read the
\`wiki://overview\` and \`wiki://index\` resources. Then call
\`graph mode=insights\` to learn what gaps and surprising connections already
exist. Summarize to the user what the wiki currently knows about the topic.

**3. Fill gaps (if meaningful gaps exist).** For each gap that materially
affects the answer, call \`deep_research\` with a tightly-scoped subtopic and
\`wait: false\`. Queue a handful in sequence — remember the per-project write
lock will naturally serialize them; expect 409s if you fire them too fast and
back off for 5s. Do **not** kick off unbounded research; 2–4 well-chosen
subtopics is usually enough.

**4. Answer.** Once ingest and any deep-research jobs are done, call
\`query\` with the user's question and \`saveToWiki: true\`. The answer will
be persisted under \`wiki/queries/\` and referenced by future queries.

**5. Audit.** Run \`lint\` (structural). If there are fresh \`[[broken-link]]\`
warnings pointing at pages you'd expect to exist, decide case by case:
create the missing page via \`deep_research\` or \`query saveToWiki:true\`, or
leave it as a deliberate TODO. Call \`review\` and resolve obvious items with
\`resolve_review_item\`; leave ambiguous ones for the human.

**6. Report.** Tell the user:
  - what was ingested,
  - what the saved answer page path is,
  - what review items remain,
  - any gaps you consciously did not fill and why.

Do not hand-write wiki markdown through file tools — everything must go
through the MCP server so the index and graph stay consistent. If any
mutation returns 409 Conflict, inspect \`job_status\`, wait or cancel, then
retry — don't loop.`),
        ],
      }
    },
  )

  // ── 3. Wiki audit (human-review prep) ──────────────────────────────────────
  server.registerPrompt(
    "wiki_audit",
    {
      title: "Wiki audit — lint, triage review, surface gaps",
      description:
        "Run the structural (and optionally semantic) linter, triage review items, summarize the wiki's shape via the graph, and produce a short report for a human reviewer.",
      argsSchema: {
        semantic: z
          .string()
          .optional()
          .describe("Pass 'true' to also run the slower semantic linter (LLM-backed contradiction detection)."),
        project_path: z
          .string()
          .optional()
          .describe("Absolute path to an existing project. Omit to use the active project."),
      },
    },
    async ({ semantic, project_path }) => {
      const wantsSemantic = (semantic ?? "").toLowerCase() === "true"
      const projectClause = project_path
        ? `Pass \`projectPath: "${project_path}"\` on every call.`
        : `Use the active project (confirm with \`health\`).`
      const lintClause = wantsSemantic
        ? `Run both \`lint\` passes: first \`lint\` (fast structural), then \`lint semantic:true\` (slower, LLM-backed). The second pass will hit the write lock while running, so queue it after the first returns.`
        : `Run \`lint\` (structural only — the semantic pass was not requested). Offer the user to follow up with \`lint semantic:true\` if the structural pass is clean.`
      return {
        description: "Audit the current wiki and produce a reviewer-ready report.",
        messages: [
          user(`Produce an audit report for this wiki in a format a human reviewer
can action. ${projectClause}

**1. Shape of the wiki.** Read \`wiki://overview\` and \`wiki://index\` as
resources. Call \`graph mode=communities\` to learn the major topic clusters
and most-linked nodes.

**2. Lint.** ${lintClause} For each warning, group by type (\`broken-link\`,
\`orphan\`, \`no-outlinks\`, structural violations, and — if semantic —
\`contradiction\`). Don't dump the raw list.

**3. Review queue.** Call \`review\` and categorize items into:
  - **Safe auto-resolves** (obvious typos, duplicate-merge confirmations) —
    resolve these with \`resolve_review_item\` and note each one.
  - **Needs human judgment** (contradictions between sources, low-confidence
    merges across disagreements) — leave them for the reviewer.

**4. Insights.** Call \`graph mode=insights\` once and pick the two or three
findings most relevant to the user's stated goals. Do not paste the raw
output — summarize.

**5. Report.** Produce a single markdown summary with these sections:
  - *Wiki shape* (1–2 lines + community list).
  - *Lint results* (count by type; top 5 actionable).
  - *Review items* — *auto-resolved* (list) and *needs human* (list with
    links to the source pages via \`wiki://page/{path}\`).
  - *Recommended next steps* (1–3 concrete actions for the human).

Do not mutate the wiki beyond \`resolve_review_item\` unless the user asks
for it explicitly. The goal is a reviewer-ready report, not unilateral
edits.`),
        ],
      }
    },
  )
}
