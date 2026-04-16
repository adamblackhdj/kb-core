"use strict";
/**
 * Pure query builders + result merging for the KB search pipeline.
 * No database driver — callers pass rows in and out.
 */

// Common English stopwords — too short or too frequent to be useful in LIKE searches.
// FTS5 handles these natively; this list is for the LIKE fallback.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "not", "no", "nor",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "has", "have", "had", "having",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
  "they", "them", "their", "this", "that", "these", "those",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "up",
  "if", "so", "as", "then", "than", "too", "very",
  "can", "will", "just", "should", "would", "could",
  "what", "when", "where", "how", "who", "which", "why",
  "get", "got", "go", "went",
]);

/**
 * Split a raw user query into cleaned terms.
 * @param {string} query
 * @param {{stripPunctuation?: boolean, removeStopwords?: boolean}} [opts]
 *   stripPunctuation=true strips non-alphanumerics from each term (safer for FTS5).
 *   removeStopwords=true drops common English stopwords (used by LIKE fallback).
 */
function normalizeTerms(query, opts = {}) {
  const { stripPunctuation = true, removeStopwords = false } = opts;
  let terms = query.trim().split(/\s+/);
  if (stripPunctuation) {
    terms = terms.map((t) => t.replace(/[^a-z0-9]/gi, ""));
  }
  terms = terms.filter(Boolean);
  if (removeStopwords) {
    const filtered = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
    // If all terms are stopwords, keep the originals so we don't search empty
    if (filtered.length > 0) terms = filtered;
  }
  return terms;
}

/**
 * Build an FTS5 MATCH string: '"phrase" OR (term AND term)' for multi-word,
 * or the single term for one-word queries.
 *
 * Terms containing FTS5 special characters (hyphens, colons, etc.) are wrapped
 * in double quotes so FTS5 treats them as literals instead of operators.
 * E.g. "in-store" → '"in-store"' (prevents FTS5 interpreting as column:prefix).
 */
function buildFtsQuery(terms) {
  if (!terms.length) return "";
  const safe = terms.map((t) =>
    /[^a-z0-9*]/i.test(t) ? `"${t.replace(/"/g, "")}"` : t
  );
  if (safe.length === 1) return safe[0];
  const phrase = terms.join(" ");
  return `"${phrase}" OR (${safe.join(" AND ")})`;
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

  // Filter stopwords for LIKE — short/common words like "a" match everything
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const searchTerms = meaningful.length > 0 ? meaningful : terms;

  // AND — every term must appear somewhere (title or body)
  const conditions = searchTerms
    .map(() => "(LOWER(e.title) LIKE ? OR LOWER(e.body) LIKE ?)")
    .join(" AND ");
  const params = searchTerms.flatMap((t) => {
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
    LIMIT 10
  `;
  return { sql, params };
}

/**
 * Lenient FTS5 fallback: OR across terms instead of AND.
 *
 * Why: strict AND misses entries when the user adds extra words the entry
 * doesn't use (e.g. "Wells Fargo bill" — entry uses "payment"/"invoice",
 * never "bill", so AND returns zero). OR lets us find the entry, and the
 * caller filters by minimum term matches so we don't return pure noise.
 */
function buildFtsLenientSql(terms, { openMark = ">>>", closeMark = "<<<" } = {}) {
  if (!terms.length) return { sql: "", params: [] };
  const safe = terms.map((t) =>
    /[^a-z0-9*]/i.test(t) ? `"${t.replace(/"/g, "")}"` : t
  );
  const ftsQuery = safe.join(" OR ");
  const sql = `
    SELECT e.id, e.title, e.body, e.category,
           highlight(entries_fts, 0, '${openMark}', '${closeMark}') AS hl_title,
           highlight(entries_fts, 1, '${openMark}', '${closeMark}') AS hl_body,
           rank AS score
    FROM entries_fts
    JOIN entries e ON e.id = entries_fts.rowid
    WHERE entries_fts MATCH ?
    ORDER BY rank
    LIMIT 20
  `;
  return { sql, params: [ftsQuery] };
}

/**
 * Lenient LIKE fallback — OR across terms. Same rationale as the FTS variant.
 */
function buildLikeLenientSql(terms) {
  if (!terms.length) return { sql: "", params: [] };
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const searchTerms = meaningful.length > 0 ? meaningful : terms;
  const conditions = searchTerms
    .map(() => "(LOWER(e.title) LIKE ? OR LOWER(e.body) LIKE ?)")
    .join(" OR ");
  const params = searchTerms.flatMap((t) => {
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
    LIMIT 20
  `;
  return { sql, params };
}

/**
 * Post-filter lenient-OR rows: keep only entries whose title+body contains
 * at least `minMatches` distinct search terms. Guards against noise from
 * a single common term matching unrelated entries.
 *
 * Default threshold: ceil(N/2) for N≥3 terms, else N (all terms required
 * for 1- or 2-term queries — OR adds nothing over AND there anyway).
 */
function filterByMinTermMatches(rows, terms, minMatches) {
  if (!terms.length) return rows;
  // Only meaningful (non-stopword) terms count toward signal — otherwise
  // queries like "When do I need to pay..." hit the threshold from filler
  // words alone and return junk.
  const meaningful = terms
    .map((t) => t.toLowerCase())
    .filter((t) => t && !STOPWORDS.has(t));
  const base = meaningful.length > 0 ? meaningful : terms.map((t) => t.toLowerCase());
  const threshold = minMatches ?? (base.length >= 3 ? Math.ceil(base.length / 2) : base.length);
  return rows.filter((r) => {
    const hay = ((r.title || "") + " " + (r.body || "")).toLowerCase();
    let hits = 0;
    for (const t of base) {
      if (hay.includes(t)) hits++;
      if (hits >= threshold) return true;
    }
    return false;
  });
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
  buildFtsLenientSql,
  buildLikeLenientSql,
  filterByMinTermMatches,
  buildTagSearchSql,
  mergeResults,
};
