import { tool } from "@anthropic-ai/claude-agent-sdk";

// A no-op tool, same pattern as flag_off_topic: gives the model a structured
// way to signal "I genuinely can't tell what they mean" so server.js can
// count it, rather than letting an unparseable message (a stray "d", random
// keys, etc.) turn into an unbounded back-and-forth of clarifying questions
// that never resolves and never gets flagged as anything.
export const flagUnclear = tool(
  "flag_unclear",
  "Call this once whenever a shopper's message is too vague, garbled, or " +
    "just plain unparseable to act on at all - a single stray character " +
    "(e.g. \"d\", \"k\"), random keystrokes, or anything else you can't turn " +
    "into any real intent, even after you've already asked them to clarify " +
    "once. Don't call this for messages that are simply short, informal, or " +
    "clearly about something (even if unrelated to the store - use " +
    "flag_off_topic for those instead). Still give a brief, friendly reply " +
    "asking what they're looking for or pointing at the suggestion chips - " +
    "don't refuse to respond.",
  {},
  async () => ({ content: [{ type: "text", text: "{}" }] })
);
