import { buildInvoice, parseResult, isB2B, DEFAULT_SETTINGS, orderNumber } from "./mapper.js";
import { hmac, safeEq, seal, unseal, verifySessionToken } from "./crypto.js";
import { adminPage } from "./admin.js";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const TTL = 60 * 60 * 24 * 400; // invoices expire after about 13 months
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const SECRET_FIELD = "api_key";

// ---------- storage ----------
async function getShop(env, shop) {
  const raw = await env.STORE.get(`shop:${shop}`, "json");
  if (!raw) return null;
  const out = { settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }, token: "", refresh: "", exp: raw.exp || 0, rexp: raw.rexp || 0 };
  if (raw.token) out.token = await unseal(env.ENC_KEY, raw.token);
  if (raw.refresh) out.refresh = await unseal(env.ENC_KEY, raw.refresh);
  if (raw.settings && raw.settings[SECRET_FIELD]) out.settings[SECRET_FIELD] = await unseal(env.ENC_KEY, raw.settings[SECRET_FIELD]);
  return out;
}
async function putShop(env, shop, { token, refresh, exp, rexp, settings }) {
  const s = { ...settings };
  if (s[SECRET_FIELD]) s[SECRET_FIELD] = await seal(env.ENC_KEY, s[SECRET_FIELD]);
  await env.STORE.put(`shop:${shop}`, JSON.stringify({ token: token ? await seal(env.ENC_KEY, token) : "", refresh: refresh ? await seal(env.ENC_KEY, refresh) : "", exp: exp || 0, rexp: rexp || 0, settings: s }));
}
export async function deleteShopData(env, shop) {
  for (const prefix of [`inv:${shop}:`, `dsr:${shop}:`]) {
    let cursor;
    do {
      const l = await env.STORE.list({ prefix, cursor });
      await Promise.all(l.keys.map((k) => env.STORE.delete(k.name)));
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
  }
  await env.STORE.delete(`shop:${shop}`);
}

// ---------- Shopify ----------
async function verifyWebhook(env, req, body) {
  const h = req.headers.get("x-shopify-hmac-sha256") || "";
  return safeEq(await hmac(env.SHOPIFY_API_SECRET, body, "base64"), h);
}
async function verifyQuery(env, url) {
  const p = new URLSearchParams(url.search);
  const given = p.get("hmac") || "";
  p.delete("hmac");
  const msg = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  return safeEq(await hmac(env.SHOPIFY_API_SECRET, msg), given);
}
async function shopifyFetch(env, shop, token, path, init = {}) {
  const r = await fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}${path}`, { ...init, headers: { "X-Shopify-Access-Token": token, "content-type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Shopify ${r.status}`);
  return r.json();
}
// Shopify only accepts expiring offline tokens (1 h) with a refresh token (90 days).
async function tokenRequest(env, shop, params) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, ...params }) });
  if (!r.ok) throw new Error(`token request ${r.status}`);
  const d = await r.json();
  if (!d.access_token) throw new Error("token request: no access_token");
  const now = Math.floor(Date.now() / 1000);
  return { token: d.access_token, refresh: d.refresh_token || "", exp: now + (d.expires_in || 3600), rexp: now + (d.refresh_token_expires_in || 0) };
}
const exchangeToken = (env, shop, idToken) => tokenRequest(env, shop, { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: idToken, subject_token_type: "urn:ietf:params:oauth:token-type:id_token", requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token", expiring: 1 });
const refreshToken = (env, shop, refresh) => tokenRequest(env, shop, { grant_type: "refresh_token", refresh_token: refresh });
// Make sure sd has a usable access token: keep it, else token exchange (when a session token is at hand), else refresh. Returns an error string or "".
export async function ensureAccess(env, shop, sd, idToken) {
  const now = Math.floor(Date.now() / 1000);
  if (sd.token && sd.exp > now + 120) return "";
  let err = "";
  try {
    const n = idToken ? await exchangeToken(env, shop, idToken) : sd.refresh && sd.rexp > now ? await refreshToken(env, shop, sd.refresh) : null;
    if (!n) return sd.token ? "token expired" : "no token";
    Object.assign(sd, n); await putShop(env, shop, sd);
    try { await ensureWebhooks(env, shop, sd.token); } catch (e) { /* retried on the next settings save */ }
  } catch (e) {
    err = String(e.message || e).slice(0, 80); console.log("token error:", err);
    if (idToken && sd.refresh && sd.rexp > now) { try { Object.assign(sd, await refreshToken(env, shop, sd.refresh)); await putShop(env, shop, sd); return ""; } catch (e2) { err += "; refresh " + String(e2.message).slice(0, 40); } }
    sd.token = "";
  }
  return err;
}
const WEBHOOKS = [["ORDERS_CREATE", "/webhooks/orders-create"], ["ORDERS_PAID", "/webhooks/orders-paid"], ["APP_UNINSTALLED", "/webhooks/app-uninstalled"]];
// Register the order webhooks through the Admin GraphQL API (idempotent: lists existing subscriptions first).
export async function ensureWebhooks(env, shop, token, f = fetch) {
  const gql = async (query, variables) => {
    const r = await f(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error(`graphql ${r.status}`);
    return r.json();
  };
  const have = await gql("{ webhookSubscriptions(first: 50) { nodes { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }");
  const urls = new Set(((have.data && have.data.webhookSubscriptions.nodes) || []).map((n) => `${n.topic}|${n.endpoint && n.endpoint.callbackUrl}`));
  const created = [];
  for (const [topic, path] of WEBHOOKS) {
    const callbackUrl = env.APP_URL + path;
    if (urls.has(`${topic}|${callbackUrl}`)) continue;
    const r = await gql("mutation($t: WebhookSubscriptionTopic!, $s: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $t, webhookSubscription: $s) { userErrors { message } } }", { t: topic, s: { callbackUrl, format: "JSON" } });
    const errs = r.data && r.data.webhookSubscriptionCreate.userErrors;
    if (!errs || !errs.length) created.push(topic);
  }
  return created;
}
// Fallback for shops owned by our own organisation (dev store): client credentials grant, 24 h token, never stored.
async function clientCredentialsToken(env, shop) {
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, grant_type: "client_credentials" }) });
    return r.ok ? (await r.json()).access_token || "" : "";
  } catch (e) { return ""; }
}
const dlUrl = async (env, shop, id) => `${env.APP_URL}/d/${shop}/${id}?t=${(await hmac(env.ENC_KEY, `dl|${shop}|${id}`)).slice(0, 32)}`;

