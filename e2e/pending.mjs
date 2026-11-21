import fs from "fs";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env");
const cc = await (await fetch(`https://${app.SHOPIFY_DEV_STORE}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: app.SHOPIFY_CLIENT_ID, client_secret: app.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }) })).json();
const r = await fetch(`https://${app.SHOPIFY_DEV_STORE}/admin/api/2026-07/orders.json`, { method: "POST", headers: { "X-Shopify-Access-Token": cc.access_token, "content-type": "application/json" },
  body: JSON.stringify({ order: { currency: "EUR", taxes_included: false, financial_status: "pending", email: "kunde@example.com", send_receipt: false, inventory_behaviour: "bypass", payment_gateway_names: ["bank_transfer"],
    billing_address: { first_name: "Eva", last_name: "Kunde", company: "Kunde AG", address1: "Weg 2", city: "Köln", zip: "50667", country_code: "DE", country: "Germany" }, note_attributes: [{ name: "Leitweg-ID", value: "04011000-1234512345-35" }],
    line_items: [{ title: "E2E Manual-Create Item", quantity: 1, price: "100.00", tax_lines: [{ title: "MwSt", price: "19.00", rate: 0.19 }] }] } }) });
const j = await r.json(); console.log(r.status, j.order ? `${j.order.name} id=${j.order.id} ${j.order.financial_status}` : JSON.stringify(j).slice(0, 200));
