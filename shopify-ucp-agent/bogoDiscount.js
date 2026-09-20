import { adminRequest } from "./adminClient.js";

// Rechecking the Admin API on every single chat turn (see cartState.js) would
// be wasteful for something that changes on the order of "a merchant edits a
// promotion", not "a shopper sends a message" - a short cache is enough to
// keep this fast without ever being far out of date.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedValue = null;
let cachedAt = 0;

function collectIds(items, typename) {
  if (items?.__typename !== typename) return [];
  const key = typename === "DiscountCollections" ? "collections" : "products";
  return (items[key]?.edges ?? []).map((edge) => edge.node.id);
}

async function fetchActiveBxgyDiscount() {
  const PAGE_SIZE = 50;
  let cursor = null;

  try {
    do {
      const data = await adminRequest(
        `
          query bxgyDiscounts($cursor: String) {
            codeDiscountNodes(first: ${PAGE_SIZE}, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  codeDiscount {
                    __typename
                    ... on DiscountCodeBxgy {
                      status
                      codes(first: 1) { edges { node { code } } }
                      customerBuys {
                        value { __typename ... on DiscountQuantity { quantity } }
                        items {
                          __typename
                          ... on DiscountProducts { products(first: 50) { edges { node { id } } } }
                          ... on DiscountCollections { collections(first: 10) { edges { node { id } } } }
                        }
                      }
                      customerGets {
                        value {
                          __typename
                          ... on DiscountOnQuantity { quantity { quantity } }
                        }
                        items {
                          __typename
                          ... on DiscountProducts { products(first: 50) { edges { node { id } } } }
                          ... on DiscountCollections { collections(first: 10) { edges { node { id } } } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { cursor },
      );

      // First ACTIVE (not SCHEDULED/EXPIRED) Buy-X-Get-Y discount wins - this
      // store only ever has one live at a time in practice.
      for (const edge of data.codeDiscountNodes.edges) {
        const discount = edge.node.codeDiscount;
        if (discount?.__typename !== "DiscountCodeBxgy" || discount.status !== "ACTIVE") continue;

        const code = discount.codes.edges[0]?.node.code;
        if (!code) continue;

        return {
          code,
          buyQuantity: Number(discount.customerBuys.value?.quantity ?? 1),
          buyCollectionIds: collectIds(discount.customerBuys.items, "DiscountCollections"),
          buyProductIds: collectIds(discount.customerBuys.items, "DiscountProducts"),
          getQuantity: Number(discount.customerGets.value?.quantity?.quantity ?? 1),
          getCollectionIds: collectIds(discount.customerGets.items, "DiscountCollections"),
          getProductIds: collectIds(discount.customerGets.items, "DiscountProducts"),
        };
      }

      cursor = data.codeDiscountNodes.pageInfo.hasNextPage ? data.codeDiscountNodes.pageInfo.endCursor : null;
    } while (cursor);

    return null;
  } catch {
    // Missing Admin scope, transient API error, etc. - degrade to "no
    // free-gift promotion right now" rather than breaking the chat turn that
    // happened to trigger this lookup.
    return null;
  }
}

// Returns the store's currently active Buy-X-Get-Y discount (code, the
// quantity/collection or product ids on each side), or null if none is
// active right now.
export async function getActiveBxgyDiscount() {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return cachedValue;

  cachedValue = await fetchActiveBxgyDiscount();
  cachedAt = Date.now();
  return cachedValue;
}
