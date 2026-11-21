import test from "node:test";
import assert from "node:assert/strict";
import app, { generate, ensureWebhooks } from "../src/index.js";
import { hmac, seal, unseal, verifySessionToken } from "../src/crypto.js";

class KV { constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v.value) : v.value; }
  async put(k, v, o = {}) { this.m.set(k, { value: v, metadata: o.metadata }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "" } = {}) { const keys = [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })); return { keys, list_complete: true }; } }
const env = () => ({ STORE: new KV(), SHOPIFY_API_KEY: "cid", SHOPIFY_API_SECRET: "sec", ENC_KEY: "k".repeat(40), APP_URL: "https://app.example", SHOPIFY_API_VERSION: "2026-07", API_BASE: "https://api.test" });
const ctx = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };
const SHOP = "demo.myshopify.com";
const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function jwt(claims, secret = "sec") { const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b64url(JSON.stringify(claims)); const sig = (await hmac(secret, h + "." + p, "base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return `${h}.${p}.${sig}`; }
const claims = (o = {}) => ({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`.replace(/$/, "/admin"), aud: "cid", exp: Date.now() / 1000 + 60, nbf: Date.now() / 1000 - 5, ...o });
async function wh(env_, path, body, topic, secret = "sec") {
  const raw = JSON.stringify(body); const c = ctx();
  const r = await app.fetch(new Request("https://app.example" + path, { method: "POST", body: raw, headers: { "x-shopify-hmac-sha256": await hmac(secret, raw, "base64"), "x-shopify-shop-domain": SHOP, "x-shopify-topic": topic } }), env_, c);
  await c.done(); return r;
}
const seedShop = async (e, settings = {}) => { await e.STORE.put(`shop:${SHOP}`, JSON.stringify({ token: await seal(e.ENC_KEY, "shpat_x"), settings: { seller_name: "M GmbH", trigger: "paid", ...settings } })); };
const ORDER = { id: 77, name: "#1002", currency: "EUR", taxes_included: true, financial_status: "paid", total_price: "119.00", tags: "vip", billing_address: { company: "K AG", country_code: "DE" }, line_items: [{ title: "W", quantity: 1, price: "119", total_discount: "0", tax_lines: [{ price: "19", rate: 0.19 }] }], shipping_lines: [], note_attributes: [] };

test("session token verification", async () => {
  assert.equal((await verifySessionToken(await jwt(claims()), "sec", "cid")).shop, SHOP);
  assert.equal(await verifySessionToken(await jwt(claims(), "wrong"), "sec", "cid"), null);
  assert.equal(await verifySessionToken(await jwt(claims({ aud: "x" })), "sec", "cid"), null);
  assert.equal(await verifySessionToken(await jwt(claims({ exp: 1 })), "sec", "cid"), null);
  assert.equal(await verifySessionToken(await jwt(claims({ dest: "https://evil.com/admin" })), "sec", "cid"), null);
});
test("seal/unseal roundtrip", async () => { assert.equal(await unseal("k", await seal("k", "hello")), "hello"); });
test("webhook rejects bad hmac", async () => {
  const r = await wh(env(), "/webhooks/orders-paid", ORDER, "orders/paid", "wrong"); assert.equal(r.status, 401);
});
test("orders/paid creates and stores a valid invoice, tags order, download works", async () => {
  const e = env(); await seedShop(e); const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => { calls.push([String(u), i]); if (String(u).includes("api.test")) return new Response(JSON.stringify({ valid: true, xml: "<Invoice/>", errors: [], totals: { total_with_vat: 119 } })); return new Response("{}"); };
  try { assert.equal((await wh(e, "/webhooks/orders-paid", ORDER, "orders/paid")).status, 200); } finally { globalThis.fetch = orig; }
  const rec = await e.STORE.get(`inv:${SHOP}:77`, "json"); assert.equal(rec.valid, true); assert.equal(rec.number, "1002");
  const put = calls.find(([u]) => u.includes("/orders/77.json")); const sent = JSON.parse(put[1].body);
  assert.match(sent.order.tags, /vip, e-invoice-valid/); assert.match(sent.order.metafields[0].value, /^https:\/\/app\.example\/d\/demo\.myshopify\.com\/77\?t=/);
  const dl = await app.fetch(new Request(sent.order.metafields[0].value), e, ctx()); assert.equal(dl.status, 200); assert.equal(await dl.text(), "<Invoice/>");
  const bad = await app.fetch(new Request(`https://app.example/d/${SHOP}/77?t=deadbeef`), e, ctx()); assert.equal(bad.status, 404);
});
test("orders/create is ignored when trigger is paid; idempotent", async () => {
  const e = env(); await seedShop(e); let n = 0; const orig = globalThis.fetch;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ valid: true, xml: "<I/>" })); };
  try {
    await wh(e, "/webhooks/orders-create", ORDER, "orders/create"); assert.equal(n, 0);
    await wh(e, "/webhooks/orders-paid", ORDER, "orders/paid"); const first = n; await wh(e, "/webhooks/orders-paid", ORDER, "orders/paid"); assert.equal(n, first);
  } finally { globalThis.fetch = orig; }
});
test("failed validation stores errors and no downloadable xml", async () => {
  const e = env(); const sd = { settings: { seller_name: "M" }, token: "" };
  const rec = await generate(e, SHOP, ORDER, sd, { f: async () => new Response(JSON.stringify({ valid: false, xml: "<x/>", errors: [{ rule_id: "BR-DE-2", explain: { what: "missing", fix: "add phone" } }] })) });
  assert.equal(rec.valid, false); assert.equal(rec.xml, ""); assert.equal(rec.errors[0].fix, "add phone");
});
test("API outage is recorded, not thrown", async () => {
  const e = env(); const rec = await generate(e, SHOP, ORDER, { settings: {}, token: "" }, { f: async () => { throw new Error("down"); } });
  assert.equal(rec.valid, false); assert.equal(rec.errors[0].rule_id, "API");
});
test("GDPR: customers/redact, data_request, shop/redact", async () => {
  const e = env(); await seedShop(e);
  await e.STORE.put(`inv:${SHOP}:77`, "{}"); await e.STORE.put(`inv:${SHOP}:78`, "{}");
  assert.equal((await wh(e, "/webhooks/compliance", { shop_domain: SHOP, orders_to_redact: [77] }, "customers/redact")).status, 200);
  assert.equal(await e.STORE.get(`inv:${SHOP}:77`), null); assert.notEqual(await e.STORE.get(`inv:${SHOP}:78`), null);
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP, data_request: { id: 5 }, orders_requested: [78] }, "customers/data_request");
  assert.notEqual(await e.STORE.get(`dsr:${SHOP}:5`), null);
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP }, "shop/redact");
  assert.equal(await e.STORE.get(`inv:${SHOP}:78`), null); assert.equal(await e.STORE.get(`shop:${SHOP}`), null); assert.equal(e.STORE.m.size, 0);
});
test("app uninstall drops token only", async () => {
  const e = env(); await seedShop(e); await wh(e, "/webhooks/app-uninstalled", {}, "app/uninstalled");
  assert.equal(JSON.parse((await e.STORE.get(`shop:${SHOP}`))).token, "");
});
test("settings API requires session, masks and keeps the API key, encrypts at rest", async () => {
  const e = env(); await seedShop(e);
  assert.equal((await app.fetch(new Request("https://app.example/api/settings"), e, ctx())).status, 401);
  const h = { authorization: "Bearer " + (await jwt(claims())) };
  const post = await app.fetch(new Request("https://app.example/api/settings", { method: "POST", headers: h, body: JSON.stringify({ api_key: "ws_secret123", seller_name: "Neu GmbH", format: "bogus" }) }), e, ctx());
  assert.equal((await post.json()).ok, true);
  assert.ok(!(await e.STORE.get(`shop:${SHOP}`)).includes("ws_secret123"));
  const g = await (await app.fetch(new Request("https://app.example/api/settings", { headers: h }), e, ctx())).json();
  assert.equal(g.settings.api_key, "********"); assert.equal(g.settings.seller_name, "Neu GmbH"); assert.equal(g.settings.format, "xrechnung");
  await app.fetch(new Request("https://app.example/api/settings", { method: "POST", headers: h, body: JSON.stringify({ api_key: "********", seller_city: "Bonn" }) }), e, ctx());
  assert.equal((await (await import("../src/index.js")).default.fetch(new Request("https://app.example/health"), e, ctx())).status, 200);
});
test("admin page needs a valid hmac", async () => {
  const e = env(); const q = `host=abc&shop=${SHOP}&timestamp=1`; const sig = await hmac("sec", q);
  assert.equal((await app.fetch(new Request(`https://app.example/app?${q}&hmac=${sig}`), e, ctx())).status, 200);
  assert.equal((await app.fetch(new Request(`https://app.example/app?${q}&hmac=bad`), e, ctx())).status, 400);
});

