import test from "node:test";
import assert from "node:assert/strict";
import app, { generate, ensureWebhooks, gqlOrderToRest, LINE_NODE, ORDER_FIELDS } from "../src/index.js";
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
const claims = (o = {}) => ({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: "cid", exp: Date.now() / 1000 + 60, nbf: Date.now() / 1000 - 5, ...o });
async function wh(env_, path, body, topic, secret = "sec") {
  const raw = JSON.stringify(body); const c = ctx();
  const r = await app.fetch(new Request("https://app.example" + path, { method: "POST", body: raw, headers: { "x-shopify-hmac-sha256": await hmac(secret, raw, "base64"), "x-shopify-shop-domain": SHOP, "x-shopify-topic": topic } }), env_, c);
  await c.done(); return r;
}
const seedShop = async (e, settings = {}) => { await e.STORE.put(`shop:${SHOP}`, JSON.stringify({ token: await seal(e.ENC_KEY, "shpat_x"), settings: { seller_name: "M GmbH", trigger: "paid", ...settings } })); };
const ORDER = { id: 77, name: "#1002", currency: "EUR", taxes_included: true, financial_status: "paid", total_price: "119.00", tags: "vip", billing_address: { company: "K AG", country_code: "DE" }, line_items: [{ title: "W", quantity: 1, price: "119", total_discount: "0", tax_lines: [{ price: "19", rate: 0.19 }] }], shipping_lines: [], note_attributes: [] };

test("session token verification", async () => {
  assert.equal((await verifySessionToken(await jwt(claims()), "sec", "cid")).shop, SHOP);
  // real Shopify shape: dest has no /admin suffix
  assert.equal((await verifySessionToken(await jwt(claims({ dest: `https://${SHOP}` })), "sec", "cid")).shop, SHOP);
  assert.equal((await verifySessionToken(await jwt(claims({ nbf: Date.now() / 1000 + 5 })), "sec", "cid")).shop, SHOP); // clock skew
  assert.equal((await verifySessionToken(await jwt(claims(), "wrong"), "sec", "cid")).reason, "bad_signature");
  assert.equal((await verifySessionToken(await jwt(claims({ aud: "x" })), "sec", "cid")).reason, "aud_mismatch");
  assert.equal((await verifySessionToken(await jwt(claims({ exp: 1 })), "sec", "cid")).reason, "expired");
  assert.equal((await verifySessionToken(await jwt(claims({ dest: "https://evil.com" })), "sec", "cid")).reason, "dest_not_myshopify");
  assert.equal((await verifySessionToken("", "sec", "cid")).reason, "missing");
});
test("seal/unseal roundtrip (incl. large payloads)", async () => { assert.equal(await unseal("k", await seal("k", "hello")), "hello"); const big = "x".repeat(500000); assert.equal(await unseal("k", await seal("k", big)), big); });
test("webhook rejects bad hmac", async () => {
  const r = await wh(env(), "/webhooks/orders-paid", ORDER, "orders/paid", "wrong"); assert.equal(r.status, 401);
});
test("orders/paid creates and stores a valid invoice, tags order, download works", async () => {
  const e = env(); await seedShop(e); const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => { calls.push([String(u), i]); if (String(u).includes("api.test")) return new Response(JSON.stringify({ valid: true, xml: "<Invoice/>", errors: [], totals: { total_with_vat: 119 } })); return new Response("{}"); };
  try { assert.equal((await wh(e, "/webhooks/orders-paid", ORDER, "orders/paid")).status, 200); } finally { globalThis.fetch = orig; }
  const rec = await e.STORE.get(`inv:${SHOP}:77`, "json"); assert.equal(rec.valid, true); assert.equal(rec.number, "1002");
  const put = calls.find(([u, i]) => u.includes("graphql.json") && i && /orderUpdate/.test(i.body)); const sent = JSON.parse(put[1].body).variables.input;
  assert.equal(sent.id, "gid://shopify/Order/77"); assert.ok(sent.tags.includes("vip") && sent.tags.includes("e-invoice-valid")); assert.match(sent.metafields[0].value, /^https:\/\/app\.example\/d\/demo\.myshopify\.com\/77\?t=/);
  const dl = await app.fetch(new Request(sent.metafields[0].value), e, ctx()); assert.equal(dl.status, 200); assert.equal(await dl.text(), "<Invoice/>");
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
  assert.deepEqual(made, ["ORDERS_CREATE", "APP_UNINSTALLED", "APP_SUBSCRIPTIONS_UPDATE"]);
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

import vm from "node:vm";
import { adminPage } from "../src/admin.js";
test("admin page: every fetch goes through /shopify, save shows success and error toasts, blank key not sent as wipe", async () => {
  const html = adminPage({ apiKey: "cid", shop: SHOP, host: "h", locale: "en", base: "/shopify" });
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  const urls = []; const toasts = []; let failNext = false;
  const els = {}; const el = (id) => (els[id] ||= { style: {}, textContent: "", elements: { order: { value: "1001" } }, set onsubmit(f) { this._s = f; }, get onsubmit() { return this._s; } });
  const form = { elements: {}, _s: null, set onsubmit(f) { this._s = f; }, get onsubmit() { return this._s; } };
  const ctxv = { window: {}, URLSearchParams, JSON, Object, String, Promise, setTimeout, clearTimeout,
    FormData: class { constructor() { return; } [Symbol.iterator]() { return [["api_key", ""], ["seller_name", "X"]][Symbol.iterator](); } },
    document: { getElementById: (id) => (id === "f" ? form : el(id)) },
    shopify: { idToken: async () => "tok", toast: { show: (m, o) => toasts.push([m, !!(o && o.isError)]) } },
    fetch: async (u, o) => { urls.push(u); if (failNext) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (String(u).includes("/api/settings") ? (o && o.method === "POST" ? { ok: true } : { settings: {} }) : { invoices: [] }) }; } };
  vm.createContext(ctxv); vm.runInContext(script, ctxv); await new Promise((r) => setTimeout(r, 20));
  await form.onsubmit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 20));
  assert.ok(urls.length >= 3 && urls.every((u) => u.startsWith("/shopify/api/")), urls.join());
  assert.deepEqual(toasts.at(-1), ["Saved.", false]);
  failNext = true; await form.onsubmit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(toasts.at(-1)[1], true); assert.match(toasts.at(-1)[0], /Could not save/);
});
test("blank or masked api_key in a save does not wipe the stored key", async () => {
  const e = env(); await seedShop(e, { api_key: await seal(e.ENC_KEY, "realkey") });
  const h = { authorization: "Bearer " + (await jwt(claims())) };
  for (const v of ["", "********", "  "]) await app.fetch(new Request("https://wsystem.dev/shopify/api/settings", { method: "POST", headers: h, body: JSON.stringify({ api_key: v, seller_city: "Bonn" }) }), e, ctx());
  const raw = JSON.parse(await e.STORE.get(`shop:${SHOP}`)); assert.equal(await unseal(e.ENC_KEY, raw.settings.api_key), "realkey"); assert.equal(raw.settings.seller_city, "Bonn");
});

