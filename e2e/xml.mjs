import fs from "fs"; import { hmac } from "../src/crypto.js";
const ENC = fs.readFileSync("/workspace/growth/secrets/shopify_enc_key.txt", "utf8").trim(); const SHOP = "wsystem-einvoice-dev.myshopify.com";
const ids = JSON.parse(fs.readFileSync("/workspace/growth/shopify_e2e_orders.json"));
for (const [n, o] of Object.entries(ids)) { const t = (await hmac(ENC, `dl|${SHOP}|${o.id}`)).slice(0, 32); const x = await (await fetch(`https://wsystem.dev/shopify/d/${SHOP}/${o.id}?t=${t}`)).text();
  const g = (re) => [...x.matchAll(new RegExp(re.source, "g"))].map((m) => m[1]).join("|");
  console.log(n, "| inv", g(/<cbc:ID>([^<]*)<\/cbc:ID>/).split("|")[1], "| cat", g(/<cbc:ID>(S|AE|G|Z|E|K)<\/cbc:ID>/), "| rate", g(/<cbc:Percent>([^<]*)</), "| taxincl", g(/TaxInclusiveAmount[^>]*>([^<]*)</), "| prepaid", g(/PrepaidAmount[^>]*>([^<]*)</), "| ref", g(/<cbc:BuyerReference>([^<]*)</), "| buyerVAT", g(/CompanyID>([^<]*)</)); }
