const domain = process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const token = process.env.STOREFRONT_PRIVATE_TOKEN;

export async function storefrontRequest(query, variables) {
  const res = await fetch(`https://${domain}/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Shopify-Storefront-Private-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
