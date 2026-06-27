"use strict";
/**
 * Pure query builders + result merging for the KB search pipeline.
 * No database driver - callers pass rows in and out.
 */

// Common English stopwords - too short or too frequent to be useful in LIKE searches.
// FTS5 handles these natively; this list is for the LIKE fallback.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "not", "no", "nor",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "has", "have", "had", "having",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
  "they", "them", "their", "this", "that", "these", "those",
  "all", "about", "anything", "something", "nothing",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "up",
  "if", "so", "as", "then", "than", "too", "very",
  "can", "will", "just", "should", "would", "could", "may",
  "cant", "can't",
  "what", "when", "where", "how", "who", "which", "why",
  "get", "got", "go", "went", "find", "seem", "seems", "though",
  "please", "pls", "let", "know", "review", "check", "look",
  "created", "create", "related", "stuck", "qty", "quantity",
]);

function isNoiseTerm(term) {
  const t = String(term || "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
    .toLowerCase();
  return STOPWORDS.has(t) || /^\d+$/.test(t);
}

function uniqueTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = String(term).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

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
  } else {
    terms = terms.map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""));
  }
  terms = terms.filter(Boolean);
  if (removeStopwords) {
    const filtered = terms.filter((t) => !isNoiseTerm(t));
    // If all terms are stopwords, keep the originals so we don't search empty
    if (filtered.length > 0) terms = filtered;
  }
  return uniqueTerms(terms);
}

/**
 * Build an FTS5 MATCH string: '"phrase" OR (term AND term)' for multi-word,
 * or the single term for one-word queries.
 *
 * Terms containing FTS5 special characters (hyphens, colons, etc.) are wrapped
 * in double quotes so FTS5 treats them as literals instead of operators.
 * E.g. "in-store" -> '"in-store"' (prevents FTS5 interpreting as column:prefix).
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
      AND e.title NOT LIKE '[DELETED]%'
      AND e.title NOT LIKE '[PENDING REVIEW]%'
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

  // Filter stopwords for LIKE - short/common words like "a" match everything
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const searchTerms = meaningful.length > 0 ? meaningful : terms;

  // AND - every term must appear somewhere (title or body)
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
           NULL AS score
    FROM entries e
    WHERE ${conditions}
      AND e.title NOT LIKE '[DELETED]%'
      AND e.title NOT LIKE '[PENDING REVIEW]%'
    ORDER BY e.title
    LIMIT 10
  `;
  return { sql, params };
}

/**
 * Lenient FTS5 fallback: OR across terms instead of AND.
 *
 * Why: strict AND misses entries when the user adds extra words the entry
 * doesn't use (e.g. "Wells Fargo bill" - entry uses "payment"/"invoice",
 * never "bill", so AND returns zero). OR lets us find the entry, and the
 * caller filters by minimum term matches so we don't return pure noise.
 */