test("settings still work when the token exchange fails", async () => {
  const e = env(); const orig = globalThis.fetch; globalThis.fetch = async () => new Response("{}", { status: 400 });
  try {
    const h = { authorization: "Bearer " + (await jwt(claims())) };
    const r = await app.fetch(new Request("https://wsystem.dev/shopify/api/settings", { method: "POST", headers: h, body: JSON.stringify({ seller_name: "Z GmbH" }) }), e, ctx());
    assert.equal(r.status, 200); const g = await (await app.fetch(new Request("https://wsystem.dev/shopify/api/settings", { headers: h }), e, ctx())).json(); assert.equal(g.settings.seller_name, "Z GmbH");
  } finally { globalThis.fetch = orig; }
});

import { ensureAccess } from "../src/index.js";
const tokRes = (o) => new Response(JSON.stringify({ access_token: "shpat_new", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7776000, ...o }));
test("token exchange asks for an expiring offline token and stores refresh token + expiry", async () => {
  const e = env(); const orig = globalThis.fetch; let body;
  globalThis.fetch = async (u, i) => { if (String(u).includes("oauth/access_token")) { body = JSON.parse(i.body); return tokRes(); } return new Response(JSON.stringify({ data: { webhookSubscriptions: { nodes: [] }, webhookSubscriptionCreate: { userErrors: [] } } })); };
  try {
    const sd = { settings: {}, token: "", refresh: "", exp: 0, rexp: 0 };
    assert.equal(await ensureAccess(e, SHOP, sd, "idtok"), "");
    assert.equal(body.expiring, 1); assert.equal(sd.token, "shpat_new"); assert.equal(sd.refresh, "shprt_new"); assert.ok(sd.exp > Date.now() / 1000);
    const stored = await e.STORE.get(`shop:${SHOP}`); assert.ok(!stored.includes("shpat_new") && !stored.includes("shprt_new"));
  } finally { globalThis.fetch = orig; }
});
test("expired access token is refreshed with the refresh token (webhook path, no session)", async () => {
  const e = env(); const orig = globalThis.fetch; let body;
  globalThis.fetch = async (u, i) => { if (String(u).includes("oauth/access_token")) { body = JSON.parse(i.body); return tokRes({ access_token: "shpat_r2" }); } return new Response(JSON.stringify({ data: { webhookSubscriptions: { nodes: [] }, webhookSubscriptionCreate: { userErrors: [] } } })); };
  try {
    const now = Math.floor(Date.now() / 1000); const sd = { settings: {}, token: "old", refresh: "shprt_old", exp: now - 10, rexp: now + 1000 };
    assert.equal(await ensureAccess(e, SHOP, sd), ""); assert.equal(body.grant_type, "refresh_token"); assert.equal(body.refresh_token, "shprt_old"); assert.equal(sd.token, "shpat_r2");
    const fresh = { settings: {}, token: "ok", refresh: "r", exp: now + 3000, rexp: now + 1000 }; body = null; await ensureAccess(e, SHOP, fresh); assert.equal(body, null); // still valid: no request
  } finally { globalThis.fetch = orig; }
});
const GQL_ORDER = { legacyResourceId: "77", name: "#1002", createdAt: "2026-11-01T10:00:00Z", processedAt: null, displayFinancialStatus: "PAID", taxesIncluded: true, currencyCode: "EUR", presentmentCurrencyCode: "EUR", email: "k@example.com", tags: ["vip"], paymentGatewayNames: ["manual"],
  currentTotalPriceSet: { shopMoney: { amount: "119.00" } }, totalPriceSet: { shopMoney: { amount: "119.00" } }, customAttributes: [{ key: "VAT ID", value: "de 123" }],
  billingAddress: { company: "Kunde AG", firstName: "Eva", lastName: "Kunde", name: "Eva Kunde", address1: "Weg 2", address2: null, city: "Köln", zip: "50667", countryCodeV2: "DE" }, shippingAddress: null,
  lineItems: { nodes: [{ title: "Item", variantTitle: null, sku: "A1", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "119.00" } }, totalDiscountSet: { shopMoney: { amount: "0.00" } }, taxLines: [{ rate: 0.19, priceSet: { shopMoney: { amount: "19.00" } } }] }] }, shippingLines: { nodes: [] } };
