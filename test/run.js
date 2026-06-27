"use strict";
/**
 * Tiny assert-based test runner - zero dependencies.
 * Covers the pure-logic exports of kb-core.
 */

const assert = require("node:assert/strict");
const {
  VENDOR_STOP_WORDS,
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
  searchExcel,
  parseMetaFooter,
  decodeHtmlEntities,
  flattenPageTree,
  assignKbIds,
  isRetryable,
  extractRetryAfterSeconds,
  retryWithBackoff,
} = require("../src/index");
const { vendorNameVariants } = require("../src/excel");

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
      failed++;
    }
  };
  pending.push(run());
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
    ["drop-ship", "fee"]
  );
});

test("normalizeTerms trims boundary punctuation while preserving internal vendor punctuation", () => {
  assert.deepEqual(
    normalizeTerms("K&M? payment.", { stripPunctuation: false, removeStopwords: true }),
    ["K&M", "payment"]
  );
});

test("normalizeTerms drops empty tokens", () => {
  assert.deepEqual(normalizeTerms("   a   b   "), ["a", "b"]);
});

test("normalizeTerms removes conversational filler when requested", () => {
  assert.deepEqual(
    normalizeTerms("nothing about price matching", { removeStopwords: true }),
    ["price", "matching"]
  );
  assert.deepEqual(
    normalizeTerms("can we price match this website I cant find if they are a licensed vendor it seems sketchy though", {
      removeStopwords: true,
    }),
    ["price", "match", "website", "licensed", "vendor", "sketchy"]
  );
});

