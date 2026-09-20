import { tool } from "@anthropic-ai/claude-agent-sdk";

// Bound to one shopper's own CartManager (see server.js), same as
// update_cart - read-only, so it never creates a cart of its own.
export function createViewCartTool(cartManager) {
  return tool(
    "view_cart",
    "Look up whether the shopper's cart has anything in it, how many items, " +
      "its total price, and its checkout link. Call this whenever a shopper asks what's in " +
      "their cart, to see their cart, its total, or whether they've added anything yet.",
    {},
    async () => {
      const { checkoutUrl, itemCount, total, currency, lineItems } = await cartManager.getCart();
      return {
        content: [{ type: "text", text: JSON.stringify({ checkoutUrl, itemCount, total, currency, lineItems }) }],
      };
    }
  );
}
