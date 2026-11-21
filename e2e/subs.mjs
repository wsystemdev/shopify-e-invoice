import fs from "fs";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"); const T = fs.readFileSync("/workspace/growth/secrets/shopify_cc_token.txt", "utf8").trim();
const r = await fetch(`https://${app.SHOPIFY_DEV_STORE}/admin/api/2026-07/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": T, "content-type": "application/json" }, body: JSON.stringify({ query: "{ webhookSubscriptions(first:20){nodes{id topic createdAt endpoint{... on WebhookHttpEndpoint{callbackUrl}}}} }" }) });
console.log(JSON.stringify(await r.json(), null, 1).slice(0, 1500));
