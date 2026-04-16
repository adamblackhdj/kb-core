"use strict";
/**
 * kb-core — shared KB search logic for the CLI and the Slack bot.
 *
 * Both codebases import from here so search rules, stopwords, and vendor
 * Excel matching stay consistent. The SQLite driver + write paths stay in
 * each caller (native node:sqlite for CLI, sql.js for bot).
 */

const { VENDOR_STOP_WORDS } = require("./stopwords");
const {
  normalizeTerms,
  buildFtsQuery,
  buildFtsSearchSql,
  buildLikeFallbackSql,
  buildFtsLenientSql,
  buildLikeLenientSql,
  filterByMinTermMatches,
  buildTagSearchSql,
  mergeResults,
} = require("./queries");
const { searchExcel } = require("./excel");
const sync = require("./sync");

module.exports = {
  VENDOR_STOP_WORDS,
  normalizeTerms,
  buildFtsQuery,
  buildFtsSearchSql,
  buildLikeFallbackSql,
  buildFtsLenientSql,
  buildLikeLenientSql,
  filterByMinTermMatches,
  buildTagSearchSql,
  mergeResults,
  searchExcel,
  // Sync helpers (shared between CLI sync-from-clickup.js and bot gdrive.js)
  parseMetaFooter: sync.parseMetaFooter,
  decodeHtmlEntities: sync.decodeHtmlEntities,
  flattenPageTree: sync.flattenPageTree,
  assignKbIds: sync.assignKbIds,
  isRetryable: sync.isRetryable,
  extractRetryAfterSeconds: sync.extractRetryAfterSeconds,
  retryWithBackoff: sync.retryWithBackoff,
  sleep: sync.sleep,
};