// ---------- invoice lifecycle ----------
export async function generate(env, shop, order, shopData, { force = false, f = fetch } = {}) {
  const key = `inv:${shop}:${order.id}`;
  if (!force && (await env.STORE.get(key))) return { skipped: "exists" };
  const s = shopData.settings;
  const body = buildInvoice(order, s);
  const headers = { "content-type": "application/json", "user-agent": "w-system-e-invoice-shopify/1.0" };
  if (s.api_key) headers["x-api-key"] = s.api_key;
  let res, data;
  try {
    res = await f(`${env.API_BASE || "https://api.wsystem.dev"}/einvoice/create`, { method: "POST", headers, body: JSON.stringify(body) });
    data = await res.json();
  } catch (e) { data = null; }
  let rec;
  if (!res || !res.ok || !data) {
    const msg = data && (data.detail || data.error) ? JSON.stringify(data.detail || data.error).slice(0, 300) : `API error ${res ? res.status : "unreachable"}`;
    rec = { order: orderNumber(order), number: body.invoice_number, valid: false, xml: "", errors: [{ rule_id: "API", message: msg, fix: "" }], created: new Date().toISOString() };
  } else {
    const p = parseResult(data, order.current_total_price ?? order.total_price);
    rec = { order: orderNumber(order), number: body.invoice_number, format: body.format, valid: p.valid, xml: p.valid ? p.xml : "", errors: p.errors, mismatch: p.mismatch, created: new Date().toISOString() };
  }
  await env.STORE.put(key, JSON.stringify(rec), { expirationTtl: TTL, metadata: { order: rec.order, number: rec.number, valid: rec.valid, created: rec.created } });
  // tag + metafield on the order (needs an access token)
  const tagToken = shopData.token || (f === fetch ? await clientCredentialsToken(env, shop) : "");
  if (tagToken) {
    try {
      const tags = String(order.tags || "").split(",").map((x) => x.trim()).filter((x) => x && !/^e-invoice-/.test(x));
      tags.push(rec.valid ? "e-invoice-valid" : "e-invoice-failed");
      const o = { id: order.id, tags: tags.join(", ") };
      if (rec.valid) o.metafields = [{ namespace: "wsystem", key: "einvoice_url", type: "url", value: await dlUrl(env, shop, order.id) }];
      await shopifyFetch(env, shop, tagToken, `/orders/${order.id}.json`, { method: "PUT", body: JSON.stringify({ order: o }) });
    } catch (e) { /* tagging is best effort */ }
  }
  if (rec.valid && s.email_copy === "yes" && env.EMAIL_COPY_ENABLED === "1" && env.RESEND_API_KEY && s.seller_email) {
    try {
      await f("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "W System <hello@wsystem.dev>", to: [s.seller_email], subject: `E-invoice ${rec.number} (${shop})`, text: `The e-invoice for order ${rec.order} passed validation. The XML is attached.`,
          attachments: [{ filename: `${rec.number}.xml`, content: btoa(unescape(encodeURIComponent(rec.xml))) }] }) });
    } catch (e) { /* ignore */ }
  }
  return rec;
}

