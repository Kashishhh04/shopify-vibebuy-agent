import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { adminRequest } from "../adminClient.js";

// Read-only: whether an order "went through" is never knowable at the
// moment update_cart hands back a checkout link (checkout happens later,
// outside this session) - this is how the agent answers that question
// after the fact, instead of ever guessing from the cart tools alone.
// Requires the read_orders scope on the same Dev Dashboard app as the
// Admin client-credentials setup from Lab 3.6 - no separate app needed.
// Shared by the check_order_status tool below and server.js's deterministic
// order-status flow, so both look up orders the same way instead of the
// tool's own logic silently not applying to the other.
export async function fetchOrdersByEmail(email) {
  const PAGE_SIZE = 50;
  const MAX_ORDERS = 250;
  const orders = [];
  let cursor = null;

  do {
    const data = await adminRequest(
      `
        query ordersByEmail($query: String!, $cursor: String) {
          orders(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                name
                displayFinancialStatus
                displayFulfillmentStatus
              }
            }
          }
        }
      `,
      { query: `email:${email}`, cursor }
    );

    for (const e of data.orders.edges) {
      orders.push({
        name: e.node.name,
        financialStatus: e.node.displayFinancialStatus,
        fulfillmentStatus: e.node.displayFulfillmentStatus,
      });
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor && orders.length < MAX_ORDERS);

  return orders;
}

export const checkOrderStatus = tool(
  "check_order_status",
  "Look up a shopper's past orders by email to check whether an order went " +
    "through. Returns each order's name, financial status, and fulfillment " +
    "status, most recent first.",
  { email: z.string().email() },
  async ({ email }) => {
    const output = z.object({
      orders: z.array(z.object({
        name: z.string(),
        financialStatus: z.string().nullable(),
        fulfillmentStatus: z.string().nullable(),
      })),
    }).parse({ orders: await fetchOrdersByEmail(email) });

    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  }
);
