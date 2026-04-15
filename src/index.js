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
  buildTagSearchSql,
  mergeResults,
} = require("./queries");
const { searchExcel } = require("./excel");

module.exports = {
  VENDOR_STOP_WORDS,
  normalizeTerms,
  buildFtsQuery,
  buildFtsSearchSql,
  buildLikeFallbackSql,
  buildTagSearchSql,
  mergeResults,
  searchExcel,
};
