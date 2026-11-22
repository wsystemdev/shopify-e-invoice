// node billing_cancel.mjs <numeric id>... : read back test flag and try appSubscriptionCancel. No secrets printed.
import fs from "fs";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"); const shop = app.SHOPIFY_DEV_STORE;
const tok = (await (await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: app.SHOPIFY_CLIENT_ID, client_secret: app.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }) })).json()).access_token;
const gql = async (query, variables) => (await (await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": tok, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) })).json());
for (const id of process.argv.slice(2)) {
  const gid = `gid://shopify/AppSubscription/${id}`;
  const g = await gql("query($id:ID!){ node(id:$id){ ... on AppSubscription { id name status test } } }", { id: gid });
  console.log("before", JSON.stringify(g.data && g.data.node || g.errors));
  const c = await gql("mutation($id:ID!){ appSubscriptionCancel(id:$id){ appSubscription{ id status } userErrors{ message } } }", { id: gid });
  console.log("cancel", JSON.stringify(c.data && c.data.appSubscriptionCancel || c.errors));
}
