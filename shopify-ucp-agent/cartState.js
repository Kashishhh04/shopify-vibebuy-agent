import { getActiveBxgyDiscount } from "./bogoDiscount.js";

// cartId and each line's lineId are Shopify-internal tokens that a model can
// mistype or half-remember several turns later - so they live only in the
// closure below and never appear in anything this module returns. Full
// per-line product details (not just id/quantity) are pulled on every
// mutation, not only the read-only getCart() below, so an "add to cart"
// confirmation can show the shopper's real cart - product cards, same as a
// search_products or view_cart reply - instead of just a bare checkout link.
// cost.totalAmount (the line's actual, post-discount charge) and each
// product's collections are pulled too - not to display directly, but so a
// free-gift line can be told apart from a paid one, and so a Buy-X-Get-Y
// discount's own collections can be matched against what's actually in the
// cart (see computeFreeGiftInfo below).
const CART_FIELDS = `
  checkoutUrl
  totalQuantity
  cost { totalAmount { amount currencyCode } }
  discountCodes { code }
  lines(first: 250) {
    edges {
      node {
        id
        quantity
        cost { totalAmount { amount } }
        merchandise {
          ... on ProductVariant {
            id
            availableForSale
            price { amount currencyCode }
            image { url altText }
            product {
              id
              title
              collections(first: 10) { edges { node { id } } }
            }
          }
        }
      }
    }
  }
`;

