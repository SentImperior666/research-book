/**
 * MCP resource adapter — exposes wiki content as `wiki://*` URIs so agents can
 * read context with a cheap `resources/read` instead of a full tool call.
 *
 * Static resources (always available once a project is selected):
 *   - wiki://overview   → wiki/overview.md
 *   - wiki://index      → wiki/index.md
 *   - wiki://purpose    → purpose.md
 *   - wiki://schema     → schema.md
 *   - wiki://log        → wiki/log.md
 *
 * Dynamic resources (one per page) follow the URI template:
 *   - wiki://page/{path}  e.g. wiki://page/wiki/entities/openai.md
 */

import type { WikiDaemonClient } from "./client.js"

export interface WikiResource {
  uri: string
  name: string
  description: string
  mimeType: string
}

const STATIC_RESOURCES: ReadonlyArray<{
  uri: string
  name: string
  description: string
  rel: string
}> = [
  {
    uri: "wiki://overview",
    name: "Wiki overview",
    description: "High-level project summary (wiki/overview.md).",
    rel: "wiki/overview.md",
  },
  {
    uri: "wiki://index",
    name: "Wiki index",
    description: "All pages grouped by type (wiki/index.md).",
    rel: "wiki/index.md",
  },
  {
    uri: "wiki://purpose",
    name: "Project purpose",
    description: "Why this wiki exists (purpose.md). Read this first.",
    rel: "purpose.md",
  },
  {
    uri: "wiki://schema",
    name: "Wiki schema",
    description: "Page types, naming conventions, and frontmatter rules (schema.md).",
    rel: "schema.md",
  },
  {
    uri: "wiki://log",
    name: "Activity log",
    description: "Reverse-chronological record of edits (wiki/log.md).",
    rel: "wiki/log.md",
  },
]

export function listStaticResources(): WikiResource[] {
  return STATIC_RESOURCES.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: "text/markdown",
  }))
}

export function listResourceTemplates(): Array<{
  uriTemplate: string
  name: string
  description: string
  mimeType: string
}> {
  return [
    {
      uriTemplate: "wiki://page/{path}",
      name: "Wiki page",
      description:
        "Read any wiki page by its project-relative path (e.g. wiki://page/wiki/entities/openai.md).",
      mimeType: "text/markdown",
    },
  ]
}

/**
 * Fetch the content of a `wiki://*` URI from the daemon. Returns the markdown
 * body; throws if the URI scheme is not `wiki://` or the page is missing.
 */
export async function readResource(
  client: WikiDaemonClient,
  uri: string,
): Promise<{ uri: string; mimeType: string; text: string }> {
  const stat = STATIC_RESOURCES.find((r) => r.uri === uri)
  if (stat) {
    const body = await client.request<{ content: string }>(
      "GET",
      `/api/wiki/page`,
      { query: { path: stat.rel } },
    )
    return { uri, mimeType: "text/markdown", text: body.content }
  }

  const pagePrefix = "wiki://page/"
  if (uri.startsWith(pagePrefix)) {
    const rel = decodeURIComponent(uri.slice(pagePrefix.length))
    const body = await client.request<{ content: string }>(
      "GET",
      `/api/wiki/page`,
      { query: { path: rel } },
    )
    return { uri, mimeType: "text/markdown", text: body.content }
  }

  throw new Error(`unknown wiki resource: ${uri}`)
}