test("gqlOrderToRest gives the REST shape the mapper expects", () => { const o = gqlOrderToRest(GQL_ORDER); assert.equal(o.id, 77); assert.equal(o.financial_status, "paid"); assert.equal(o.line_items[0].tax_lines[0].price, "19.00"); assert.equal(o.billing_address.country_code, "DE"); assert.equal(o.note_attributes[0].name, "VAT ID"); assert.equal(o.tags, "vip"); });
test("/api/create: reason codes, regenerates an existing invoice, no 500", async () => {
  const e = env(); const now = Math.floor(Date.now() / 1000);
  await e.STORE.put(`shop:${SHOP}`, JSON.stringify({ token: await seal(e.ENC_KEY, "shpat_x"), refresh: "", exp: now + 3000, rexp: 0, settings: { seller_name: "M GmbH" } }));
  const h = { authorization: "Bearer " + (await jwt(claims())), "content-type": "application/json" };
  const call = async (order) => (await app.fetch(new Request("https://wsystem.dev/shopify/api/create", { method: "POST", headers: h, body: JSON.stringify({ order }) }), e, ctx())).json();
  const orig = globalThis.fetch; let shopifyStatus = 200;
  globalThis.fetch = async (u, i) => { u = String(u);
    if (u.includes("graphql.json")) { if (shopifyStatus !== 200) return new Response("{}", { status: shopifyStatus }); const q = JSON.parse(i.body); return new Response(JSON.stringify({ data: { orders: { nodes: q.variables && q.variables.q === "name:#1002" ? [GQL_ORDER] : [] } } })); }
    if (u.includes("api.wsystem") || u.includes("api.test")) return new Response(JSON.stringify({ valid: true, xml: "<I/>", errors: [] }));
    return new Response("{}"); };
  try {
    assert.equal((await call("abc")).reason, "bad_order");
    assert.equal((await call("9999")).reason, "order_not_found");
    const first = await call("#1002"); assert.equal(first.ok, true); assert.equal(first.regenerated, false);
    const again = await call("1002"); assert.equal(again.ok, true); assert.equal(again.regenerated, true);
    shopifyStatus = 403; const bad = await call("1002"); assert.equal(bad.reason, "shopify_error"); assert.match(bad.error, /403/);
  } finally { globalThis.fetch = orig; }
});

