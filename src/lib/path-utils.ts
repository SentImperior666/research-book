/**
 * Normalize a path to use forward slashes (works on both macOS and Windows).
 * Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * Join path segments with forward slashes.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/"))
    .join("/")
    .replace(/\/+/g, "/")
}

/**
 * Get the filename from a path (handles both / and \).
 */
export function getFileName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

/**
 * Get the file stem (filename without extension).
 */
export function getFileStem(p: string): string {
  const name = getFileName(p)
  const lastDot = name.lastIndexOf(".")
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

/**
 * Get relative path from base.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
  const normalFull = normalizePath(fullPath)
  const normalBase = normalizePath(basePath).replace(/\/$/, "")
  if (normalFull.startsWith(normalBase + "/")) {
    return normalFull.slice(normalBase.length + 1)
  }
  return normalFull
}

/**
 * Resolve `rel` against `base` and ensure the result stays inside `base`.
 * Collapses `.` / `..` segments and rejects absolute / drive paths so callers
 * cannot escape the project root via `../` or `C:\...`.
 *
 * Throws on traversal attempts; returns the normalized absolute path otherwise.
 */
export function resolveWithinBase(base: string, rel: string): string {
  const normalizedBase = normalizePath(base).replace(/\/$/, "")
  const normalizedRel = normalizePath(rel)

  if (normalizedRel.startsWith("/") || /^[A-Za-z]:\//.test(normalizedRel)) {
    throw new Error(`path must be project-relative, not absolute: ${rel}`)
  }

  const segments = normalizedRel.split("/")
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (resolved.length === 0) {
        throw new Error(`path escapes project root: ${rel}`)
      }
      resolved.pop()
      continue
    }
    resolved.push(seg)
  }

  return `${normalizedBase}/${resolved.join("/")}`
}
