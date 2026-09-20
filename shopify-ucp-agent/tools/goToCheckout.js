import { tool } from "@anthropic-ai/claude-agent-sdk";

// Bound to one shopper's own CartManager (see server.js), same as
// view_cart - read-only, so it never creates a cart. Kept separate from
// view_cart (rather than one tool with a "how" argument) so the chat UI can
// tell "just show me my cart" and "I'm ready to check out" apart from which
// tool the model called, and only auto-navigate for the latter.
export function createGoToCheckoutTool(cartManager) {
  return tool(
    "go_to_checkout",
    "Call this when the shopper explicitly wants to check out or pay now " +
      "(e.g. \"checkout\", \"take me to checkout\", \"I'm ready to pay\") - " +
      "not just when they want to see what's in their cart. Returns the " +
      "checkout link the shopper's UI will send them to automatically, or " +
      "itemCount 0 if their cart is empty.",
    {},
    async () => {
      const { checkoutUrl, itemCount } = await cartManager.getCart();
      return { content: [{ type: "text", text: JSON.stringify({ checkoutUrl, itemCount }) }] };
    }
  );
}