async function onOrderWebhook(env, req, body, topic) {
  const shop = (req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
  if (!SHOP_RE.test(shop)) return;
  const sd = await getShop(env, shop);
  if (!sd) return;
  const trig = sd.settings.trigger;
  if (trig === "off" || (topic === "create" && trig !== "created") || (topic === "paid" && trig !== "paid")) return;
  await ensureAccess(env, shop, sd);
  const order = JSON.parse(body);
  if (sd.settings.only_b2b === "yes" && !isB2B(order, sd.settings)) return;
  await generate(env, shop, order, sd);
}

async function onCompliance(env, body) {
  const p = JSON.parse(body);
  const shop = String(p.shop_domain || "").toLowerCase();
  if (!SHOP_RE.test(shop)) return;
  const topic = p.__topic;
  if (topic === "shop/redact") return deleteShopData(env, shop);
  if (topic === "customers/redact") {
    for (const id of p.orders_to_redact || []) await env.STORE.delete(`inv:${shop}:${id}`);
    return;
  }
  if (topic === "customers/data_request") {
    // Invoices are stored per order and visible to the merchant in the app; record the request so the merchant can fulfil it.
    await env.STORE.put(`dsr:${shop}:${p.data_request && p.data_request.id || Date.now()}`, JSON.stringify({ orders: p.orders_requested || [], at: new Date().toISOString() }), { expirationTtl: TTL });
  }
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Route pattern is wsystem.dev/shopify* (a bare pattern ignores URLs with a query string), so other pages that
    // start with "shopify" (e.g. /shopify-xrechnung) are passed through to the site untouched.
    if (/^\/shopify[^/]/.test(url.pathname)) return fetch(req);
    let path = url.pathname.replace(/^\/shopify(?=\/|$)/, "") || "/"; // served under wsystem.dev/shopify/*
    if (path === "/" && url.searchParams.get("shop")) path = "/app"; // Shopify opens the app URL itself
    try {
      if (path === "/" || path === "/health") return json({ ok: true, app: "w-system-e-invoice-shopify" });

      if (req.method === "POST" && path.startsWith("/webhooks/")) {
        const body = await req.text();
        if (!(await verifyWebhook(env, req, body))) return new Response("invalid hmac", { status: 401 });
        const topicHdr = (req.headers.get("x-shopify-topic") || "").toLowerCase();
        if (path === "/webhooks/orders-create") ctx.waitUntil(onOrderWebhook(env, req, body, "create"));
        else if (path === "/webhooks/orders-paid") ctx.waitUntil(onOrderWebhook(env, req, body, "paid"));
        else if (path === "/webhooks/app-uninstalled") {
          const shop = (req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
          if (SHOP_RE.test(shop)) { const sd = await getShop(env, shop); if (sd) await putShop(env, shop, { settings: sd.settings }); }
        } else if (path === "/webhooks/compliance") {
          const p = JSON.parse(body); p.__topic = topicHdr; ctx.waitUntil(onCompliance(env, JSON.stringify(p)));
        } else return new Response("not found", { status: 404 });
        return new Response("ok", { status: 200 });
      }

      if (path === "/app" || path === "/app/") {
        const shop = (url.searchParams.get("shop") || "").toLowerCase();
        if (!SHOP_RE.test(shop) || !(await verifyQuery(env, url))) return new Response("Open this app from your Shopify admin.", { status: 400 });
        return new Response(adminPage({ apiKey: env.SHOPIFY_API_KEY, shop, host: url.searchParams.get("host"), locale: url.searchParams.get("locale"), base: "/shopify" }), {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "frame-ancestors https://*.myshopify.com https://admin.shopify.com", "cache-control": "no-store" } });
      }

      if (path.startsWith("/d/")) {
        const [, , shop, id] = path.split("/");
        const t = url.searchParams.get("t") || "";
        if (!SHOP_RE.test(shop || "") || !/^\d+$/.test(id || "") || !safeEq((await hmac(env.ENC_KEY, `dl|${shop}|${id}`)).slice(0, 32), t)) return new Response("not found", { status: 404 });
        const rec = await env.STORE.get(`inv:${shop}:${id}`, "json");
        if (!rec || !rec.valid || !rec.xml) return new Response("not found", { status: 404 });
        return new Response(rec.xml, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${String(rec.number).replace(/[^\w.-]/g, "_")}.xml"`, "cache-control": "no-store" } });
      }

      if (path.startsWith("/api/")) {
        const bearer = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
        const sess = await verifySessionToken(bearer, env.SHOPIFY_API_SECRET, env.SHOPIFY_API_KEY);
        if (!sess.shop) { console.log("session token rejected:", sess.reason, "path", path); return json({ error: "unauthorized", reason: sess.reason }, 401); }
        const shop = sess.shop;
        let sd = await getShop(env, shop);
        if (!sd) { sd = { settings: { ...DEFAULT_SETTINGS }, token: "", refresh: "", exp: 0, rexp: 0 }; await putShop(env, shop, sd); }
        // The session token already proves the request comes from the shop's admin; the access token is only needed to call Shopify.
        const tokenError = await ensureAccess(env, shop, sd, bearer);
        if (path === "/api/settings" && req.method === "GET") {
          const s = { ...sd.settings }; if (s.api_key) s.api_key = "********";
          return json({ settings: s });
        }
        if (path === "/api/settings" && req.method === "POST") {
          const d = await req.json(); const s = { ...sd.settings };
          for (const k of Object.keys(DEFAULT_SETTINGS)) {
            if (typeof d[k] !== "string") continue;
            if (k === "api_key" && (d[k] === "********" || d[k].trim() === "")) continue; // never wipe a stored key with a blank field
            s[k] = d[k].trim().slice(0, 300);
          }
          if (!["xrechnung", "en16931", "peppol-bis3"].includes(s.format)) s.format = "xrechnung";
          if (!["paid", "created", "off"].includes(s.trigger)) s.trigger = "paid";
          await putShop(env, shop, { ...sd, settings: s });
          let webhooks = [];
          try { webhooks = await ensureWebhooks(env, shop, sd.token); } catch (e) { /* best effort */ }
          return json({ ok: true, webhooks });
        }
        if (path === "/api/invoices") {
          const l = await env.STORE.list({ prefix: `inv:${shop}:`, limit: 200 });
          const invoices = await Promise.all(l.keys.map(async (k) => {
            const m = k.metadata || {}; const id = k.name.split(":")[2];
            const rec = await env.STORE.get(k.name, "json");
            return { order: m.order, number: m.number, valid: m.valid, created: m.created, xml: !!(rec && rec.xml), errors: rec ? rec.errors : [], url: await dlUrl(env, shop, id) };
          }));
          invoices.sort((a, b) => String(b.created).localeCompare(String(a.created)));
          return json({ invoices: invoices.slice(0, 25) });
        }
        if (path === "/api/create" && req.method === "POST") {
          const fail = (reason, message, status = 200, extra = "") => { console.log("create failed:", reason, extra); return json({ ok: false, reason, error: message }, status); };
          let name = "";
          try { name = String((await req.json()).order || "").trim(); } catch (e) { return fail("bad_request", "Send the order number, for example 1006.", 400); }
          const m = /^(?:#|gid:\/\/shopify\/Order\/)?(\d{1,20})$/.exec(name);
          if (!m) return fail("bad_order", "Enter the order number, for example 1006 or #1006.");
          let token = sd.token;
          if (!token) token = await clientCredentialsToken(env, shop);
          if (!token) return fail("no_access_token", `No Shopify access token yet (${tokenError || "reopen the app"}).`);
          let order;
          try {
            let o = await shopifyFetch(env, shop, token, `/orders.json?name=${encodeURIComponent("#" + m[1])}&status=any&limit=1`);
            order = (o.orders || [])[0];
            if (!order && m[1].length > 8) { o = await shopifyFetch(env, shop, token, `/orders/${m[1]}.json`); order = o.order; }
          } catch (e) { return fail("shopify_error", "Shopify did not return the order (" + String(e.message).slice(0, 60) + "). Check the app has order access.", 200, String(e.message).slice(0, 200)); }
          if (!order) return fail("order_not_found", `Order ${m[1]} was not found in this shop.`);
          if (!sd.settings.seller_name) return fail("no_settings", "Save your seller details first.");
          const existing = await env.STORE.get(`inv:${shop}:${order.id}`, "json");
          let rec;
          try { rec = await generate(env, shop, order, { ...sd, token }, { force: true }); } catch (e) { return fail("generate_error", "Could not create the e-invoice.", 200, String(e.message).slice(0, 200)); }
          return json({ ok: true, valid: rec.valid, regenerated: !!existing, errors: rec.errors || [] });
        }
        return json({ error: "not found" }, 404);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log("unhandled:", String(e && e.message || e).slice(0, 300));
      return json({ error: "internal error", reason: "unhandled" }, 500);
    }
  },
};
