import fs from "fs"; import { unseal } from "../src/crypto.js";
const f = process.argv[2]; let raw = fs.readFileSync(f, "utf8"); raw = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
let rec = JSON.parse(raw); if (typeof rec === "string") rec = JSON.parse(rec);
const ENC = fs.readFileSync("/workspace/growth/secrets/shopify_enc_key.txt", "utf8").trim();
console.log("token stored:", !!rec.token);
if (!rec.token) process.exit();
const tok = await unseal(ENC, rec.token); console.log("token prefix:", tok.slice(0, 6) + "…");
for (const p of ["/admin/oauth/access_scopes.json", "/admin/api/2026-07/orders.json?limit=1&status=any", "/admin/api/2026-07/shop.json"]) {
  const r = await fetch(`https://wsystem-einvoice-dev.myshopify.com${p}`, { headers: { "X-Shopify-Access-Token": tok } });
  console.log(p, r.status, (await r.text()).replace(/"id":\d+/g, "").slice(0, 200));
}
