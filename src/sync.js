"use strict";
/**
 * Sync helpers shared between the CLI (scripts/sync-from-clickup.js) and
 * the Slack bot (src/gdrive.js). All pure logic — no database writes, no
 * HTTP calls, no filesystem. Callers own the driver and the I/O.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ClickUp page meta-footer parsing ─────────────────────────────────────────

/**
 * ClickUp may escape underscores and hyphens in the footer (kb\_id, \-->),
 * and may render `---` as `* * *` (horizontal rule). This regex handles both.
 */
const META_REGEX = /\n(?:(?:---|\* \* \*)\n+)?<!-- kb-meta\n([\s\S]*?)(?:\\?-->|-->)/;

/**
 * Split a ClickUp page's markdown content into body + tags + kb_id + related.
 * `related` is an array of kb_ids parsed from a `related: 1, 2, 3` line in the
 * meta footer. Used by both sync paths to populate `entry_relations`.
 * @returns {{ body: string, tags: string[], kb_id: number | null, related: number[] }}
 */
function parseMetaFooter(content) {
  const match = content.match(META_REGEX);
  if (!match) return { body: content.trim(), tags: [], kb_id: null, related: [] };

  const body = content.slice(0, match.index).trim();
  const metaBlock = match[1];

  const tags = [];
  const tagsMatch = metaBlock.match(/^tags:\s*(.+)$/m);
  if (tagsMatch) {
    tags.push(...tagsMatch[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
  }

  let kb_id = null;
  const idMatch = metaBlock.match(/^kb[_\\]*id:\s*(\d+)$/m);
  if (idMatch) kb_id = parseInt(idMatch[1], 10);

  const related = [];
  const relatedMatch = metaBlock.match(/^related:\s*(.+)$/m);
  if (relatedMatch) {
    related.push(
      ...relatedMatch[1]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }

  return { body, tags, kb_id, related };
}

// ── HTML entity decoding ─────────────────────────────────────────────────────

/**
 * Decode the handful of HTML entities ClickUp sometimes emits in page titles.
 * Intentionally minimal — only covers what actually appears in practice.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Page tree flattening ─────────────────────────────────────────────────────

/**
 * Recursively walk the ClickUp page tree, returning only "entry" pages
 * (skipping category folders and children of the _Deleted folder).
 *
 * @param {Array} pages                raw ClickUp page list
 * @param {Set<string>} categoryPageIds  page IDs that represent categories (folders)
 * @param {string} deletedPageId       the _Deleted folder's page ID
 * @returns {Array<{ id: string, name: string, parentPageId: string | null }>}
 */
function flattenPageTree(pages, categoryPageIds, deletedPageId) {
  const out = [];
  function walk(list, parentId) {
    for (const page of list) {
      if (parentId === deletedPageId) {
        // children of _Deleted — skip
      } else if (!categoryPageIds.has(page.id)) {
        out.push({
          id: page.id,
          name: page.name,
          parentPageId: page.parent_page_id || parentId,
        });
      }
      if (page.pages && page.pages.length > 0) {
        walk(page.pages, page.id);
      }
    }
  }
  walk(pages, null);
  return out;
}

// ── KB ID assignment ─────────────────────────────────────────────────────────

/**
 * Preserve kb_id where it already exists on an entry (from the meta footer);
 * auto-assign fresh IDs to the rest, starting at max(existing) + 1000 (or 1000
 * if none). Mutates entries in place.
 */
function assignKbIds(entries) {
  const used = new Set(entries.filter((e) => e.kb_id != null).map((e) => e.kb_id));
  let next = used.size > 0 ? Math.max(...used) + 1000 : 1000;
  for (const e of entries) {
    if (e.kb_id == null) {
      while (used.has(next)) next++;
      e.kb_id = next++;
      used.add(e.kb_id);
    }
  }
  return entries;
}

// ── Retry + backoff ──────────────────────────────────────────────────────────

/**
 * Decide whether a caught error should trigger a retry.
 * Accepts either a structured error (err.status) or a message-string error.
 */
function isRetryable(err) {
  const status = err && err.status;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status < 600);
  }
  const msg = (err && err.message) || "";
  if (msg.includes(" 429 ") || /rate limit/i.test(msg)) return true;
  if (/ 5\d\d /.test(msg)) return true;
  return false;
}

/**
 * Extract a Retry-After hint (seconds) from either the structured field
 * or the error message. Returns null when absent.
 */
function extractRetryAfterSeconds(err) {
  if (err && typeof err.retryAfter === "number") return err.retryAfter;
  const msg = (err && err.message) || "";
  const m = msg.match(/retry[-\s]after["\s:]+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Retry `fn` with exponential backoff + jitter. Up to `maxRetries` attempts
 * (default 5). Honors Retry-After when the error exposes it. Non-retryable
 * errors are thrown immediately.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=5]
 * @param {string} [opts.label]        prefix used in log lines
 * @param {(msg: string) => void} [opts.log=console.log]
 */
async function retryWithBackoff(fn, opts = {}) {
  const { maxRetries = 5, label = "", log = console.log } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (attempt === maxRetries) break;

      let delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s
      const retryAfter = extractRetryAfterSeconds(err);
      if (retryAfter) delayMs = Math.max(delayMs, retryAfter * 1000);
      delayMs += Math.floor(Math.random() * 500); // jitter

      const msg = (err && err.message) || String(err);
      const prefix = label ? `${label}: ` : "";
      log(`[retry] ${prefix}${msg.slice(0, 80)} — attempt ${attempt}/${maxRetries - 1} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = {
  META_REGEX,
  parseMetaFooter,
  decodeHtmlEntities,
  flattenPageTree,
  assignKbIds,
  isRetryable,
  extractRetryAfterSeconds,
  retryWithBackoff,
  sleep,
};