export function createCartManager(storefrontRequest) {
  let cartId = null;
  const lineIdByVariantId = new Map();
  // Mirrors each line's current quantity alongside lineIdByVariantId - so
  // addFreeGift (see below) can increment an existing line instead of
  // blindly adding a new one, the same way addOrSetQuantity already does.
  const quantityByVariantId = new Map();
  // Mirrors the cart's own discountCodes on every fetch/mutation, so
  // applyDiscountCode and addFreeGift can add a code alongside whatever's
  // already applied instead of clobbering it, without an extra round trip
  // just to ask the cart what it currently has on it.
  let appliedCodes = [];

  function syncLines(cart) {
    lineIdByVariantId.clear();
    quantityByVariantId.clear();
    for (const edge of cart.lines.edges) {
      lineIdByVariantId.set(edge.node.merchandise.id, edge.node.id);
      quantityByVariantId.set(edge.node.merchandise.id, edge.node.quantity);
    }
    appliedCodes = (cart.discountCodes ?? []).map((entry) => entry.code);
  }

  function cartResultFrom(cart) {
    // Shopify itself can split one variant across multiple raw cart lines
    // once a Buy-X-Get-Y code is applied - e.g. to track which units counted
    // toward the "buy" side - even when every resulting line is priced the
    // same. Grouped by variant + free-status here so the shopper only ever
    // sees one card per product (with a summed quantity), regardless of how
    // many lines Shopify's own discount allocation split it into
    // underneath.
    const byKey = new Map();
    for (const edge of cart.lines.edges) {
      const variant = edge.node.merchandise;
      // A line's cost.totalAmount is what Shopify is actually charging for
      // it after discounts - as opposed to variant.price, the plain retail
      // price - so this is the only reliable way to tell a free-gift line
      // (0) apart from a normal paid one, regardless of how it got there.
      const isFree = Number(edge.node.cost.totalAmount.amount) === 0;
      const key = `${variant.id}:${isFree}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.quantity += edge.node.quantity;
        continue;
      }
      byKey.set(key, {
        variantId: variant.id,
        title: variant.product.title,
        price: variant.price.amount,
        currency: variant.price.currencyCode,
        quantity: edge.node.quantity,
        availableForSale: variant.availableForSale,
        imageUrl: variant.image?.url ?? null,
        imageAlt: variant.image?.altText || variant.product.title,
        isFree,
      });
    }
    const lineItems = [...byKey.values()];
    // cartUrl (a link to a real, browsable cart page - as opposed to
    // checkoutUrl, which the Storefront API always points at checkout) isn't
    // something this cart object can produce on its own: the store's plain
    // /cart route is shared browser state, the same page for every visitor,
    // not scoped to any one shopper's own Storefront API cart. server.js
    // builds that link instead, from its own per-sessionId /cart-view page,
    // and attaches it to what this module returns.
    return {
      checkoutUrl: cart.checkoutUrl,
      itemCount: cart.totalQuantity,
      total: cart.cost.totalAmount.amount,
      currency: cart.cost.totalAmount.currencyCode,
      discountCodes: (cart.discountCodes ?? []).map((entry) => entry.code),
      lineItems,
    };
  }

  // Buy-X-Get-Y eligibility is computed from the cart's own lines (which
  // collection(s) each line's product belongs to, and how many units are
  // already free) rather than tracked as separate state here - that way it's
  // always consistent with whatever's actually in the cart, including after
  // a shopper removes an item and drops back below the threshold.
  async function computeFreeGiftInfo(cart) {
    const bxgy = await getActiveBxgyDiscount();
    if (!bxgy) return null;

    let buyQty = 0;
    let freeClaimedQty = 0;
    for (const edge of cart.lines.edges) {
      const product = edge.node.merchandise.product;
      const collectionIds = product.collections.edges.map((c) => c.node.id);
      const matchesBuy =
        bxgy.buyProductIds.includes(product.id) ||
        bxgy.buyCollectionIds.some((id) => collectionIds.includes(id));
      const matchesGet =
        bxgy.getProductIds.includes(product.id) ||
        bxgy.getCollectionIds.some((id) => collectionIds.includes(id));

      if (matchesBuy) buyQty += edge.node.quantity;
      if (matchesGet && Number(edge.node.cost.totalAmount.amount) === 0) {
        freeClaimedQty += edge.node.quantity;
      }
    }

    const entitled = Math.floor(buyQty / bxgy.buyQuantity) * bxgy.getQuantity;
    const remainingSlots = entitled - freeClaimedQty;
    if (remainingSlots <= 0) return null;

    const options = await fetchFreeGiftOptions(bxgy);
    if (options.length === 0) return null;

    return { remainingSlots, options };
  }

  // Product cards for whichever collection(s)/product(s) the discount's
  // "customer gets" side allows - what the shopper actually gets to pick
  // from as their free item.
  async function fetchFreeGiftOptions(bxgy) {
    const options = [];

    for (const collectionId of bxgy.getCollectionIds) {
      const data = await storefrontRequest(
        `
          query getGiftCollection($id: ID!) {
            node(id: $id) {
              ... on Collection {
                products(first: 20) {
                  edges {
                    node {
                      title
                      featuredImage { url altText }
                      variants(first: 1) {
                        edges { node { id price { amount currencyCode } availableForSale } }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { id: collectionId }
      );

      for (const edge of data.node?.products?.edges ?? []) {
        const variant = edge.node.variants.edges[0]?.node;
        if (!variant) continue;
        options.push({
          variantId: variant.id,
          title: edge.node.title,
          price: variant.price.amount,
          currency: variant.price.currencyCode,
          availableForSale: variant.availableForSale,
          imageUrl: edge.node.featuredImage?.url ?? null,
          imageAlt: edge.node.featuredImage?.altText || edge.node.title,
        });
      }
    }

    if (bxgy.getProductIds.length > 0) {
      const data = await storefrontRequest(
        `
          query getGiftProducts($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                title
                featuredImage { url altText }
                variants(first: 1) {
                  edges { node { id price { amount currencyCode } availableForSale } }
                }
              }
            }
          }
        `,
        { ids: bxgy.getProductIds }
      );

      for (const node of data.nodes ?? []) {
        const variant = node?.variants.edges[0]?.node;
        if (!variant) continue;
        options.push({
          variantId: variant.id,
          title: node.title,
          price: variant.price.amount,
          currency: variant.price.currencyCode,
          availableForSale: variant.availableForSale,
          imageUrl: node.featuredImage?.url ?? null,
          imageAlt: node.featuredImage?.altText || node.title,
        });
      }
    }

    return options;
  }

  // Every mutating/read function below returns through this, so freeGift
  // eligibility (and the options to show for it) rides along on every cart
  // response the same way checkoutUrl/lineItems already do.
  async function buildResult(cart, extra = {}) {
    return { ...cartResultFrom(cart), freeGift: await computeFreeGiftInfo(cart), ...extra };
  }

  function assertNoErrors(userErrors) {
    if (userErrors.length > 0) {
      throw new Error(JSON.stringify(userErrors));
    }
  }

  async function createCartWithLine(variantId, quantity) {
    const created = await storefrontRequest(
      `mutation { cartCreate { cart { id } } }`
    );
    cartId = created.cartCreate.cart.id;
    return addLine(variantId, quantity);
  }

  async function addLine(variantId, quantity) {
    const data = await storefrontRequest(
      `
        mutation cartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
          cartLinesAdd(cartId: $cartId, lines: $lines) {
            cart { ${CART_FIELDS} }
            userErrors { field message }
          }
        }
      `,
      { cartId, lines: [{ merchandiseId: variantId, quantity }] }
    );

    assertNoErrors(data.cartLinesAdd.userErrors);
    syncLines(data.cartLinesAdd.cart);
    return buildResult(data.cartLinesAdd.cart, { variantId, quantity });
  }

  async function updateLine(lineId, variantId, quantity) {
    const data = await storefrontRequest(
      `
        mutation cartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
          cartLinesUpdate(cartId: $cartId, lines: $lines) {
            cart { ${CART_FIELDS} }
            userErrors { field message }
          }
        }
      `,
      { cartId, lines: [{ id: lineId, quantity }] }
    );

    assertNoErrors(data.cartLinesUpdate.userErrors);
    syncLines(data.cartLinesUpdate.cart);
    return buildResult(data.cartLinesUpdate.cart, { variantId, quantity });
  }

  async function removeLine(lineId, variantId) {
    const data = await storefrontRequest(
      `
        mutation cartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
          cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
            cart { ${CART_FIELDS} }
            userErrors { field message }
          }
        }
      `,
      { cartId, lineIds: [lineId] }
    );

    assertNoErrors(data.cartLinesRemove.userErrors);
    syncLines(data.cartLinesRemove.cart);
    return buildResult(data.cartLinesRemove.cart, { variantId, quantity: 0 });
  }

  // Creates the cart on first use, adds a new line for a variant not yet in
  // it, updates the quantity in place for one that already is, and removes
  // a tracked line on quantity 0 (a quantity-0 call for a variant that was
  // never added is a no-op - returns null, no request made).
  async function addOrSetQuantity(variantId, quantity) {
    const existingLineId = lineIdByVariantId.get(variantId);

    if (quantity === 0) {
      return existingLineId ? removeLine(existingLineId, variantId) : null;
    }

    if (!cartId) return createCartWithLine(variantId, quantity);
    if (existingLineId) return updateLine(existingLineId, variantId, quantity);
    return addLine(variantId, quantity);
  }

  // Read-only lookup for "what's in my cart" - distinct from the mutating
  // functions above, so it never creates a cart. No cart has been created
  // until something's been added, in which case there's nothing to report.
  async function getCart() {
    if (!cartId) {
      return { checkoutUrl: null, itemCount: 0, total: "0.00", currency: null, discountCodes: [], lineItems: [], freeGift: null };
    }

    const data = await storefrontRequest(
      `
        query getCart($cartId: ID!) {
          cart(id: $cartId) { ${CART_FIELDS} }
        }
      `,
      { cartId }
    );

    if (!data.cart) {
      return { checkoutUrl: null, itemCount: 0, total: "0.00", currency: null, discountCodes: [], lineItems: [], freeGift: null };
    }

    syncLines(data.cart);
    return buildResult(data.cart);
  }

  // Cheap, synchronous check for whether a cart exists yet at all - used to
  // skip free-gift eligibility work entirely for a shopper who hasn't added
  // anything, without a network round trip just to find that out.
  function hasCart() {
    return cartId !== null;
  }

  // Applies a discount code to this same tracked cart, alongside whatever
  // codes (if any) are already on it - no cart exists yet (nothing has been
  // added), this is a no-op, same as addOrSetQuantity's own no-op case.
  async function applyDiscountCode(code) {
    if (!cartId) return null;
    return updateDiscountCodes([...new Set([...appliedCodes, code])]);
  }

  async function updateDiscountCodes(codes) {
    const data = await storefrontRequest(
      `
        mutation cartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
          cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
            cart { ${CART_FIELDS} }
            userErrors { field message }
          }
        }
      `,
      { cartId, discountCodes: codes }
    );

    assertNoErrors(data.cartDiscountCodesUpdate.userErrors);
    syncLines(data.cartDiscountCodesUpdate.cart);
    return buildResult(data.cartDiscountCodesUpdate.cart);
  }

  // Adds a shopper's chosen free-gift pick to the cart, making sure the
  // store's own Buy-X-Get-Y code is applied first (alongside any other
  // applied codes) so Shopify actually prices it at $0 once the qualifying
  // quantity is met - the shopper never needs to know the code exists.
  async function addFreeGift(variantId) {
    if (!cartId) throw new Error("Add a qualifying item to your cart first.");

    const bxgy = await getActiveBxgyDiscount();
    if (!bxgy) throw new Error("There's no free-gift promotion active right now.");

    if (!appliedCodes.includes(bxgy.code)) {
      await updateDiscountCodes([...appliedCodes, bxgy.code]);
    }

    // A free-gift option can be a product the shopper already has in their
    // cart at full price (it only has to be in the "get" collection, nothing
    // stops it also being something they picked themselves) - addLine alone
    // doesn't merge with an existing line for the same variant, it creates a
    // second separate one, so this has to dispatch the same way
    // addOrSetQuantity does: update the existing line in place if there is
    // one, and only add a new line if there isn't.
    const existingLineId = lineIdByVariantId.get(variantId);
    if (existingLineId) {
      const currentQuantity = quantityByVariantId.get(variantId) ?? 0;
      return updateLine(existingLineId, variantId, currentQuantity + 1);
    }
    return addLine(variantId, 1);
  }

  return { addOrSetQuantity, applyDiscountCode, addFreeGift, getCart, hasCart };
}