test("ensureWebhooks creates only missing subscriptions through GraphQL", async () => {
  const e = env(); const sent = [];
  const f = async (u, i) => { const b = JSON.parse(i.body); sent.push(b); if (b.query.startsWith("{")) return new Response(JSON.stringify({ data: { webhookSubscriptions: { nodes: [{ topic: "ORDERS_PAID", endpoint: { callbackUrl: "https://app.example/webhooks/orders-paid" } }] } } }));
    return new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [] } } })); };
  const made = await ensureWebhooks(e, SHOP, "tok", f);
  assert.deepEqual(made, ["ORDERS_CREATE", "APP_UNINSTALLED"]);
  assert.equal(sent[1].variables.s.callbackUrl, "https://app.example/webhooks/orders-create");
});
test("other /shopify-* site pages pass through to the origin", async () => {
  const orig = globalThis.fetch; let hit = "";
  globalThis.fetch = async (r) => { hit = r.url; return new Response("site"); };
  try { const r = await app.fetch(new Request("https://wsystem.dev/shopify-xrechnung"), env(), ctx()); assert.equal(await r.text(), "site"); assert.equal(hit, "https://wsystem.dev/shopify-xrechnung"); } finally { globalThis.fetch = orig; }
});
test("app page allows Shopify framing only", async () => {
  const e = env(); const q = `host=abc&shop=${SHOP}`; const sig = await hmac("sec", q);
  const r = await app.fetch(new Request(`https://wsystem.dev/shopify?${q}&hmac=${sig}`), e, ctx());
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-security-policy"), "frame-ancestors https://*.myshopify.com https://admin.shopify.com"); assert.equal(r.headers.get("x-frame-options"), null);
});