test("normalizeTerms removes live-order clutter when stopword filtering is requested", () => {
  const terms = normalizeTerms(
    "For Order 9789485 I created a related child order for Skustack Order 9791076 Qty 2 but I am stuck with its payment please review and let me know",
    { removeStopwords: true }
  ).map((t) => t.toLowerCase());
  assert.deepEqual(terms, ["order", "child", "skustack", "payment"]);
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

test("buildFtsLenientSql ORs terms instead of ANDing", () => {
  const { sql, params } = buildFtsLenientSql(["wells", "fargo", "bill"]);
  assert.equal(params[0], "wells OR fargo OR bill");
  assert.match(sql, /MATCH \?/);
});

test("expandLenientSearchTerms expands split-order payment vocabulary", () => {
  assert.deepEqual(
    expandLenientSearchTerms(["order", "child", "skustack", "payment"]),
    ["order", "child", "skustack", "sku", "stack", "payment", "split", "overpaid", "charged", "sellercloud"]
  );
});

test("buildFtsLenientSql empty returns empty", () => {
  const { sql, params } = buildFtsLenientSql([]);
  assert.equal(sql, "");
  assert.deepEqual(params, []);
});

test("buildLikeLenientSql joins conditions with OR (not AND)", () => {
  const { sql } = buildLikeLenientSql(["wells", "fargo", "bill"]);
  assert.match(sql, / OR /);
  assert.doesNotMatch(sql, /\) AND \(/);
});

test("filterByMinTermMatches keeps rows matching ceil(N/2) terms for N>=3", () => {
  // Regression: "When do I need to pay the next Wells Fargo Bill?" - entry
  // mentions Wells Fargo + payment but not "bill" / "need" / "pay" / "next".
  // Strict AND returns zero; lenient OR + majority filter must still find it.
  const terms = ["need", "pay", "next", "wells", "fargo", "bill"];
  const rows = [
    { id: 6120, title: "Wells Fargo Portal Payments", body: "schedule monthly payment for financed invoices" },
    { id: 99,   title: "Newsletter signups",          body: "welcome to the list" },
  ];
  const kept = filterByMinTermMatches(rows, terms);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 6120);
});

test("filterByMinTermMatches treats compact vendor spellings as matches", () => {
  const rows = [
    { id: 1, title: "Split order fix", body: "Confirm warehouse is SKU Stack and payment is charged." },
  ];
  const kept = filterByMinTermMatches(rows, ["order", "skustack", "payment"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 1);
});

test("filterByMinTermMatches keeps SKU swap candidates despite extra live-order words", () => {
  const rows = [
    { id: 2010, title: "How To Swap one SKU with another in Shopify to Process Order", body: "swap sku order" },
  ];
  const kept = filterByMinTermMatches(rows, ["customer", "accepts", "replacement", "stand", "order", "old", "kit", "sku", "swap", "cancel"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 2010);
});

test("filterByMinTermMatches requires all terms for N<3", () => {
  const rows = [
    { id: 1, title: "foo only", body: "" },
    { id: 2, title: "foo bar",  body: "" },
  ];
  const kept = filterByMinTermMatches(rows, ["foo", "bar"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 2);
});

test("filterByMinTermMatches honors explicit threshold", () => {
  const rows = [{ id: 1, title: "alpha", body: "beta" }];
  assert.equal(filterByMinTermMatches(rows, ["alpha", "beta", "gamma"], 3).length, 0);
  assert.equal(filterByMinTermMatches(rows, ["alpha", "beta", "gamma"], 2).length, 1);
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

test("mergeResults surfaces lenient hit when strict AND is a coincidence", () => {
  // Regression: 2026-04-19 phone-order incident. Query "how do I place a
  // phone order for a customer" strict-AND matched entry 10129 (Refund
  // policy - "place" inside "please"). Old code gated lenient OR on
  // `ftsRows.length === 0`, so the real answer (entry 2024, Shopify Draft
  // Order steps) was never reached. Callers now always merge lenient when
  // terms.length >= 2; mergeResults must keep both rows with strict first.
  const strict = [{ id: 10129, title: "Refund Policy" }];
  const lenient = [{ id: 2024, title: "Shopify Draft Order - Phone Order Steps" }];
  const merged = mergeResults(strict, lenient);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 10129);
  assert.equal(merged[1].id, 2024);
});

test("rankRowsByQuery boosts split-order payment fixes over rental Skustack noise", () => {
  const terms = normalizeTerms(
    "For Order 9789485 I created a related child order for Skustack Order 9791076 Qty 2 but I am stuck with its payment please review",
    { removeStopwords: true }
  );
  const rows = [
    {
      id: 2102,
      title: "Rental Customer Calls",
      category: "Process",
      body: "Check local warehouse availability in Skustack. The customer must pay the full amount for the rental order.",
    },
    {
      id: 23144,
      title: "Fixing a Split Order Already Drop Shipped: Payment, PO Receiving, and Inventory",
      category: "SOP",
      body: "When a Shopify order splits into two SellerCloud orders and payment lands wrong, one split order shows Overpaid and the other shows No Payment. Confirm the warehouse is SKU Stack.",
    },
    {
      id: 2070,
      title: "Updating SC order payment status from No Payment to Charged manually",
      category: "Process",
      body: "SellerCloud process for changing an order payment status from No Payment to Charged.",
    },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 23144);
  assert.equal(ranked[ranked.length - 1].id, 2102);
});

test("rankRowsByQuery boosts Shopify split-payment SOP over split-order repair", () => {
  const terms = normalizeTerms(
    "How do I set up a split payment order in Shopify actual SOP video",
    { removeStopwords: true }
  );
  const rows = [
    { id: 25146, title: "Fixing a Split Order Already Drop Shipped: Payment, PO Receiving, and Inventory", category: "SOP", body: "split order payment repair" },
    { id: 16141, title: "How to delete split Shopify orders and reimport them in SellerCloud", category: "SOP", body: "split order reimport" },
    { id: 2022, title: "How to handle Splitting payment methods for a customer order in Shopfy", category: "SOP", body: "split payment methods in Shopify" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 2022);
});

test("rankRowsByQuery keeps free-freight pricing policy above freight checklist", () => {
  const terms = normalizeTerms(
    "If a vendor offers free freight on a drop ship order do we still charge the customer for shipping",
    { removeStopwords: true }
  );
  const rows = [
    { id: 2052, title: "Drop Ship Free Freight Customer Shipping Charge Policy", category: "Policy", body: "If a vendor offers free freight on a drop ship order, still charge the customer for shipping." },
    { id: 9129, title: "Freight and Will Call Order Checklist", category: "Process", body: "Checklist for processing freight customer orders." },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 2052);
});

test("rankRowsByQuery boosts QuickBooks invoice permissions over financing invoice noise", () => {
  const terms = normalizeTerms(
    "Who is allowed to create QuickBooks invoices?",
    { removeStopwords: true }
  );
  const rows = [
    { id: 6120, title: "How to Make/Schedule Payments via Wells Fargo Portal (Financing Invoices/POs due 5th, 15th, 25th)", category: "Process", body: "financing invoices" },
    { id: 12, title: "QuickBooks Invoice - Who Can Create Them", category: "Policy", body: "Only Adam and Karen can create QuickBooks invoices." },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 12);
});

test("rankRowsByQuery boosts related-order no-payment repair above generic split payment", () => {
  const terms = normalizeTerms(
    "I created a related order and added the item that needs to be dropshipped but now both orders are with no payment how can we mark them as paid",
    { removeStopwords: true }
  );
  const rows = [
    { id: 2022, title: "How to handle Splitting payment methods for a customer order in Shopfy", category: "SOP", body: "split payment methods in Shopify" },
    { id: 25146, title: "Fixing a Split Order Already Drop Shipped: Payment, PO Receiving, and Inventory", category: "SOP", body: "related order no payment repair" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 25146);
});

test("rankRowsByQuery boosts financing practice for Acima plus card split", () => {
  const terms = normalizeTerms(
    "They got approved for 3550 on Acima and want to put the rest on a card like regular split payment",
    { removeStopwords: true }
  );
  const rows = [
    { id: 2106, title: "Synchrony Financing Application and Order Process", category: "Process", body: "financing application" },
    { id: 2022, title: "How to handle Splitting payment methods for a customer order in Shopfy", category: "SOP", body: "split payment" },
    { id: 19144, title: "Financing App Processing Practices: Tax, Approval Buffer, and Local Pickup Setup", category: "Process", body: "Acima tax approval buffer and financing provider practices" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 19144);
});

test("rankRowsByQuery boosts company verification SOP for legit fraud process wording", () => {
  const terms = normalizeTerms(
    "How do we investigate a company to see if they are legit or not fraud what is the process",
    { removeStopwords: true }
  );
  const rows = [
    { id: 2056, title: "Policy on Uber/Lyft In-store Pickups", category: "Policy", body: "fraud risk for pickup" },
    { id: 1000, title: "ACH / Wire Transfer Payment Process", category: "SOP", body: "payments" },
    { id: 2039, title: "How to verify big-ticket leads to confirm they are not fraud", category: "SOP", body: "call organization and verify the lead" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 2039);
});

test("rankRowsByQuery boosts company verification SOP for high-dollar business wording", () => {
  const terms = normalizeTerms(
    "For a high dollar order what process do we use to verify the business is real before we trust it",
    { removeStopwords: true }
  );
  const rows = [
    { id: 4, title: "International Order Fraud Risk - Payment Policy; Signifyd Coverage", category: "Policy", body: "fraud risk" },
    { id: 2039, title: "How to verify big-ticket leads to confirm they are not fraud", category: "SOP", body: "verify organization and confirm the lead" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 2039);
});

test("rankRowsByQuery boosts SKU swap SOP for kit replacement wording", () => {
  const terms = normalizeTerms(
    "The customer is okay with a different stand but the order SKU is a kit would the order have to be canceled and replaced",
    { removeStopwords: true }
  );
  const rows = [
    { id: 2111, title: "Amazon Order (NOT PRIME) Unfulfillable from HDJ Warehouse Workflow", category: "Process", body: "replacement order may be needed" },
    { id: 2021, title: "Order Cancellations Basic Full Refund", category: "SOP", body: "cancel order" },
    { id: 2010, title: "How To Swap one SKU with another in Shopify to Process Order", category: "SOP", body: "swap sku" },
  ];
  const ranked = rankRowsByQuery(rows, terms);
  assert.equal(ranked[0].id, 2010);
});

test("buildTagSearchSql hides [DELETED] and [PENDING REVIEW] titles", () => {
  // Regression: tag search previously returned entries under _Deleted or
  // marked [PENDING REVIEW] because the tag join bypassed the title-based
  // filter used by FTS. Hidden-title filter lives in the SQL itself.
  const { sql } = buildTagSearchSql(["refund"]);
  assert.match(sql, /NOT LIKE '\[DELETED\]%'/);
  assert.match(sql, /NOT LIKE '\[PENDING REVIEW\]%'/);
});

test("buildLikeFallbackSql hides [DELETED] and [PENDING REVIEW] titles", () => {
  // Regression: LIKE fallback path (used by bot, which lacks FTS5) did not
  // have the hidden-title WHERE clause. A search for "pickup" returned
  // "[DELETED] In-Store Pickup Guidelines" (entry 2071) because the body
  // still contains "pickup" and there was no title filter in the SQL itself.
  // Guard: both NOT LIKE clauses must appear in LIKE fallback SQL.
  const { sql } = buildLikeFallbackSql(["pickup"]);
  assert.match(sql, /NOT LIKE '\[DELETED\]%'/);
  assert.match(sql, /NOT LIKE '\[PENDING REVIEW\]%'/);
});

test("buildFtsLenientSql hides [DELETED] and [PENDING REVIEW] titles", () => {
  // Same guard for the lenient FTS path - FTS5 indexes the full body of
  // [DELETED] entries, so an OR match on any term in the deleted body would
  // return the deleted entry without this filter.
  const { sql } = buildFtsLenientSql(["pickup"]);
  assert.match(sql, /NOT LIKE '\[DELETED\]%'/);
  assert.match(sql, /NOT LIKE '\[PENDING REVIEW\]%'/);
});

test("buildFtsSearchSql hides [DELETED] and [PENDING REVIEW] titles", () => {
  // Guard: strict FTS path must also carry the hidden-title filter.
  // FTS5 ranks by rank, not by title prefix - without this, a high-scoring
  // [DELETED] entry could appear at the top of results.
  const { sql } = buildFtsSearchSql(["pickup"]);
  assert.match(sql, /NOT LIKE '\[DELETED\]%'/);
  assert.match(sql, /NOT LIKE '\[PENDING REVIEW\]%'/);
});

// ── vendor Excel search ──────────────────────────────────────────────────────

// Mock XLSX module so tests don't touch disk. Shape matches what searchExcel
// uses: readFile() -> workbook with SheetNames + Sheets; utils.sheet_to_json
// with {header: 1} returns rows-of-arrays.
function makeMockXlsx(sheetsData) {
  const SheetNames = Object.keys(sheetsData);
  const Sheets = {};
  for (const name of SheetNames) Sheets[name] = { _rows: sheetsData[name] };
  return {
    readFile: () => ({ SheetNames, Sheets }),
    utils: {
      sheet_to_json: (sheet, opts) =>
        opts && opts.header === 1 ? sheet._rows : [],
    },
  };
}

test("searchExcel token pass matches term by word boundary", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["KMC Music (Portal)", "414043"],
      ["Roland", "99999"],
    ],
  });
  const results = searchExcel(["kmc"], { excelPath: "/fake", xlsx });
  assert.equal(results.length, 1);
  assert.equal(results[0].fields.Vendor, "KMC Music (Portal)");
});

test("searchExcel matches 'K and M' via raw-query variant fallback", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["K&M / Connolly Music", "12345"],
      ["Roland", "99999"],
    ],
  });
  // Realistic tokenizer output: "K", "and", "M" all get filtered out
  // (too-short + stopword), so the token pass sees only unrelated noise
  // and the fallback has to carry the match.
  const results = searchExcel(["regards", "ships"], {
    excelPath: "/fake",
    xlsx,
    query: "What can you tell me about the vendor K and M with regards to drop ships?",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].fields.Vendor, "K&M / Connolly Music");
});

test("searchExcel matches 'K&M' via raw-query variant fallback", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["K&M / Connolly Music", "12345"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "what's the K&M dropship fee?",
  });
  assert.equal(results.length, 1);
});

