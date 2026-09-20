// Shared by bulkLeads.js (the saved lead record) and bulkLeadEmail.js (the
// owner notification) so both ever only say one thing for "when" - a bare
// UTC/ISO timestamp reads as wrong to whoever's looking at it locally, since
// it never matches their own system clock unless they happen to be in UTC.
export function formatLocalTimestamp(date, timeZone) {
  try {
    // timeZone undefined falls back to the server's own local zone - still a
    // genuine local timestamp, just not necessarily the shopper's.
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone }).format(date);
  } catch {
    return date.toISOString();
  }
}

// The shopper's own IANA zone (e.g. "Asia/Kolkata") if the widget reported
// one, otherwise this server's own zone as a last resort - so there's always
// something real to format a local timestamp with, never a silent gap.
export function resolveTimeZone(timeZone) {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
