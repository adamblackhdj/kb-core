"use strict";
/**
 * Pure query builders + result merging for the KB search pipeline.
 * No database driver — callers pass rows in and out.
 */

/**
 * Split a raw user query into cleaned terms.
 * @param {string} query
 * @param {{stripPunctuation?: boolean}} [opts]
 *   stripPunctuation=true strips non-alphanumerics from each term (safer for FTS5).
 */
function normalizeTerms(query, opts = {}) {
  const { stripPunctuation = true } = opts;
  let terms = query.trim().split(/\s+/);
  if (stripPunctuation) {
    terms = terms.map((t) => t.replace(/[^a-z0-9]/gi, ""));
  }
  return terms.filter(Boolean);
}

/**
 * Build an FTS5 MATCH string: '"phrase" OR (term AND term)' for multi-word,
 * or the single term for one-word queries.
 */
function buildFtsQuery(terms) {
  if (!terms.length) return "";
  if (terms.length === 1) return terms[0];
  const phrase = terms.join(" ");
  return `"${phrase}" OR (${terms.join(" AND ")})`;
}

/**
 * Build the FTS5 search SQL + params. Caller supplies highlight markers
 * (CLI uses '>>>'/'<<<', bot uses '*'/'*').
 */
function buildFtsSearchSql(terms, { openMark = ">>>", closeMark = "<<<" } = {}) {
  const ftsQuery = buildFtsQuery(terms);
  const sql = `
    SELECT e.id, e.title, e.body, e.category,
           highlight(entries_fts, 0, '${openMark}', '${closeMark}') AS hl_title,
           highlight(entries_fts, 1, '${openMark}', '${closeMark}') AS hl_body,
           rank AS score
    FROM entries_fts
    JOIN entries e ON e.id = entries_fts.rowid
    WHERE entries_fts MATCH ?
    ORDER BY rank
  `;
  return { sql, params: [ftsQuery] };
}

/**
 * LIKE-based fallback for environments without FTS5 (sql.js WASM in the bot).
 * Returns rows shaped identically to the FTS query.
 */
function buildLikeFallbackSql(terms) {
  if (!terms.length) return { sql: "", params: [] };
  const conditions = terms
    .map(() => "(LOWER(e.title) LIKE ? OR LOWER(e.body) LIKE ?)")
    .join(" OR ");
  const params = terms.flatMap((t) => {
    const needle = `%${t.toLowerCase()}%`;
    return [needle, needle];
  });
  const sql = `
    SELECT e.id, e.title, e.body, e.category,
           e.title AS hl_title, e.body AS hl_body,
           500 AS score
    FROM entries e
    WHERE ${conditions}
    ORDER BY e.title
  `;
  return { sql, params };
}

/**
 * Build tag-match SQL + params (rows with any tag matching any search term).
 */
function buildTagSearchSql(terms) {
  const placeholders = terms.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT e.id, e.title, e.body, e.category,
           e.title AS hl_title, e.body AS hl_body, 999 AS score
    FROM entries e
    JOIN entry_tags et ON et.entry_id = e.id
    JOIN tags t ON t.id = et.tag_id
    WHERE t.name IN (${placeholders})
  `;
  return { sql, params: terms.map((t) => t.toLowerCase()) };
}

/**
 * Merge FTS rows and tag rows, dropping tag rows whose entry already appeared
 * in the FTS results. FTS order is preserved.
 */
function mergeResults(ftsRows, tagRows) {
  const seen = new Set(ftsRows.map((r) => r.id));
  const merged = [...ftsRows];
  for (const r of tagRows) {
    if (!seen.has(r.id)) {
      merged.push(r);
      seen.add(r.id);
    }
  }
  return merged;
}

module.exports = {
  normalizeTerms,
  buildFtsQuery,
  buildFtsSearchSql,
  buildLikeFallbackSql,
  buildTagSearchSql,
  mergeResults,
};
