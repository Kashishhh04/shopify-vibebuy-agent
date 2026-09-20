import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// A no-op tool: its only purpose is to give the model a structured place to
// put follow-up questions, which the chat UI renders as clickable chips
// (see chatSession.js's turn-scoped capture of this tool's result). Calling
// it is how the model "returns" suggestions instead of writing them into
// its prose reply, which the system prompt asks it not to do.
export const suggestFollowups = tool(
  "suggest_followups",
  "Call this once near the end of every turn with 2-4 short follow-up " +
    "questions the shopper might naturally want to ask next, based on what " +
    "was just discussed (e.g. after showing snowboards, suggest asking " +
    "about bindings; after a cart action, suggest checking out or " +
    "continuing to shop). Each question should be under 6 words.",
  { questions: z.array(z.string()).min(2).max(4) },
  async ({ questions }) => {
    return { content: [{ type: "text", text: JSON.stringify({ questions }) }] };
  }
);
