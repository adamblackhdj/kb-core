"use strict";
/**
 * Tiny assert-based test runner — zero dependencies.
 * Covers the pure-logic exports of kb-core.
 */

const assert = require("node:assert/strict");
const {
  VENDOR_STOP_WORDS,
  normalizeTerms,
  buildFtsQuery,
  buildFtsSearchSql,
  buildLikeFallbackSql,
  buildTagSearchSql,
  mergeResults,
} = require("../src/index");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

console.log("kb-core tests");

test("VENDOR_STOP_WORDS includes common business terms", () => {
  assert.equal(VENDOR_STOP_WORDS.has("customer"), true);
  assert.equal(VENDOR_STOP_WORDS.has("shipping"), true);
  assert.equal(VENDOR_STOP_WORDS.has("amazon"), true);
  assert.equal(VENDOR_STOP_WORDS.has("jbl"), false);
});

test("normalizeTerms strips punctuation by default", () => {
  assert.deepEqual(normalizeTerms("drop-ship fee?"), ["dropship", "fee"]);
});

test("normalizeTerms can preserve punctuation", () => {
  assert.deepEqual(
    normalizeTerms("drop-ship fee?", { stripPunctuation: false }),
    ["drop-ship", "fee?"]
  );
});

test("normalizeTerms drops empty tokens", () => {
  assert.deepEqual(normalizeTerms("   a   b   "), ["a", "b"]);
});

test("buildFtsQuery single term", () => {
  assert.equal(buildFtsQuery(["foo"]), "foo");
});

test("buildFtsQuery multi term uses phrase OR AND", () => {
  assert.equal(buildFtsQuery(["drop", "ship"]), `"drop ship" OR (drop AND ship)`);
});

test("buildFtsQuery empty returns empty string", () => {
  assert.equal(buildFtsQuery([]), "");
});

test("buildFtsSearchSql uses default markers", () => {
  const { sql, params } = buildFtsSearchSql(["foo"]);
  assert.match(sql, />>>/);
  assert.match(sql, /<<</);
  assert.deepEqual(params, ["foo"]);
});

test("buildFtsSearchSql honors custom markers", () => {
  const { sql } = buildFtsSearchSql(["foo"], { openMark: "*", closeMark: "*" });
  assert.match(sql, /'\*', '\*'/);
});

test("buildLikeFallbackSql produces 2 params per term", () => {
  const { sql, params } = buildLikeFallbackSql(["foo", "bar"]);
  assert.equal(params.length, 4);
  assert.equal(params[0], "%foo%");
  assert.match(sql, /LIKE/);
});

test("buildLikeFallbackSql empty returns empty", () => {
  const { sql, params } = buildLikeFallbackSql([]);
  assert.equal(sql, "");
  assert.deepEqual(params, []);
});

test("buildTagSearchSql lowercases terms", () => {
  const { sql, params } = buildTagSearchSql(["FOO", "Bar"]);
  assert.deepEqual(params, ["foo", "bar"]);
  assert.match(sql, /IN \(\?, \?\)/);
});

test("mergeResults preserves FTS order and skips duplicates", () => {
  const fts = [{ id: 1 }, { id: 2 }];
  const tags = [{ id: 2 }, { id: 3 }];
  assert.deepEqual(mergeResults(fts, tags), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("mergeResults with empty inputs", () => {
  assert.deepEqual(mergeResults([], []), []);
  assert.deepEqual(mergeResults([{ id: 1 }], []), [{ id: 1 }]);
  assert.deepEqual(mergeResults([], [{ id: 1 }]), [{ id: 1 }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
