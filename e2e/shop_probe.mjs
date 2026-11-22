// node shop_probe.mjs <shop.myshopify.com>: active subscriptions + plan flag via client-credentials token. No secrets printed.
import fs from "fs";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"); const shop = process.argv[2];
const t = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: app.SHOPIFY_CLIENT_ID, client_secret: app.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }) });
const j = await t.json(); if (!j.access_token) { console.log("token fail", t.status, JSON.stringify(j).slice(0, 200)); process.exit(1); }
const r = await (await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": j.access_token, "content-type": "application/json" }, body: JSON.stringify({ query: "{ shop{ plan{ partnerDevelopment } } currentAppInstallation { activeSubscriptions { id name status test } allSubscriptions(first:10){ nodes{ id name status test } } } webhookSubscriptions(first:20){ nodes{ topic endpoint{ ... on WebhookHttpEndpoint{ callbackUrl } } } } }" }) })).json();
console.log(JSON.stringify(r.data || r.errors, null, 1));
