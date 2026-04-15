"use strict";
/**
 * Words that should never trigger vendor-name matching in the Excel sheet.
 * Without this, questions like "what do i need to know about problem customers"
 * match vendor rows because common nouns appear inside column values.
 */
const VENDOR_STOP_WORDS = new Set([
  "what", "when", "where", "which", "who", "how", "why",
  "the", "and", "but", "for", "nor", "not", "yet", "per",
  "all", "any", "its", "our", "his", "her", "own",
  "that", "this", "them", "they", "their", "there", "here",
  "some", "each", "every", "most", "also", "just", "only",
  "very", "much", "more", "than", "into", "over", "after",
  "before", "been", "being", "from", "with", "about",
  "are", "was", "were", "has", "had", "may", "can", "too",
  "need", "know", "tell", "have", "does", "make", "take",
  "give", "keep", "come", "back", "will", "would", "could",
  "should", "want", "like", "help", "find", "look", "send",
  "call", "work", "going", "doing", "getting", "using",
  "according", "policy", "process", "procedure", "information",
  "explain", "description", "overview", "details", "please",
  "order", "orders", "customer", "customers", "problem", "problems",
  "return", "returns", "refund", "refunds", "ship", "shipping",
  "drop", "price", "pricing", "cost", "payment", "invoice",
  "stock", "inventory", "item", "items", "product", "products",
  "cancel", "track", "tracking", "warranty", "discount",
  "shopify", "amazon", "sellercloud", "gorgias",
  "oversized", "oversize", "freight", "parcel", "ground",
  "number", "account", "contact", "email", "phone", "okay",
]);

module.exports = { VENDOR_STOP_WORDS };
