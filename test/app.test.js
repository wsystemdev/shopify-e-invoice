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
test("/api/create: reason codes, regenerates an existing invoice, no 500", async () => {
  const e = env(); const now = Math.floor(Date.now() / 1000);
  await e.STORE.put(`shop:${SHOP}`, JSON.stringify({ token: await seal(e.ENC_KEY, "shpat_x"), refresh: "", exp: now + 3000, rexp: 0, settings: { seller_name: "M GmbH" } }));
  const h = { authorization: "Bearer " + (await jwt(claims())), "content-type": "application/json" };
  const call = async (order) => (await app.fetch(new Request("https://wsystem.dev/shopify/api/create", { method: "POST", headers: h, body: JSON.stringify({ order }) }), e, ctx())).json();
  const orig = globalThis.fetch; let shopifyStatus = 200;
  globalThis.fetch = async (u) => { u = String(u);
    if (u.includes("/orders.json")) return shopifyStatus !== 200 ? new Response("{}", { status: shopifyStatus }) : new Response(JSON.stringify({ orders: u.includes("%231002") ? [ORDER] : [] }));
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
