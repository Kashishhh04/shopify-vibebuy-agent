import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Bound to one shopper's own CartManager (see server.js), so the model never
// needs to - and never can - reference a cart or line id: it only ever
// passes the variantId + quantity it already got from search_products.
export function createUpdateCartTool(cartManager) {
  return tool(
    "update_cart",
    "Add, change the quantity of, or remove a product variant in the shopper's cart. " +
      "Set quantity to 0 to remove it. Returns the current checkout link.",
    {
      variantId: z.string(),
      quantity: z.number().int().nonnegative(),
    },
    async ({ variantId, quantity }) => {
      // Captured before the mutation so a removal (quantity 0, which drops
      // the line entirely) still has a title to report - the model's own
      // reply text confirming what just happened was found to be unreliable
      // in testing, so server.js builds the actual confirmation from this
      // data directly instead of trusting the model to phrase it.
      const before = await cartManager.getCart();
      const beforeItem = before.lineItems.find((item) => item.variantId === variantId);

      const result = await cartManager.addOrSetQuantity(variantId, quantity);
      const afterItem = result?.lineItems.find((item) => item.variantId === variantId);

      const output = {
        checkoutUrl: result?.checkoutUrl ?? null,
        variantId,
        quantity,
        title: afterItem?.title ?? beforeItem?.title ?? null,
        wasNewAdd: !beforeItem && quantity > 0,
      };
      return { content: [{ type: "text", text: JSON.stringify(output) }] };
    }
  );
}