test("regeneration is idempotent: one KV record and one list row; list is no-store and fresh", async () => {
  const e = env(); const orig = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify({ valid: true, xml: "<I/>", errors: [] }));
  try {
    const sd = { settings: { seller_name: "M" }, token: "" };
    await generate(e, SHOP, ORDER, sd, { force: true }); await generate(e, SHOP, ORDER, sd, { force: true });
    assert.equal([...e.STORE.m.keys()].filter((k) => k.startsWith("inv:")).length, 1);
    const h = { authorization: "Bearer " + (await jwt(claims())) };
    const r = await app.fetch(new Request("https://wsystem.dev/shopify/api/invoices", { headers: h }), e, ctx());
    assert.equal(r.headers.get("cache-control"), "no-store"); const j = await r.json(); assert.equal(j.invoices.length, 1); assert.equal(j.invoices[0].order, "1002");
    assert.ok([...e.STORE.m.keys()].some((k) => k.startsWith(`aud:${SHOP}:`)));
  } finally { globalThis.fetch = orig; }
});
test("customers/data_request exports the requested invoice records; redact and shop/redact clear index, export and access log", async () => {
  const e = env(); await seedShop(e); const sd = { settings: { seller_name: "M" }, token: "" }; const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ valid: true, xml: "<I/>", errors: [] }));
  try { await generate(e, SHOP, ORDER, sd, { force: true }); } finally { globalThis.fetch = orig; }
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP, data_request: { id: 9 }, orders_requested: [77] }, "customers/data_request");
  const dsr = JSON.parse(await e.STORE.get(`dsr:${SHOP}:9`)); assert.equal(dsr.records.length, 1); assert.equal(dsr.records[0].xml, "<I/>");
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP, orders_to_redact: [77] }, "customers/redact");
  assert.equal(JSON.parse(await e.STORE.get(`idx:${SHOP}`)).length, 0);
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP }, "shop/redact"); assert.equal(e.STORE.m.size, 0);
});
test("billing: managed plans, hosted pricing page url, plan matching by name or handle", async () => {
  const e = env(); await seedShop(e, {}); const h = { authorization: "Bearer " + await jwt(claims()) };
  const call = async (path, body) => (await app.fetch(new Request("https://wsystem.dev/shopify" + path, { method: body ? "POST" : "GET", headers: h, body: body && JSON.stringify(body) }), e, ctx())).json();
  const b = await call("/api/billing"); assert.equal(b.live, true); assert.equal(b.plans.length, 4); assert.equal(b.free_invoices, 50); assert.equal(b.plans.find((p) => p.id === "free").invoices, 50); assert.equal(b.pricing_url, "https://admin.shopify.com/store/demo/charges/w-system-e-invoice/pricing_plans");
  assert.equal((await call("/api/billing/subscribe", {})).url, b.pricing_url);
  const { matchPlan, DEFAULT_PLANS } = await import("../src/index.js");
  for (const [sub, id] of [[{ name: "Shop Plus" }, "shop_plus"], [{ name: "W System Shop Pro" }, "shop_pro"], [{ name: "x", handle: "shop" }, "shop"], [{ name: "Free" }, "free"]]) assert.equal(matchPlan(DEFAULT_PLANS, sub).id, id);
  assert.equal(matchPlan(DEFAULT_PLANS, { name: "Other" }), undefined);
  e.BILLING_PLANS = "[]"; assert.equal((await call("/api/billing")).live, false);
});

