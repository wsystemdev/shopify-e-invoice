// Dev-store test charge: node billing_test.mjs create | status. Never prints secrets/tokens.
import fs from "fs";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"); const shop = app.SHOPIFY_DEV_STORE;
const tr = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: app.SHOPIFY_CLIENT_ID, client_secret: app.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }) });
const tok = (await tr.json()).access_token; if (!tok) { console.log("no token", tr.status); process.exit(1); }
const gql = async (query, variables) => (await (await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": tok, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) })).json());
if (process.argv[2] === "create") {
  const r = await gql("mutation($n:String!,$u:URL!){ appSubscriptionCreate(name:$n,returnUrl:$u,test:true,lineItems:[{plan:{appRecurringPricingDetails:{price:{amount:\"13.00\",currencyCode:USD},interval:EVERY_30_DAYS}}}]){ confirmationUrl appSubscription{id status} userErrors{message} } }",
    { n: "W System Shop", u: `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps/${app.SHOPIFY_CLIENT_ID}` });
  console.log(JSON.stringify(r.data && r.data.appSubscriptionCreate || r.errors, null, 1));
} else console.log(JSON.stringify((await gql("{ currentAppInstallation { activeSubscriptions { id name status test } } }")).data, null, 1));
