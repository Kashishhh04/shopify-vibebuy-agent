import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { storefrontRequest } from "../storefrontClient.js";

const PRODUCT_SCHEMA = z.object({
  title: z.string(), price: z.string(), currency: z.string(), variantId: z.string(),
  availableForSale: z.boolean(), imageUrl: z.string().nullable(), imageAlt: z.string(),
  // Plain-text description, when the merchant filled one in - most products
  // in this catalog don't have one, but this is the only real source of
  // feature/quality/material info that exists at all, so the model can
  // actually answer those questions instead of always refusing.
  description: z.string(),
});

const PAGE_SIZE = 50;
const MAX_PRODUCTS = 250;

async function runSearch(query) {
  const products = [];
  let cursor = null;

  do {
    const data = await storefrontRequest(`
      query searchProducts($query: String, $cursor: String) {
        products(first: ${PAGE_SIZE}, query: $query, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              title
              description
              featuredImage { url altText }
              priceRange { minVariantPrice { amount currencyCode } }
              variants(first: 1) { edges { node { id availableForSale } } }
            }
          }
        }
      }
    `, { query, cursor });

    for (const e of data.products.edges) {
      products.push(PRODUCT_SCHEMA.parse({
        title: e.node.title,
        description: e.node.description ?? "",
        price: e.node.priceRange.minVariantPrice.amount,
        currency: e.node.priceRange.minVariantPrice.currencyCode,
        variantId: e.node.variants.edges[0]?.node.id ?? "",
        availableForSale: e.node.variants.edges[0]?.node.availableForSale ?? false,
        imageUrl: e.node.featuredImage?.url ?? null,
        imageAlt: e.node.featuredImage?.altText || e.node.title,
      }));
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor && products.length < MAX_PRODUCTS);

  return products;
}

// Shared by the search_products tool below and server.js's deterministic
// add-to-cart-by-name flow, so both get the same plural-retry behavior
// instead of the tool's own workaround silently not applying to the other.
export async function searchCatalog(query) {
  let products = await runSearch(query);

  // Shopify's Storefront search doesn't reliably stem plurals - "snowboards"
  // can return zero results even though every one of our snowboards
  // matches "snowboard". Retrying the singular form on an empty result
  // catches the most common shopper phrasing (a model that happened to
  // pass the plural through verbatim, e.g. echoing "do you have any
  // snowboards?") without ever masking a genuinely empty catalog search -
  // a real singular query that finds nothing still finds nothing here.
  const trimmed = query.trim();
  if (products.length === 0 && /[a-z]s$/i.test(trimmed) && trimmed.length > 3) {
    products = await runSearch(trimmed.slice(0, -1));
  }

  return { query: trimmed, products };
}

export const searchProducts = tool(
  "search_products",
  "Search the store catalog for products matching a text query.",
  { query: z.string().default("") },
  async ({ query }) => {
    const output = z
      .object({ query: z.string(), products: z.array(PRODUCT_SCHEMA) })
      .parse(await searchCatalog(query));
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  }
);