test("billing sync: free key on install, upgrade on active subscription, downgrade on cancel, own key kept", async () => {
  const e = env(); e.WSYSTEM_PROVISION_SECRET = "p".repeat(32); await seedShop(e);
  const calls = []; let active = [];
  let have = false;
  const f = async (u, i) => {
    if (String(u).includes("graphql")) return new Response(JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions: active } } }));
    const b = JSON.parse(i.body); calls.push(b); assert.equal(i.headers["x-provision-secret"], "p".repeat(32));
    const existing = have; have = true;
    return new Response(JSON.stringify({ ok: true, plan: b.plan, quota: 1, api_key: existing && !b.rotate ? null : "wsk_live_" + b.plan, existing: existing && !b.rotate }));
  };
  const sd0 = async () => JSON.parse(await e.STORE.get(`shop:${SHOP}`)); const { syncBilling } = await import("../src/index.js");
  let r = await syncBilling(e, SHOP, await getSd(e), { f }); assert.equal(r.plan, "shop_free");
  assert.equal(calls[0].plan, "shop_free"); assert.equal(await unseal(e.ENC_KEY, (await sd0()).settings.api_key), "wsk_live_shop_free");
  active = [{ id: "gid://1", name: "Shop Plus", status: "ACTIVE" }];
  r = await syncBilling(e, SHOP, await getSd(e), { f }); assert.equal(r.plan, "shop_plus"); assert.equal(calls.at(-1).subscription_id, "gid://1"); assert.equal(r.current.name, "Shop Plus"); assert.equal(r.current.invoices, 750);
  active = []; r = await syncBilling(e, SHOP, await getSd(e), { f }); assert.equal(r.plan, "shop_free");
  // merchant with an own key and no subscription: nothing provisioned
  const e2 = env(); e2.WSYSTEM_PROVISION_SECRET = "p".repeat(32); await seedShop(e2, { api_key: "own" }); calls.length = 0;
  r = await syncBilling(e2, SHOP, await getSd(e2), { f }); assert.equal(r.plan, "own_key"); assert.equal(calls.length, 0);
  // no secret configured: off
  assert.equal((await syncBilling(env(), SHOP, { token: "x", settings: {} }, { f })).reason, "provisioning_off");
});
async function getSd(e) { const sd = JSON.parse(await e.STORE.get(`shop:${SHOP}`)); sd.token = "shpat_x"; return sd; }


test("nightly backup: sealed per-shop bundle in the backup store, restorable, deleted on shop/redact", async () => {
  const { backupAll } = await import("../src/index.js");
  const e = env(); e.BACKUP = new KV(); e.BACKUP_KEY = "b".repeat(40);
  await seedShop(e, { api_key: "k" }); await e.STORE.put(`inv:${SHOP}:77`, JSON.stringify({ number: "INV-1", xml: "<x/>" }));
  await e.STORE.put("inv:other.myshopify.com:1", "{}");
  assert.equal((await backupAll(e)).shops, 2);
  const k = `bk:${SHOP}:${new Date().toISOString().slice(0, 10)}`; const raw = await e.BACKUP.get(k);
  assert.ok(raw && !raw.includes("INV-1") && !raw.includes("<x/>"));
  const b = JSON.parse(await unseal(e.BACKUP_KEY, raw)); assert.equal(b.shop, SHOP); assert.ok(b.items[`inv:${SHOP}:77`].includes("INV-1"));
  assert.equal(b.items["inv:other.myshopify.com:1"], undefined);
  assert.equal((await backupAll({ STORE: e.STORE })).reason, "backup_not_configured");
  await wh(e, "/webhooks/compliance", { shop_domain: SHOP }, "shop/redact");
  assert.equal(await e.BACKUP.get(k), null); assert.ok(await e.BACKUP.get(`bk:other.myshopify.com:${new Date().toISOString().slice(0, 10)}`));
});

