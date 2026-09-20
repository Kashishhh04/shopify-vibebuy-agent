import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Reuses the same per-session CartManager as update_cart - the cartId it
// applies against is whatever that manager already has tracked, so there's
// no separate cart/session state to keep in sync here.
export function createApplyDiscountCodeTool(cartManager) {
  return tool(
    "apply_discount_code",
    "Apply a discount code to the shopper's cart. Returns the updated checkout link.",
    { code: z.string().min(1) },
    async ({ code }) => {
      const result = await cartManager.applyDiscountCode(code);
      const checkoutUrl = result?.checkoutUrl ?? null;
      return { content: [{ type: "text", text: JSON.stringify({ checkoutUrl }) }] };
    }
  );
}