test("searchExcel decodes HTML entities in query (Slack K&amp;M)", () => {
  // Slack's app_mention payload escapes `&` as `&amp;`, so "K&M" arrives as
  // "K&amp;M" in event.text. searchExcel must decode before variant matching.
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["K&M / Connolly Music", "12345"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "does K&amp;M charge us a drop ship fee?",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].fields.Vendor, "K&M / Connolly Music");
});

test("searchExcel matches 'K & M' via raw-query variant fallback", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["K&M / Connolly Music", "12345"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "vendor K & M dropship info",
  });
  assert.equal(results.length, 1);
});

test("searchExcel does NOT false-positive on 'ok thanks' (bare k)", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["K&M / Connolly Music", "12345"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "ok thanks!",
  });
  assert.equal(results.length, 0);
});

test("searchExcel single-word variant uses word boundary (no 'ace' in 'replace')", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["Ace", "11111"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "please replace the cable",
  });
  assert.equal(results.length, 0);
});

test("searchExcel single-word variant matches vendor name as whole word", () => {
  const xlsx = makeMockXlsx({
    Vendors: [
      ["Vendor", "Account"],
      ["Ace", "11111"],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "what do we know about Ace?",
  });
  assert.equal(results.length, 1);
});

test("searchExcel returns empty when neither terms nor query provided", () => {
  const xlsx = makeMockXlsx({
    Vendors: [["Vendor"], ["K&M / Connolly Music"]],
  });
  assert.deepEqual(
    searchExcel([], { excelPath: "/fake", xlsx }),
    []
  );
});

test("vendorNameVariants generates slash-split segments and & expansions", () => {
  const variants = vendorNameVariants("k&m / connolly music");
  assert.ok(variants.includes("k&m"));
  assert.ok(variants.includes("k and m"));
  assert.ok(variants.includes("k & m"));
  assert.ok(variants.includes("connolly music"));
});

test("vendorNameVariants drops variants shorter than 3 chars", () => {
  // "a / b" produces segments "a" and "b" (both 1 char) plus the full "a / b".
  // Only the full form (5 chars) survives the length filter.
  const variants = vendorNameVariants("a / b");
  assert.deepEqual(variants, ["a / b"]);
});

test("vendorNameVariants splits on parens so 'K&M (K and M)' yields 'k&m'", () => {
  // Matches the DS Notes sheet row where the canonical name is
  // "K&M (K and M)" and the parens are an inline alias list. Without
  // paren splitting, the only variants would contain the parens and
  // never substring-match a clean user query like "does K&M charge us…".
  const variants = vendorNameVariants("k&m (k and m)");
  assert.ok(variants.includes("k&m"), `expected "k&m" in ${JSON.stringify(variants)}`);
  assert.ok(variants.includes("k and m"));
  assert.ok(variants.includes("k & m"));
});

test("searchExcel matches 'K&M (K and M)' DS Notes row via paren-split variant", () => {
  // End-to-end: the DS Notes sheet row has parenthesized aliases. A Slack
  // query like "does K&M charge us a drop ship fee?" - after Slack escapes
  // `&` to `&amp;` and the bot's tokenizer strips punctuation to useless
  // tokens - must still surface this row via the substring fallback.
  const xlsx = makeMockXlsx({
    "Vendor Drop Ship Notes": [
      ["Vendor", "Drop Ship Fee?"],
      ["K&M (K and M)", `YES $10 "handling fee"`],
    ],
  });
  const results = searchExcel([], {
    excelPath: "/fake",
    xlsx,
    query: "does K&amp;M charge us a drop ship fee?",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].fields.Vendor, "K&M (K and M)");
});

// ── sync helpers ─────────────────────────────────────────────────────────────

test("parseMetaFooter extracts body + tags + kb_id", () => {
  const content =
    "This is the body.\n---\n<!-- kb-meta\ntags: foo, bar\nkb_id: 1234\n-->";
  const r = parseMetaFooter(content);
  assert.equal(r.body, "This is the body.");
  assert.deepEqual(r.tags, ["foo", "bar"]);
  assert.equal(r.kb_id, 1234);
  assert.deepEqual(r.related, []);
});

test("parseMetaFooter handles escaped kb_id + * * * separator", () => {
  const content =
    "Body text.\n* * *\n<!-- kb-meta\ntags: Alpha, BETA\nkb\\_id: 42\n\\-->";
  const r = parseMetaFooter(content);
  assert.equal(r.body, "Body text.");
  assert.deepEqual(r.tags, ["alpha", "beta"]);
  assert.equal(r.kb_id, 42);
  assert.deepEqual(r.related, []);
});

test("parseMetaFooter with no footer returns trimmed body and nulls", () => {
  const r = parseMetaFooter("  just a body  ");
  assert.equal(r.body, "just a body");
  assert.deepEqual(r.tags, []);
  assert.equal(r.kb_id, null);
  assert.deepEqual(r.related, []);
});

test("parseMetaFooter extracts related ids", () => {
  const content =
    "Body.\n---\n<!-- kb-meta\ntags: x\nkb_id: 10\nrelated: 20, 30, 40\n-->";
  const r = parseMetaFooter(content);
  assert.deepEqual(r.related, [20, 30, 40]);
});

test("parseMetaFooter drops invalid related ids", () => {
  const content =
    "Body.\n---\n<!-- kb-meta\ntags: x\nkb_id: 10\nrelated: 20, abc, -5, 0, 99\n-->";
  const r = parseMetaFooter(content);
  assert.deepEqual(r.related, [20, 99]);
});

test("decodeHtmlEntities decodes the five supported entities", () => {
  assert.equal(
    decodeHtmlEntities("&amp; &lt; &gt; &quot; &#39;"),
    `& < > " '`
  );
});

test("flattenPageTree skips category folders and _Deleted children", () => {
  const deleted = "DEL";
  // Callers pass a set that includes both category folder IDs and the _Deleted ID.
  const categories = new Set(["CAT1", "CAT2", deleted]);
  const tree = [
    { id: "CAT1", name: "SOP", pages: [
      { id: "p1", name: "Entry A", parent_page_id: "CAT1" },
      { id: "p2", name: "Entry B", parent_page_id: "CAT1" },
    ]},
    { id: "CAT2", name: "Vendor", pages: [] },
    { id: "DEL", name: "_Deleted", pages: [
      { id: "dead1", name: "Dead entry", parent_page_id: "DEL" },
    ]},
    { id: "root1", name: "Orphan", pages: [] },
  ];
  const entries = flattenPageTree(tree, categories, deleted);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ["p1", "p2", "root1"]);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(byId.p1.parentPageId, "CAT1");
});

