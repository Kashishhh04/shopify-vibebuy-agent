import nodemailer from "nodemailer";

// Lazily created (and cached) only once the three env vars below are all
// present - lets the rest of the app run fine before they're configured,
// instead of crashing at startup over an optional notification feature.
let transporter = null;

function getTransporter() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

// Takes the same entry object bulkLeads.js's buildLeadEntry() produces and
// recordBulkLead() writes to bulk-leads.jsonl - built once per lead by the
// caller (server.js) and handed to both, so the email always shows exactly
// the same record (same capturedAt, same field names/shape) as what's saved
// to the file, not a second independently-formatted summary of it.
//
// Best-effort: a shopper's chat experience never depends on this succeeding,
// so failures (missing config, a bad send) are logged, never thrown.
export async function notifyBulkLead(entry) {
  const { GMAIL_USER, STORE_OWNER_EMAIL } = process.env;
  const transport = getTransporter();

  if (!transport || !STORE_OWNER_EMAIL) {
    console.warn(
      "notifyBulkLead: skipped - set GMAIL_USER, GMAIL_APP_PASSWORD, and " +
        "STORE_OWNER_EMAIL in .env to enable email notifications."
    );
    return;
  }

  try {
    await transport.sendMail({
      from: GMAIL_USER,
      to: STORE_OWNER_EMAIL,
      subject: `Bulk order lead: ${entry.email}`,
      text:
        `A shopper asked about a bulk/wholesale order, was asked for their email and which ` +
        `product(s) they want. This is the same entry saved to bulk-leads.jsonl:\n\n` +
        JSON.stringify(entry, null, 2),
    });
  } catch (err) {
    console.error("notifyBulkLead: failed to send email:", err.message);
  }
}