test("failed regeneration keeps the earlier valid invoice and tag, stores lastError, shows notice data", async () => {
  const e = env(); await seedShop(e); const orig = globalThis.fetch; const gql = [];
  globalThis.fetch = async (u, i) => { if (String(u).includes("graphql.json")) { gql.push(i.body); return new Response(JSON.stringify({ data: {} })); } return new Response("{}"); };
  const ok = async () => new Response(JSON.stringify({ valid: true, xml: "<Invoice/>", errors: [], totals: { total_with_vat: 119 } }));
  const quota = async () => new Response(JSON.stringify({ error: "monthly_quota_exhausted" }), { status: 429 });
  try {
    const sd = { settings: { seller_name: "M GmbH", api_key: "k" }, token: "shpat_x" };
    await generate(e, SHOP, ORDER, sd, { force: true, f: ok });
    const tagCalls = gql.length;
    const r = await generate(e, SHOP, ORDER, sd, { force: true, f: quota });
    assert.equal(r.valid, true); assert.equal(r.xml, "<Invoice/>"); assert.match(r.lastError.message, /quota/); assert.ok(r.lastAttemptAt);
    const rec = await e.STORE.get(`inv:${SHOP}:77`, "json"); assert.equal(rec.valid, true); assert.equal(rec.xml, "<Invoice/>"); assert.match(rec.lastError.message, /quota/);
    assert.equal(gql.length, tagCalls); assert.ok(!gql.some((b) => b.includes("e-invoice-failed")));
    const idx = await e.STORE.get(`idx:${SHOP}`, "json"); assert.equal(idx[0].valid, true); assert.ok(idx[0].lastError);
    const h = { authorization: "Bearer " + (await jwt(claims())) };
    const list = await (await app.fetch(new Request("https://wsystem.dev/shopify/api/invoices", { headers: h }), e, ctx())).json(); assert.ok(list.invoices[0].lastError); assert.equal(list.invoices[0].valid, true);
    await generate(e, SHOP, ORDER, sd, { force: true, f: ok });
    const clean = await e.STORE.get(`inv:${SHOP}:77`, "json"); assert.equal(clean.lastError, undefined);
    // no earlier valid invoice: the failure is still recorded as a failed invoice and tagged
    await e.STORE.delete(`inv:${SHOP}:77`);
    const f = await generate(e, SHOP, ORDER, sd, { force: true, f: quota }); assert.equal(f.valid, false); assert.ok(gql.some((b) => b.includes("e-invoice-failed")));
  } finally { globalThis.fetch = orig; }
});

// ---- B253: ZUGFeRD + credit notes, per-shop opt-in ----
const REFUND = { id: 555000111, order_id: 77, created_at: "2026-11-22T09:00:00Z", refund_line_items: [{ line_item_id: 5, quantity: 1, subtotal: 119, total_tax: 19 }], order_adjustments: [] };
const ORDER_ID = { ...ORDER, line_items: [{ id: 5, title: "W", quantity: 1, price: "119", total_discount: "0", tax_lines: [{ price: "19", rate: 0.19 }] }] };
const apiOk = (extra = {}) => async (u, i) => String(u).includes("api.test") ? new Response(JSON.stringify({ valid: true, xml: "<CreditNote/>", errors: [], ...extra })) : new Response(JSON.stringify({ data: {} }));