test("assignKbIds preserves existing IDs and assigns new ones above max+1000", () => {
  const entries = [
    { kb_id: 42 },
    { kb_id: null },
    { kb_id: 100 },
    { kb_id: null },
  ];
  assignKbIds(entries);
  assert.equal(entries[0].kb_id, 42);
  assert.equal(entries[2].kb_id, 100);
  // next starts at 100 + 1000 = 1100
  assert.equal(entries[1].kb_id, 1100);
  assert.equal(entries[3].kb_id, 1101);
});

test("assignKbIds with empty input starts at 1000", () => {
  const entries = [{ kb_id: null }, { kb_id: null }];
  assignKbIds(entries);
  assert.equal(entries[0].kb_id, 1000);
  assert.equal(entries[1].kb_id, 1001);
});

test("isRetryable catches 429 and 5xx via status", () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 404 }), false);
  assert.equal(isRetryable({ status: 200 }), false);
});

test("isRetryable catches 429 and 5xx via message string", () => {
  assert.equal(isRetryable({ message: "getPage foo: 429 Rate limited" }), true);
  assert.equal(isRetryable({ message: "getPage foo: 502 Bad Gateway" }), true);
  assert.equal(isRetryable({ message: "getPage foo: 404 Not Found" }), false);
});

test("extractRetryAfterSeconds reads structured field", () => {
  assert.equal(extractRetryAfterSeconds({ retryAfter: 30 }), 30);
});

