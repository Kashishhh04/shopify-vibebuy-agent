import { tool } from "@anthropic-ai/claude-agent-sdk";
import { adminRequest } from "../adminClient.js";

// Needs the read_discounts scope on the same Dev Dashboard app as the other
// Admin client-credentials tools (see checkOrderStatus.js) - not granted by
// default, so this fails until that scope is added and the app reinstalled.
// Caught here (rather than left to blow up the turn) so callers degrade to
// "can't look this up right now" instead of erroring out entirely.
//
// Exported standalone (not just wrapped in the tool below) so server.js can
// call it directly for a deterministic reply - e.g. bulk-order intent -
// without depending on whether the model happens to invoke the tool itself.
export async function fetchActiveDiscounts() {
  const PAGE_SIZE = 50;
  const MAX_DISCOUNTS = 250;

  try {
    const discounts = [];
    let cursor = null;

    do {
      const data = await adminRequest(`
        query codeDiscounts($cursor: String) {
          codeDiscountNodes(first: ${PAGE_SIZE}, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                codeDiscount {
                  __typename
                  ... on DiscountCodeBasic {
                    title
                    status
                    summary
                    codes(first: 3) { edges { node { code } } }
                  }
                  ... on DiscountCodeBxgy {
                    title
                    status
                    summary
                    codes(first: 3) { edges { node { code } } }
                  }
                  ... on DiscountCodeFreeShipping {
                    title
                    status
                    summary
                    codes(first: 3) { edges { node { code } } }
                  }
                }
              }
            }
          }
        }
      `, { cursor });

      for (const edge of data.codeDiscountNodes.edges) {
        const discount = edge.node.codeDiscount;
        if (discount?.status === "ACTIVE") {
          discounts.push({
            title: discount.title,
            summary: discount.summary,
            codes: discount.codes.edges.map((e) => e.node.code),
          });
        }
      }

      cursor = data.codeDiscountNodes.pageInfo.hasNextPage
        ? data.codeDiscountNodes.pageInfo.endCursor
        : null;
    } while (cursor && discounts.length < MAX_DISCOUNTS);

    return { available: true, discounts };
  } catch {
    return { available: false, discounts: [] };
  }
}

export const listDiscountCodes = tool(
  "list_discount_codes",
  "Look up currently active discount codes shoppers can use. Call this " +
    "whenever a shopper asks what discount codes, deals, or bulk/volume " +
    "pricing are available - never guess at one.",
  {},
  async () => {
    const result = await fetchActiveDiscounts();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);
