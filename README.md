# kb-core

Shared KB search logic used by the HMI CLI (`Knowledge Base/scripts/kb.js`) and the Slack bot (`HDJ-Assistant/src/kb.js`).

## Why this exists

Both codebases need the same search behavior: FTS5 query construction, vendor Excel matching, stopword filtering, tag search, and result merging. Keeping two copies in sync by hand was fragile. This package is the single source of truth.

The SQLite driver (native vs `sql.js`) and write paths stay in each caller — this package is pure logic.

## Exports

- `VENDOR_STOP_WORDS` — Set of words that must never match vendor names.
- `normalizeTerms(query, { stripPunctuation })` — tokenize + clean.
- `buildFtsQuery(terms)` — FTS5 MATCH string.
- `buildFtsSearchSql(terms, { openMark, closeMark })` — `{ sql, params }`.
- `buildLikeFallbackSql(terms)` — `{ sql, params }` for environments without FTS5.
- `buildTagSearchSql(terms)` — `{ sql, params }`.
- `mergeResults(ftsRows, tagRows)` — dedupe, FTS order preserved.
- `searchExcel(terms, { excelPath, xlsx, limit })` — vendor sheet rows.

## Usage

```js
const core = require("kb-core");
const terms = core.normalizeTerms("drop ship fee");
const { sql, params } = core.buildFtsSearchSql(terms);
const ftsRows = yourDriver.query(sql, params);
// ...
```

## Tests

```
npm test
```