function buildFtsLenientSql(terms, { openMark = ">>>", closeMark = "<<<" } = {}) {
  if (!terms.length) return { sql: "", params: [] };
  const searchTerms = expandLenientSearchTerms(terms);
  const safe = searchTerms.map((t) =>
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
      AND e.title NOT LIKE '[DELETED]%'
      AND e.title NOT LIKE '[PENDING REVIEW]%'
    ORDER BY rank
    LIMIT 20
  `;
  return { sql, params: [ftsQuery] };
}

/**
 * Lenient LIKE fallback - OR across terms. Same rationale as the FTS variant.
 */
function buildLikeLenientSql(terms) {
  if (!terms.length) return { sql: "", params: [] };
  const meaningful = terms.filter((t) => !isNoiseTerm(t));
  const searchTerms = meaningful.length > 0 ? meaningful : terms;
  const expandedTerms = expandLenientSearchTerms(searchTerms);
  const conditions = expandedTerms
    .map(() => "(LOWER(e.title) LIKE ? OR LOWER(e.body) LIKE ?)")
    .join(" OR ");
  const params = expandedTerms.flatMap((t) => {
    const needle = `%${t.toLowerCase()}%`;
    return [needle, needle];
  });
  // No LIMIT + no ORDER - the caller post-filters by filterByMinTermMatches
  // so we must not drop candidates here. Earlier versions used LIMIT 20 +
  // ORDER BY title, which alphabetically cut the right entry (e.g. entry
  // 6120 "How to Make/Schedule Payments via Wells Fargo Portal…" sorted
  // after 20 other entries that matched a single term, so it was lost
  // before the min-match filter could rescue it).
  const sql = `
    SELECT e.id, e.title, e.body, e.category,
           e.title AS hl_title, e.body AS hl_body,
           NULL AS score
    FROM entries e
    WHERE ${conditions}
      AND e.title NOT LIKE '[DELETED]%'
      AND e.title NOT LIKE '[PENDING REVIEW]%'
  `;
  return { sql, params };
}

/**
 * Post-filter lenient-OR rows: keep only entries whose title+body contains
 * at least `minMatches` distinct search terms. Guards against noise from
 * a single common term matching unrelated entries.
 *
 * Default threshold: ceil(N/2) for N>=3 terms, else N (all terms required
 * for 1- or 2-term queries - OR adds nothing over AND there anyway).
 */
function filterByMinTermMatches(rows, terms, minMatches) {
  if (!terms.length) return rows;
  // Only meaningful (non-stopword) terms count toward signal - otherwise
  // queries like "When do I need to pay..." hit the threshold from filler
  // words alone and return junk.
  const meaningful = terms
    .map((t) => t.toLowerCase())
    .filter((t) => t && !STOPWORDS.has(t));
  const base = meaningful.length > 0 ? meaningful : terms.map((t) => t.toLowerCase());
  let threshold = minMatches ?? (base.length >= 3 ? Math.ceil(base.length / 2) : base.length);
  if (base.includes("swap") && base.includes("sku")) {
    threshold = Math.min(threshold, 3);
  }
  return rows.filter((r) => {
    const hay = ((r.title || "") + " " + (r.body || "")).toLowerCase();
    const compactHay = hay.replace(/[^a-z0-9]/g, "");
    let hits = 0;
    for (const t of base) {
      if (hay.includes(t) || compactHay.includes(t.replace(/[^a-z0-9]/g, ""))) hits++;
      if (hits >= threshold) return true;
    }
    return false;
  });
}

function expandLenientSearchTerms(terms) {
  const out = [];
  const lower = new Set(terms.map((t) => String(t).toLowerCase()));
  for (const term of terms) {
    out.push(term);
    const t = String(term).toLowerCase();
    if (t === "skustack") out.push("sku", "stack");
    if (t === "sellercloud") out.push("sc");
  }
  if (lower.has("payment") && lower.has("order") && (lower.has("child") || lower.has("split") || lower.has("skustack") || lower.has("sellercloud"))) {
    out.push("split", "overpaid", "charged", "sellercloud");
  }
  return uniqueTerms(out);
}

function rowText(row) {
  return `${row.title || ""} ${row.body || ""}`.toLowerCase();
}

function hasCompact(hay, term) {
  const compactHay = hay.replace(/[^a-z0-9]/g, "");
  const compactTerm = String(term).toLowerCase().replace(/[^a-z0-9]/g, "");
  return hay.includes(String(term).toLowerCase()) || compactHay.includes(compactTerm);
}

function isSplitOrderPaymentQuery(terms) {
  const lower = new Set(terms.map((t) => String(t).toLowerCase()));
  return (
    lower.has("payment") &&
    lower.has("order") &&
    (lower.has("child") || lower.has("split") || lower.has("skustack") || lower.has("sellercloud"))
  );
}

function splitOrderPaymentScore(row, terms) {
  const text = rowText(row);
  const title = String(row.title || "").toLowerCase();
  let score = 0;

  for (const term of terms.map((t) => String(t).toLowerCase())) {
    if (hasCompact(title, term)) score += 8;
    else if (hasCompact(text, term)) score += 3;
  }

  if (hasCompact(text, "split order")) score += 80;
  if (hasCompact(text, "child order")) score += 55;
  if (hasCompact(text, "payment landed wrong")) score += 70;
  if (text.includes("overpaid") && text.includes("no payment")) score += 70;
  if (title.includes("payment status") && title.includes("charged")) score += 55;
  if (hasCompact(text, "sellercloud")) score += 35;
  if (hasCompact(text, "sku stack") || hasCompact(text, "skustack")) score += 30;
  if (row.category === "SOP") score += 10;

  if (!terms.map((t) => String(t).toLowerCase()).includes("rental") && title.includes("rental")) {
    score -= 120;
  }

  return score;
}

function termSet(terms) {
  return new Set(terms.map((t) => String(t).toLowerCase()));
}

function hasAny(lower, terms) {
  return terms.some((t) => lower.has(t));
}

function hasAll(lower, terms) {
  return terms.every((t) => lower.has(t));
}

function titleText(row) {
  return String(row.title || "").toLowerCase();
}

function slackShapeScore(row, terms) {
  const lower = termSet(terms);
  const title = titleText(row);
  const text = rowText(row);
  let score = 0;

  if (lower.has("return") && (lower.has("policy") || lower.has("days"))) {
    if (title.includes("returns and exchanges policy")) score += 220;
    if (title.includes("refund policy")) score -= 40;
  }

  if (lower.has("freight") && hasAny(lower, ["shipment", "processing", "checklist", "check"])) {
    if (title.includes("freight and will call order checklist")) score += 240;
    if (title.includes("canadian orders") || title.includes("international orders")) score -= 80;
  }

  if (hasAll(lower, ["cancel", "shopify"]) && hasAny(lower, ["refund", "full"])) {
    if (title.includes("canceling and refunding shopify orders")) score += 220;
    if (title.includes("order cancellations basic full refund")) score += 80;
  }

  if (lower.has("quickbooks") && hasAny(lower, ["invoice", "invoices"])) {
    if (title.includes("quickbooks invoice")) score += 240;
    if (title.includes("wells fargo")) score -= 80;
  }

  if (lower.has("signifyd") && hasAny(lower, ["declined", "flagged", "fraud"])) {
    if (title.includes("canceling a signifyd-declined")) score += 240;
    if (title.includes("signifyd practices")) score += 90;
  }

  if (lower.has("manual") && lower.has("invoice") && hasAny(lower, ["shopify", "customer"])) {
    if (title.includes("creating manual shopify invoices")) score += 230;
    if (title.includes("updating manually received payment")) score -= 70;
  }

  if (
    (hasAny(lower, ["different", "substitute", "replacement", "replaced", "swap", "cancelled", "canceled"]) && hasAny(lower, ["sku", "kit", "stand"])) ||
    (lower.has("changing") && lower.has("items") && lower.has("shopify"))
  ) {
    if (title.includes("swap one sku with another in shopify")) score += 230;
    if (title.includes("swap one sku with another in sellercloud")) score += 140;
    if (title.includes("amazon order") || title.includes("unfulfillable")) score -= 100;
  }

  if (
    (hasAny(lower, ["investigate", "legit", "legitimate"]) && lower.has("fraud")) ||
    (lower.has("verify") && hasAny(lower, ["business", "real", "trust", "dollar"]))
  ) {
    if (title.includes("verify big-ticket leads")) score += 240;
    if (title.includes("uber/lyft")) score += 80;
  }

  if (lower.has("payment") && hasAny(lower, ["order", "orders"]) && hasAny(lower, ["dropshipped", "dropship", "paid"])) {
    if (title.includes("fixing a split order")) score += 260;
    if (title.includes("payment status") && title.includes("charged")) score += 120;
    if (title.includes("splitting payment methods")) score -= 80;
  }

  if (lower.has("split") && lower.has("payment") && lower.has("shopify")) {
    if (title.includes("splitting payment methods")) score += 240;
    if (title.includes("fixing a split order already drop shipped")) score -= 50;
  }

  if (hasAny(lower, ["acima", "snap", "aff", "amerifirst", "financing"]) && hasAny(lower, ["tax", "approved", "card", "split", "cheapest"])) {
    if (title.includes("financing app processing practices")) score += 240;
    if (!lower.has("synchrony") && title.includes("synchrony financing")) score -= 50;
  }

  // Small generic tie-breaker once a scenario has fired.
  if (score !== 0) {
    for (const term of lower) {
      if (hasCompact(title, term)) score += 4;
      else if (hasCompact(text, term)) score += 1;
    }
    if (row.category === "SOP") score += 4;
  }

  return score;
}

function rankRowsByQuery(rows, terms) {
  const useSplitScore = isSplitOrderPaymentQuery(terms);
  const scored = rows
    .map((row, index) => ({
      row,
      index,
      score: (useSplitScore ? splitOrderPaymentScore(row, terms) : 0) + slackShapeScore(row, terms),
    }));
  if (!scored.some((item) => item.score !== 0)) return rows;
  return scored
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((item) => item.row);
}

/**
 * Build tag-match SQL + params (rows with any tag matching any search term).
 */
function buildTagSearchSql(terms) {
  const placeholders = terms.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT e.id, e.title, e.body, e.category,
           e.title AS hl_title, e.body AS hl_body, NULL AS score
    FROM entries e
    JOIN entry_tags et ON et.entry_id = e.id
    JOIN tags t ON t.id = et.tag_id
    WHERE t.name IN (${placeholders})
      AND e.title NOT LIKE '[DELETED]%'
      AND e.title NOT LIKE '[PENDING REVIEW]%'
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
  expandLenientSearchTerms,
  rankRowsByQuery,
  buildTagSearchSql,
  mergeResults,
};
