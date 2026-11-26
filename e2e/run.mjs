// E2E against the dev store + live Worker + live API. Secrets only from files, never printed.
// Live API calls (validate) are deny-listed unless ALLOW_PROD=1.
import fs from "fs";
import { hmac } from "../src/crypto.js";
import { ensureWebhooks } from "../src/index.js";
import { requireAllowProd } from "/workspace/growth/bets/deny_prod.mjs";
requireAllowProd("https://api.wsystem.dev/einvoice/validate", "shopify e2e/run.mjs");
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env"), e2e = rd("/workspace/growth/secrets/shopware_e2e.env");
const ENC = fs.readFileSync("/workspace/growth/secrets/shopify_enc_key.txt", "utf8").trim();
const TOKEN = fs.readFileSync("/workspace/growth/secrets/shopify_cc_token.txt", "utf8").trim();
const SHOP = app.SHOPIFY_DEV_STORE, V = "2026-07";
const sh = async (path, init = {}) => { const r = await fetch(`https://${SHOP}/admin/api/${V}${path}`, { ...init, headers: { "X-Shopify-Access-Token": TOKEN, "content-type": "application/json" } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const out = [];
const log = (k, v) => { out.push([k, v]); console.log(k.padEnd(34), v); };

const made = await ensureWebhooks({ APP_URL: "https://wsystem.dev/shopify", SHOPIFY_API_VERSION: V }, SHOP, TOKEN);
log("webhooks created now", made.join(",") || "(already present)");

const tl = (price, rate, title) => [{ title: title || "MwSt", price, rate }];
const addr = (o) => ({ first_name: "Eva", last_name: "Kunde", address1: "Weg 2", city: "Köln", zip: "50667", country_code: "DE", country: "Germany", ...o });
const orders = {
  A_de_19_7_leitweg: { currency: "EUR", taxes_included: false, financial_status: "pending", email: "kunde@example.com", billing_address: addr({ company: "Kunde AG" }), shipping_address: addr({ company: "Kunde AG" }),
    note_attributes: [{ name: "Leitweg-ID", value: "04011000-1234512345-35" }],
    line_items: [{ title: "E2E Buch", quantity: 2, price: "10.00", sku: "BK-1", tax_lines: tl("1.40", 0.07) }, { title: "E2E Hemd", quantity: 1, price: "50.00", sku: "SH-1", tax_lines: tl("9.50", 0.19) }],
    shipping_lines: [{ title: "DHL Paket", price: "5.00", code: "dhl", tax_lines: tl("0.95", 0.19) }] },
  B_eu_reverse_charge: { currency: "EUR", taxes_included: false, financial_status: "pending", email: "achats@sarl.example", billing_address: { first_name: "Luc", last_name: "Martin", company: "Martin SARL", address1: "1 Rue de la Paix", city: "Paris", zip: "75002", country_code: "FR", country: "France" },
    note_attributes: [{ name: "VAT ID", value: "FR12345678901" }],
    line_items: [{ title: "E2E Beratung", quantity: 1, price: "200.00", tax_lines: [] }] },
  C_us_export_incl: { currency: "EUR", taxes_included: true, financial_status: "pending", email: "us@example.com", billing_address: { first_name: "Sam", last_name: "Smith", address1: "5 Main St", city: "Austin", zip: "73301", country_code: "US", country: "United States" },
    line_items: [{ title: "E2E Poster", quantity: 3, price: "12.50", tax_lines: [] }] },
};
const only = process.env.ONLY;
const ids = fs.existsSync("/workspace/growth/shopify_e2e_orders.json") && process.env.RESUME ? JSON.parse(fs.readFileSync("/workspace/growth/shopify_e2e_orders.json")) : {};
for (const [name, o] of Object.entries(orders)) {
  if (ids[name] || (only && !name.startsWith(only))) continue;
  const j = await sh("/orders.json", { method: "POST", body: JSON.stringify({ order: { ...o, send_receipt: false, send_fulfillment_receipt: false, inventory_behaviour: "bypass" } }) });
  const amt = j.order.total_price;
  await new Promise((x) => setTimeout(x, 3000));
  const gq = await (await fetch(`https://${SHOP}/admin/api/${V}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ query: "mutation($id: ID!){ orderMarkAsPaid(input:{id:$id}){ order{ displayFinancialStatus } userErrors{ message } } }", variables: { id: `gid://shopify/Order/${j.order.id}` } }) })).json();
  log("markAsPaid " + name, JSON.stringify((gq.data && gq.data.orderMarkAsPaid) || gq.errors).slice(0, 150));
  fs.writeFileSync("/workspace/growth/shopify_e2e_orders.json", JSON.stringify({ ...ids, [name]: { id: j.order.id, name: j.order.name } }));
  ids[name] = { id: j.order.id, name: j.order.name, status: j.order.financial_status }; log("created " + name, `${j.order.name} id=${j.order.id} ${j.order.financial_status}`);
}
console.log("waiting for webhooks...");
await new Promise((r) => setTimeout(r, 15000));
for (const [name, o] of Object.entries(ids)) {
  const t = (await hmac(ENC, `dl|${SHOP}|${o.id}`)).slice(0, 32);
  const url = `https://wsystem.dev/shopify/d/${SHOP}/${o.id}?t=${t}`;
  let r = await fetch(url);
  for (let i = 0; i < 4 && r.status !== 200; i++) { await new Promise((x) => setTimeout(x, 5000)); r = await fetch(url); }
  const xml = r.status === 200 ? await r.text() : "";
  log(name + " download", `${r.status} ${xml.length} bytes ${/CustomizationID>[^<]*xrechnung/i.test(xml) ? "XRechnung CustomizationID" : ""} ${/<ubl:Invoice|<Invoice/.test(xml) ? "UBL Invoice" : ""}`);
  if (xml) {
    const v = await fetch("https://api.wsystem.dev/einvoice/validate", { method: "POST", headers: { "content-type": "application/json", "x-api-key": e2e.WSYSTEM_API_KEY }, body: JSON.stringify({ xml }) });
    const d = await v.json().catch(() => ({}));
    log(name + " independent validate", `${v.status} valid=${d.valid} errors=${(d.errors || []).length} ${JSON.stringify((d.errors || []).slice(0, 2).map((e) => e.rule_id))}`);
    const lc = /LineExtensionAmount[^>]*>([\d.]+)</.exec(xml); const tot = /PayableAmount[^>]*>([\d.]+)</.exec(xml);
    log(name + " payable", tot ? tot[1] : "?");
  }
  const od = await sh(`/orders/${o.id}.json?fields=id,tags,total_price`);
  log(name + " order tags", JSON.stringify(od.order.tags) + " total=" + od.order.total_price);
}
fs.writeFileSync("/workspace/growth/shopify_e2e_orders.json", JSON.stringify(ids, null, 1));
