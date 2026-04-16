"use strict";
/**
 * Vendor Reference Notes (Excel) search.
 * Two-pass match against each vendor row:
 *   1. Token regex — each filtered term must match \bword\b in the vendor name.
 *   2. Raw-query fallback — if pass 1 misses and `opts.query` is set, try
 *      variants of the vendor name (slash segments, & ↔ "and"/" & ", full
 *      name) as substrings of the lowercased user query. This catches short
 *      &-joined abbreviations like "K&M" that the tokenizer can't preserve:
 *      "K and M" splits into three stopword/too-short tokens, and "K&M" is
 *      stripped to "KM" by normalizeTerms — neither survives the filter.
 */

const fs = require("fs");
const { VENDOR_STOP_WORDS } = require("./stopwords");
const { decodeHtmlEntities } = require("./sync");

const SKIP_SHEETS = new Set(["Other"]);

function vendorNameVariants(nameLc) {
  const variants = new Set();
  variants.add(nameLc);
  const segments = nameLc
    .split(/\s*[/,|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    variants.add(seg);
    if (seg.includes("&")) {
      variants.add(seg.replace(/\s*&\s*/g, " and "));
      variants.add(seg.replace(/\s*&\s*/g, " & "));
    }
  }
  return [...variants].filter((v) => v.length >= 3);
}

function variantMatchesQuery(variant, queryLc) {
  if (/[\s&]/.test(variant)) {
    return queryLc.includes(variant);
  }
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(queryLc);
}

/**
 * @param {string[]} terms  Cleaned search terms (already tokenized).
 * @param {object} opts
 * @param {string} opts.excelPath  Path to the .xlsx file.
 * @param {string} [opts.query]    Original untokenized user query. When set,
 *                                 rows that miss the token pass get a second
 *                                 chance via vendor-name-variant substring.
 * @param {object} [opts.xlsx]     Optional XLSX module (defaults to require("xlsx")).
 *                                 When provided, the fs.existsSync check is
 *                                 bypassed so tests can inject in-memory mocks.
 * @param {number} [opts.limit=10]
 * @returns {Array<{sheet: string, fields: object, nameScore: number}>}
 */
function searchExcel(terms, opts) {
  const { excelPath, limit = 10 } = opts || {};
  // Slack HTML-escapes `&`/`<`/`>` in app_mention payloads, so "K&M" arrives
  // as "K&amp;M". Decoding here means the variant-substring fallback below
  // can look for the natural "k&m" instead of chasing "k&amp;m".
  const query = opts && typeof opts.query === "string"
    ? decodeHtmlEntities(opts.query)
    : undefined;
  const injectedXlsx = opts && opts.xlsx;
  if (!excelPath) return [];
  if (!injectedXlsx && !fs.existsSync(excelPath)) {
    // Surface this — a missing Vendor spreadsheet used to fail silently and
    // returned zero vendor matches with no indication anything was wrong.
    console.warn(`[kb-core] vendor spreadsheet not found at ${excelPath}`);
    return [];
  }

  let XLSX = injectedXlsx;
  if (!XLSX) {
    try { XLSX = require("xlsx"); } catch { return []; }
  }

  let workbook;
  try {
    workbook = XLSX.readFile(excelPath, { cellText: true, cellDates: false });
  } catch (err) {
    console.warn(`[kb-core] failed to read vendor spreadsheet ${excelPath}: ${err.message}`);
    return [];
  }

  const vendorTerms = terms
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !VENDOR_STOP_WORDS.has(t));
  const queryLc = typeof query === "string" ? query.toLowerCase() : "";
  if (!vendorTerms.length && !queryLc) return [];

  const results = [];
  for (const sheetName of workbook.SheetNames) {
    if (SKIP_SHEETS.has(sheetName)) continue;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rows.length < 2) continue;
    const headers = rows[0].map((h) => String(h ?? "").trim());

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].map((c) => String(c ?? "").trim());
      if (cells.every((c) => c === "")) continue;

      const vendorName = (cells[0] || "").toLowerCase();
      let nameScore = vendorTerms.filter((t) => {
        const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        return re.test(vendorName);
      }).length;

      if (nameScore === 0 && queryLc) {
        for (const v of vendorNameVariants(vendorName)) {
          if (variantMatchesQuery(v, queryLc)) {
            nameScore = 1;
            break;
          }
        }
      }

      if (nameScore === 0) continue;

      const fields = {};
      for (let col = 0; col < headers.length; col++) {
        if (headers[col] && cells[col]) fields[headers[col]] = cells[col];
      }
      results.push({ sheet: sheetName, fields, nameScore });
    }
  }

  results.sort((a, b) => b.nameScore - a.nameScore);
  return results.slice(0, limit);
}

module.exports = { searchExcel, vendorNameVariants, variantMatchesQuery };
