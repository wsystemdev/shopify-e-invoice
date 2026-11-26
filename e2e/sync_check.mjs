import { requireAllowProd } from "/workspace/growth/bets/deny_prod.mjs";
// Usage: node e2e/sync_check.mjs <shop>.myshopify.com  — syncs billing and reads the shop key's plan (key never printed)
import fs from "fs"; import { hmac } from "../src/crypto.js";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"); const shop = process.argv[2];
const b = (s) => Buffer.from(s).toString("base64url"); const now = Math.floor(Date.now() / 1000);
const h = b(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b(JSON.stringify({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: app.SHOPIFY_CLIENT_ID, sub: "1", exp: now + 60, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: "x" }));
const tok = `${h}.${p}.${Buffer.from(await hmac(app.SHOPIFY_CLIENT_SECRET, h + "." + p, "base64"), "base64").toString("base64url")}`;
const H = { authorization: "Bearer " + tok, "content-type": "application/json" };
const s = await (await fetch("https://wsystem.dev/shopify/api/billing/sync", { method: "POST", headers: H })).json(); console.log("sync:", JSON.stringify(s).replace(/"?(api_key|key)"?:"[^"]*"/g, '"key":"<hidden>"'));
const g = await (await fetch("https://wsystem.dev/shopify/api/settings", { headers: H })).json(); const key = g.settings && g.settings.api_key;
console.log("managed key:", !!key);
if (key) { requireAllowProd("https://api.wsystem.dev/billing/usage", "shopify e2e/sync_check.mjs"); const u = await fetch("https://api.wsystem.dev/billing/usage", { headers: { "x-api-key": key, authorization: "Bearer " + key } }); console.log("usage", u.status, (await u.text()).replace(key, "<hidden>").slice(0, 400)); }
