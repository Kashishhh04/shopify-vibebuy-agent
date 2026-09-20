import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLocalTimestamp, resolveTimeZone } from "./timeFormat.js";

const LEADS_FILE = path.resolve(import.meta.dirname, "bulk-leads.jsonl");

// Same shape gets written to bulk-leads.jsonl (recordBulkLead below) and
// embedded verbatim in the owner's notification email (bulkLeadEmail.js) -
// built once per lead and handed to both, rather than each independently
// stamping its own "now", so the two can never drift apart or format
// differently.
export function buildLeadEntry({ sessionId, email, message, timeZone }) {
  const capturedAt = new Date();
  // capturedAtLocal renders capturedAt in this same shopper's zone, which is
  // the whole reason timeZone is captured at all - see timeFormat.js for why
  // resolveTimeZone never just leaves it null.
  const resolvedTimeZone = resolveTimeZone(timeZone);
  return {
    sessionId,
    email,
    message,
    timeZone: resolvedTimeZone,
    capturedAtLocal: formatLocalTimestamp(capturedAt, resolvedTimeZone),
    // Kept alongside capturedAtLocal (UTC/ISO, unambiguous and sortable) -
    // capturedAtLocal is what's meant to actually be read.
    capturedAt: capturedAt.toISOString(),
  };
}

// Pretty-printed (not single-line JSONL) so "message" - often the longest,
// most-important field - reads as clearly as sessionId/email instead of
// getting buried in one dense line.
//
// Newest-first: since whoever opens this file wants to see the latest leads
// without scrolling to the bottom, each new entry is written ahead of the
// existing content rather than appended after it. That trades away
// append-only writes (this now reads the whole file back before rewriting
// it) for a log that's genuinely readable at lead volumes like this one.
export async function recordBulkLead(entry) {
  const block = JSON.stringify(entry, null, 2) + "\n\n";

  let existing = "";
  try {
    existing = await readFile(LEADS_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  await writeFile(LEADS_FILE, block + existing, "utf8");
}