test("zugferd off (default): create sends the shop's format and stores no pdf", async () => {
  const e = env(); await seedShop(e); let sent;
  const f = async (u, i) => { sent = JSON.parse(i.body); return apiOk({ pdf_base64: "JVBERi0x" })(u, i); };
  const rec = await generate(e, SHOP, ORDER_ID, JSON.parse(await e.STORE.get(`shop:${SHOP}`)).settings ? { settings: { trigger: "paid" } } : null, { f });
  assert.equal(sent.format, "xrechnung"); assert.equal(rec.pdf, undefined);
});
test("zugferd on: format zugferd, pdf stored and downloadable with ?f=pdf", async () => {
  const e = env(); await seedShop(e, { zugferd: "yes" }); let sent; const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes("api.test")) sent = JSON.parse(i.body); return apiOk({ xml: "<rsm:CrossIndustryInvoice/>", pdf_base64: btoa("%PDF-1.7 x"), embedded_file: "factur-x.xml" })(u, i); };
  try { assert.equal((await wh(e, "/webhooks/orders-paid", ORDER_ID, "orders/paid")).status, 200); } finally { globalThis.fetch = orig; }
  assert.equal(sent.format, "zugferd");
  const rec = await e.STORE.get(`inv:${SHOP}:77`, "json"); assert.equal(rec.valid, true); assert.ok(rec.pdf);
  const t = (await hmac(e.ENC_KEY, `dl|${SHOP}|77`)).slice(0, 32);
  const dl = await app.fetch(new Request(`https://app.example/d/${SHOP}/77?t=${t}&f=pdf`), e, ctx());
  assert.equal(dl.status, 200); assert.equal(dl.headers.get("content-type"), "application/pdf"); assert.equal(await dl.text(), "%PDF-1.7 x");
  const xml = await app.fetch(new Request(`https://app.example/d/${SHOP}/77?t=${t}`), e, ctx()); assert.match(xml.headers.get("content-type"), /xml/);
});
test("settings POST coerces zugferd / credit_notes to yes|no", async () => {
  const e = env(); await seedShop(e);
  const post = async (d) => app.fetch(new Request("https://app.example/api/settings", { method: "POST", body: JSON.stringify(d), headers: { authorization: "Bearer " + await jwt(claims()), "content-type": "application/json" } }), e, ctx());
  assert.equal((await post({ zugferd: "maybe", credit_notes: "yes" })).status, 200);
  const sd = JSON.parse(await e.STORE.get(`shop:${SHOP}`)); // sealed? settings may be sealed: read through the API instead
  const g = await app.fetch(new Request("https://app.example/api/settings", { headers: { authorization: "Bearer " + await jwt(claims()) } }), e, ctx());
  const s = (await g.json()).settings; assert.equal(s.zugferd, "no"); assert.equal(s.credit_notes, "yes"); void sd;
});
test("refunds/create: ignored while credit_notes is off (default): no API call, no record", async () => {
  const e = env(); await seedShop(e); await e.STORE.put(`inv:${SHOP}:77`, JSON.stringify({ valid: true, number: "1002", xml: "<Invoice/>", created: "2026-11-20T10:00:00Z" })); const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => { calls.push(String(u)); return apiOk()(u, i); };
  try { assert.equal((await wh(e, "/webhooks/refunds-create", REFUND, "refunds/create")).status, 200); } finally { globalThis.fetch = orig; }
  assert.equal(calls.length, 0); assert.equal(await e.STORE.get(`inv:${SHOP}:cn-${REFUND.id}`), null);
});
test("refunds/create with credit_notes on: credit note 381 referencing the original, stored, idempotent, downloadable", async () => {
  const e = env(); await seedShop(e, { credit_notes: "yes", zugferd: "yes" });
  await e.STORE.put(`inv:${SHOP}:77`, JSON.stringify({ valid: true, number: "1002", xml: "<Invoice/>", created: "2026-11-20T10:00:00Z" }));
  const sent = []; const orig = globalThis.fetch;
  const GQ = { ...GQL_ORDER, lineItems: { nodes: [{ id: "gid://shopify/LineItem/5", title: "W", variantTitle: "", sku: "", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "119" } }, totalDiscountSet: { shopMoney: { amount: "0" } }, taxLines: [{ rate: 0.19, priceSet: { shopMoney: { amount: "19" } } }] }] } };
  globalThis.fetch = async (u, i) => {
    if (String(u).includes("api.test")) { sent.push(JSON.parse(i.body)); return apiOk({ xml: "<rsm:CrossIndustryInvoice/>", pdf_base64: btoa("%PDF cn") })(u, i); }
    if (String(u).includes("graphql.json")) return new Response(JSON.stringify({ data: { orders: { nodes: [GQ] } } }));
    return new Response("{}");
  };
  try {
    assert.equal((await wh(e, "/webhooks/refunds-create", REFUND, "refunds/create")).status, 200);
    assert.equal((await wh(e, "/webhooks/refunds-create", REFUND, "refunds/create")).status, 200); // replay
  } finally { globalThis.fetch = orig; }
  assert.equal(sent.length, 1); assert.equal(sent[0].type_code, "381"); assert.equal(sent[0].preceding_invoice, "1002"); assert.equal(sent[0].preceding_invoice_date, "2026-11-20"); assert.equal(sent[0].format, "zugferd");
  assert.equal(sent[0].lines[0].unit_price, 100);
  const rec = await e.STORE.get(`inv:${SHOP}:cn-${REFUND.id}`, "json"); assert.equal(rec.kind, "credit_note"); assert.equal(rec.valid, true); assert.equal(rec.original, "1002"); assert.ok(rec.pdf);
  const t = (await hmac(e.ENC_KEY, `dl|${SHOP}|cn-${REFUND.id}`)).slice(0, 32);
  assert.equal((await app.fetch(new Request(`https://app.example/d/${SHOP}/cn-${REFUND.id}?t=${t}&f=pdf`), e, ctx())).status, 200);
});
test("refunds/create without an original valid e-invoice creates no credit note", async () => {
  const e = env(); await seedShop(e, { credit_notes: "yes" }); const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (u, i) => { calls.push(String(u)); return apiOk()(u, i); };
  try { await wh(e, "/webhooks/refunds-create", REFUND, "refunds/create"); } finally { globalThis.fetch = orig; }
  assert.equal(calls.filter((c) => c.includes("api.test")).length, 0); assert.equal(await e.STORE.get(`inv:${SHOP}:cn-${REFUND.id}`), null);
});

