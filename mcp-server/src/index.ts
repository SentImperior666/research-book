#!/usr/bin/env node
/**
 * stdio MCP entry point.
 *
 * Run via `npx research-book-mcp` (after `npm i -g`) or `node dist/index.js`.
 * Cursor / Claude Code spawn this process and speak JSON-RPC over stdin/stdout.
 *
 * The server is a thin adapter over the desktop daemon at http://127.0.0.1:19827;
 * the actual business logic lives in `src/lib/*` inside the Tauri app.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { WikiDaemonClient } from "./client.js"
import { registerTools } from "./tools.js"
import { registerPrompts } from "./prompts.js"
import {
  listResourceTemplates as listResourceTemplatesUnused,
  listStaticResources,
  readResource,
} from "./resources.js"

void listResourceTemplatesUnused

const SERVER_NAME = "research-book"
const SERVER_VERSION = "0.1.0"

async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
        logging: {},
      },
      instructions:
        "Tools for the LLM Wiki desktop app. Start with `health` to verify the daemon is running and `list_projects` to see what projects exist. The Quick Start workflow is: `create_project` → `configure_llm` → `import_documents` → `query` / `graph` / `review` / `lint`. Use the `wiki://*` resources (`wiki://overview`, `wiki://index`, `wiki://schema`, `wiki://purpose`, `wiki://log`, and `wiki://page/{path}`) for cheap context reads. Three workflow prompts are exposed — load `quickstart` first; `research_sprint` and `wiki_audit` cover the two most common multi-step agent tasks.",
    },
  )

  // Construct the client unconditionally — token resolution is deferred to
  // the first request, so a missing daemon doesn't kill the stdio handshake
  // (the inspector reports that as "Command not found, transports removed",
  // which is *not* a path-resolution problem despite the wording).
  const client = new WikiDaemonClient()

  registerTools(server, client)
  registerResources(server, client)
  registerPrompts(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Keep the process alive until the transport closes.
  process.stderr.write(`[research-book-mcp] connected on stdio (v${SERVER_VERSION})\n`)
}

function registerResources(server: McpServer, client: WikiDaemonClient): void {
  for (const r of listStaticResources()) {
    server.registerResource(
      r.uri,
      r.uri,
      { title: r.name, description: r.description, mimeType: r.mimeType },
      async (uri) => {
        const body = await readResource(client, uri.href)
        return { contents: [{ uri: uri.href, mimeType: body.mimeType, text: body.text }] }
      },
    )
  }

  server.registerResource(
    "wiki-page",
    new ResourceTemplate("wiki://page/{+path}", { list: undefined }),
    {
      title: "Wiki page",
      description: "Read any wiki page by project-relative path.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const body = await readResource(client, uri.href)
      return { contents: [{ uri: uri.href, mimeType: body.mimeType, text: body.text }] }
    },
  )
}

main().catch((err) => {
  process.stderr.write(`[research-book-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
