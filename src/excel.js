"use strict";
/**
 * Vendor Reference Notes (Excel) search.
 * Matches search terms against the first column (vendor name) only,
 * using word boundaries to avoid false positives.
 */

const fs = require("fs");
const { VENDOR_STOP_WORDS } = require("./stopwords");

const SKIP_SHEETS = new Set(["Other"]);

/**
 * @param {string[]} terms  Cleaned search terms (already tokenized).
 * @param {object} opts
 * @param {string} opts.excelPath  Path to the .xlsx file.
 * @param {object} [opts.xlsx]     Optional XLSX module (defaults to require("xlsx")).
 * @param {number} [opts.limit=10]
 * @returns {Array<{sheet: string, fields: object, nameScore: number}>}
 */
function searchExcel(terms, opts) {
  const { excelPath, limit = 10 } = opts || {};
  if (!excelPath || !fs.existsSync(excelPath)) return [];

  let XLSX = opts && opts.xlsx;
  if (!XLSX) {
    try { XLSX = require("xlsx"); } catch { return []; }
  }

  let workbook;
  try {
    workbook = XLSX.readFile(excelPath, { cellText: true, cellDates: false });
  } catch {
    return [];
  }

  const vendorTerms = terms
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !VENDOR_STOP_WORDS.has(t));
  if (!vendorTerms.length) return [];

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
      const nameScore = vendorTerms.filter((t) => {
        const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        return re.test(vendorName);
      }).length;
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

module.exports = { searchExcel };