// PC-6: orders with more than 100 line items are fetched page by page
import { allLineItems } from "../src/index.js";
test("PC-6: allLineItems follows the lineItems cursor (250 lines)", async () => {
  const mk = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: `gid://shopify/LineItem/${from + i}`, title: `L${from + i}`, quantity: 1 }));
  const calls = [];
  const gql = async (q, v) => {
    calls.push(v);
    assert.match(q, /lineItems\(first: 100, after: \$after\)/);
    if (v.after === "c100") return { order: { lineItems: { nodes: mk(100, 200), pageInfo: { hasNextPage: true, endCursor: "c200" } } } };
    if (v.after === "c200") return { order: { lineItems: { nodes: mk(200, 250), pageInfo: { hasNextPage: false, endCursor: "c250" } } } };
    throw new Error("unexpected cursor " + v.after);
  };
  const node = { id: "gid://shopify/Order/9", name: "#1009", lineItems: { nodes: mk(0, 100), pageInfo: { hasNextPage: true, endCursor: "c100" } } };
  const full = await allLineItems(gql, node);
  assert.equal(full.lineItems.nodes.length, 250);
  assert.deepEqual(calls.map((c) => c.after), ["c100", "c200"]);
  assert.equal(calls[0].id, "gid://shopify/Order/9");
  assert.equal(gqlOrderToRest(full).line_items.length, 250);
});
test("PC-6: single page needs no extra query", async () => {
  const node = { id: "x", lineItems: { nodes: [{ id: "1" }], pageInfo: { hasNextPage: false } } };
  const full = await allLineItems(async () => { throw new Error("no call expected"); }, node);
  assert.equal(full.lineItems.nodes.length, 1);
});

test("POST /api/settings with invalid JSON returns 400, not 500", async () => {
  const e = env(); await seedShop(e);
  const h = { authorization: "Bearer " + await jwt(claims()), "content-type": "application/json" };
  const r = await app.fetch(new Request("https://app.example/api/settings", { method: "POST", headers: h, body: "{not json" }), e, ctx());
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.reason, "bad_request");
});

test("P2 GraphQL: findOrder query requests discountAllocations; gqlOrderToRest maps them", () => {
  assert.match(LINE_NODE, /discountAllocations/);
  assert.match(LINE_NODE, /allocatedAmountSet/);
  const g = {
    ...GQL_ORDER,
    currentTotalPriceSet: { shopMoney: { amount: "76.60" } }, totalPriceSet: { shopMoney: { amount: "76.60" } },
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/1", title: "A", variantTitle: "", sku: "", quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: "49.90" } }, totalDiscountSet: { shopMoney: { amount: "0.00" } },
        discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "3.30" } } }],
        taxLines: [{ rate: 0.19, priceSet: { shopMoney: { amount: "7.44" } } }] },
      { id: "gid://shopify/LineItem/2", title: "B", variantTitle: "", sku: "", quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: "31.70" } }, totalDiscountSet: { shopMoney: { amount: "0.00" } },
        discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "1.70" } } }],
        taxLines: [{ rate: 0.19, priceSet: { shopMoney: { amount: "4.79" } } }] },
    ] },
    shippingLines: { nodes: [{ title: "DHL", originalPriceSet: { shopMoney: { amount: "5.90" } }, discountedPriceSet: { shopMoney: { amount: "5.90" } },
      discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "2.00" } } }], taxLines: [{ rate: 0.19, priceSet: { shopMoney: { amount: "0.62" } } }] }] },
  };
  const o = gqlOrderToRest(g);
  assert.deepEqual(o.line_items[0].discount_allocations, [{ amount: "3.30" }]);
  assert.equal(o.line_items[0].total_discount, "0.00");
  assert.deepEqual(o.line_items[1].discount_allocations, [{ amount: "1.70" }]);
  assert.deepEqual(o.shipping_lines[0].discount_allocations, [{ amount: "2.00" }]);
});

test("GraphQL findOrder requests order tax sets; gqlOrderToRest maps them and omits missing ones", () => {
  assert.match(ORDER_FIELDS, /currentTotalTaxSet/);
  assert.match(ORDER_FIELDS, /totalTaxSet/);
  const withTax = gqlOrderToRest({
    ...GQL_ORDER,
    currentTotalTaxSet: { shopMoney: { amount: "10.60" } },
    totalTaxSet: { shopMoney: { amount: "0.00" } },
  });
  assert.equal(withTax.current_total_tax, "10.60");
  assert.equal(withTax.total_tax, "0.00");
  const missing = gqlOrderToRest(GQL_ORDER);
  assert.equal(missing.current_total_tax, undefined);
  assert.equal(missing.total_tax, undefined);
});