test("extractRetryAfterSeconds reads message format", () => {
  assert.equal(
    extractRetryAfterSeconds({ message: `429 Retry-After: 12` }),
    12
  );
  assert.equal(extractRetryAfterSeconds({ message: "nothing" }), null);
});

test("retryWithBackoff retries on 429, eventually succeeds", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error("429 rate limited");
      err.status = 429;
      throw err;
    }
    return "ok";
  };
  const logs = [];
  const result = await retryWithBackoff(fn, {
    maxRetries: 5,
    label: "test",
    log: (m) => logs.push(m),
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(logs.length, 2); // two retries logged before success
});

test("retryWithBackoff throws immediately on non-retryable error", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    const err = new Error("404 not found");
    err.status = 404;
    throw err;
  };
  await assert.rejects(() => retryWithBackoff(fn, { maxRetries: 5 }));
  assert.equal(calls, 1);
});

test("kb-core re-exports applySchema and SCHEMA_SQL (used by CLI + sync)", () => {
  const core = require("../src/index");
  assert.equal(typeof core.applySchema, "function");
  assert.equal(typeof core.SCHEMA_SQL, "string");
  assert.equal(typeof core.rankRowsByQuery, "function");
  assert.ok(core.SCHEMA_SQL.includes("CREATE TABLE"));
});

// ── summary ──────────────────────────────────────────────────────────────────

(async () => {
  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
