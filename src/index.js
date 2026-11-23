import { buildInvoice, buildCreditNote, parseResult, isB2B, DEFAULT_SETTINGS, orderNumber } from "./mapper.js";
import { hmac, safeEq, seal, unseal, verifySessionToken } from "./crypto.js";
import { adminPage } from "./admin.js";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const TTL = 60 * 60 * 24 * 400; // invoices expire after about 13 months
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
// Billing = Shopify App Pricing (managed; plans are created in the Partner Dashboard pricing page, NOT in code; appSubscriptionCreate is not used).
// Plans (USD; each carries a monthly and a yearly price = pay 10 months, get 12). `handle` = the plan handle in the pricing page, `ws` = W System
// plan id (quota in units on the shop's own key). Hosted plan page: https://admin.shopify.com/store/<shop handle>/charges/<APP_HANDLE>/pricing_plans.
// BILLING_PLANS (JSON array) overrides this list; "[]" hides the plan table.
export const DEFAULT_PLANS = [
  { id: "free", handle: "free", ws: "shop_free", name: "Free", invoices: 50, price: "0.00", yearly: "0.00", currency: "USD" },
  { id: "shop", handle: "shop", ws: "shop", name: "Shop", invoices: 150, price: "13.00", yearly: "130.00", currency: "USD" },
  { id: "shop_plus", handle: "shop-plus", ws: "shop_plus", name: "Shop Plus", invoices: 750, price: "32.00", yearly: "320.00", currency: "USD" },
  { id: "shop_pro", handle: "shop-pro", ws: "shop_pro", name: "Shop Pro", invoices: 2000, price: "65.00", yearly: "650.00", currency: "USD" },
];
const slug = (x) => String(x || "").toLowerCase().replace(/^w system\s+/, "").trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const matchPlan = (plans, sub) => plans.find((x) => slug(x.name) === slug(sub.name) || x.handle === slug(sub.name) || (sub.handle && x.handle === sub.handle));
export const pricingUrl = (env, shop) => `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/charges/${env.APP_HANDLE || "w-system-e-invoice"}/pricing_plans`;
const RANK = { shop_free: 0, shop: 1, shop_plus: 2, shop_pro: 3 };
function plansOf(env) { if (env.BILLING_PLANS == null || env.BILLING_PLANS === "") return DEFAULT_PLANS; try { const p = JSON.parse(env.BILLING_PLANS); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
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
  for (const prefix of [`inv:${shop}:`, `dsr:${shop}:`, `aud:${shop}:`]) {
    let cursor;
    do {
      const l = await env.STORE.list({ prefix, cursor });
      await Promise.all(l.keys.map((k) => env.STORE.delete(k.name)));
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
  }
  await env.STORE.delete(`idx:${shop}`);
  await env.STORE.delete(`shop:${shop}`);
  if (env.BACKUP) { // nightly backups of this shop are deleted with the data
    let cursor;
    do { const l = await env.BACKUP.list({ prefix: `bk:${shop}:`, cursor }); await Promise.all(l.keys.map((k) => env.BACKUP.delete(k.name))); cursor = l.list_complete ? undefined : l.cursor; } while (cursor);
  }
}

// Nightly backup (cron): every shop's KV records (settings and access tokens are already sealed; invoice records, index, data-request
// exports, access log) are bundled per shop, encrypted again with a separate key (BACKUP_KEY) and written to a SEPARATE KV namespace
// (BACKUP) with a 30-day expiry. Deleted with the shop on shop/redact (see deleteShopData).
export async function backupAll(env, now = new Date()) {
  if (!env.BACKUP || !env.BACKUP_KEY) return { ok: false, reason: "backup_not_configured" };
  const groups = new Map(); let cursor;
  do {
    const l = await env.STORE.list({ cursor });
    for (const k of l.keys) { const shop = k.name.split(":")[1] || ""; if (!SHOP_RE.test(shop)) continue; if (!groups.has(shop)) groups.set(shop, []); groups.get(shop).push(k.name); }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  const day = now.toISOString().slice(0, 10); let n = 0;
  for (const [shop, names] of groups) {
    const items = {}; for (const name of names) items[name] = await env.STORE.get(name);
    await env.BACKUP.put(`bk:${shop}:${day}`, await seal(env.BACKUP_KEY, JSON.stringify({ shop, day, items })), { expirationTtl: 30 * 86400 });
    n++;
  }
  return { ok: true, shops: n, day };
}

// Per-record access log (who/what touched an invoice), kept 90 days. Never stores the invoice content.
async function audit(env, shop, action, id) {
  try { await env.STORE.put(`aud:${shop}:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({ action, id: String(id || "") }), { expirationTtl: 60 * 60 * 24 * 90 }); } catch (e) { /* best effort */ }
}
// Small consistent index of recent invoices (KV list() is eventually consistent, so the list endpoint reads this instead).
async function idxUpdate(env, shop, id, entry) {
  const key = `idx:${shop}`; const cur = (await env.STORE.get(key, "json")) || [];
  const next = [{ id: String(id), ...entry }, ...cur.filter((x) => x.id !== String(id))].slice(0, 50);
  await env.STORE.put(key, JSON.stringify(next), { expirationTtl: TTL });
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

// Admin GraphQL (REST Admin API is legacy; new public apps must use GraphQL only).
async function shopifyGql(env, shop, token, query, variables) {
  const r = await fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`Shopify ${r.status}`);
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(`Shopify GraphQL: ${String(j.errors[0].message || "error").slice(0, 80)}`);
  return j.data || {};
}
const MONEY = "{ shopMoney { amount } }";
const ADDR = "{ company firstName lastName name address1 address2 city zip countryCodeV2 }";
const TAXL = `taxLines { rate priceSet ${MONEY} }`;
const ORDER_FIELDS = `legacyResourceId name createdAt processedAt displayFinancialStatus taxesIncluded currencyCode presentmentCurrencyCode email tags paymentGatewayNames
  currentTotalPriceSet ${MONEY} totalPriceSet ${MONEY} customAttributes { key value }
  billingAddress ${ADDR} shippingAddress ${ADDR}
  lineItems(first: 100) { nodes { id title variantTitle sku quantity originalUnitPriceSet ${MONEY} totalDiscountSet ${MONEY} ${TAXL} } }
  shippingLines(first: 10) { nodes { title originalPriceSet ${MONEY} discountedPriceSet ${MONEY} ${TAXL} } }`;
// Convert a GraphQL order into the REST-style shape that the mapper (and the webhook payload) use.
export function gqlOrderToRest(o) {
  if (!o) return null;
  const amt = (m) => (m && m.shopMoney ? m.shopMoney.amount : "0");
  const addr = (a) => (a ? { company: a.company || "", first_name: a.firstName || "", last_name: a.lastName || "", name: a.name || "", address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", zip: a.zip || "", country_code: a.countryCodeV2 || "" } : null);
  const tl = (x) => (x.taxLines || []).map((t) => ({ rate: t.rate, price: amt(t.priceSet) }));
  const num = parseInt(String(o.name || "").replace(/\D/g, ""), 10);
  return {
    id: Number(o.legacyResourceId), name: o.name, order_number: Number.isFinite(num) ? num : undefined, created_at: o.createdAt, processed_at: o.processedAt,
    financial_status: String(o.displayFinancialStatus || "").toLowerCase().replace(/ /g, "_"), taxes_included: !!o.taxesIncluded, currency: o.currencyCode, presentment_currency: o.presentmentCurrencyCode,
    email: o.email || "", tags: (o.tags || []).join(", "), payment_gateway_names: o.paymentGatewayNames || [],
    current_total_price: amt(o.currentTotalPriceSet), total_price: amt(o.totalPriceSet),
    note_attributes: (o.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
    billing_address: addr(o.billingAddress), shipping_address: addr(o.shippingAddress),
    line_items: ((o.lineItems && o.lineItems.nodes) || []).map((x) => ({ id: String(x.id || "").split("/").pop(), title: x.title, variant_title: x.variantTitle || "", sku: x.sku || "", quantity: x.quantity, price: amt(x.originalUnitPriceSet), total_discount: amt(x.totalDiscountSet), tax_lines: tl(x) })),
    shipping_lines: ((o.shippingLines && o.shippingLines.nodes) || []).map((x) => ({ title: x.title, price: amt(x.originalPriceSet), discounted_price: amt(x.discountedPriceSet), tax_lines: tl(x) })),
  };
}
async function findOrder(env, shop, token, digits) {
  const d = await shopifyGql(env, shop, token, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${digits}` });
  let node = ((d.orders && d.orders.nodes) || [])[0];
  if (!node && digits.length > 8) { const g = await shopifyGql(env, shop, token, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: `gid://shopify/Order/${digits}` }); node = g.order; }
  return gqlOrderToRest(node);
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
const WEBHOOKS = [["ORDERS_CREATE", "/webhooks/orders-create"], ["ORDERS_PAID", "/webhooks/orders-paid"], ["APP_UNINSTALLED", "/webhooks/app-uninstalled"], ["APP_SUBSCRIPTIONS_UPDATE", "/webhooks/app-subscriptions"]];
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
// Billing -> W System key. Reads the shop's ACTIVE app subscriptions from Shopify (source of truth), maps the highest one to a W System
// shop plan (none = shop_free) and asks the W System API to create or change this shop's key. The key lands in the shop settings
// (api_key, flagged api_key_managed) so the merchant never copies a key. A key the merchant typed in is kept unless they subscribe.
export async function syncBilling(env, shop, sd, { f = fetch } = {}) {
  if (!env.WSYSTEM_PROVISION_SECRET) return { ok: false, reason: "provisioning_off" };
  if (!sd.token) return { ok: false, reason: "no_access_token" };
  let subs = [];
  try {
    const r = await f(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": sd.token, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ currentAppInstallation { activeSubscriptions { id name status } } }" }) });
    const d = await r.json();
    if (!d.data || !d.data.currentAppInstallation) return { ok: false, reason: "shopify_error" };
    subs = d.data.currentAppInstallation.activeSubscriptions || [];
  } catch (e) { return { ok: false, reason: "shopify_error" }; }
  const plans = plansOf(env); let ws = "shop_free", subId = "", cur = null;
  for (const sub of subs) {
    if (sub.status && sub.status !== "ACTIVE") continue;
    const pl = matchPlan(plans, sub);
    if (pl && (RANK[pl.ws] || 0) >= (RANK[ws] || 0) && pl.ws) { ws = pl.ws; subId = sub.id; cur = pl; }
  }
  const s = sd.settings; const paid = ws !== "shop_free";
  if (!paid && s.api_key && !s.api_key_managed) return { ok: true, plan: "own_key", paid: false, current: { id: "own_key", name: "Own W System key", invoices: null } }; // merchant uses their own key: nothing to provision
  const call = (rotate) => f(`${env.API_BASE || "https://api.wsystem.dev"}/billing/shopify/provision`, { method: "POST", headers: { "content-type": "application/json", "x-provision-secret": env.WSYSTEM_PROVISION_SECRET, "user-agent": "w-system-e-invoice-shopify/1.0" },
    body: JSON.stringify({ shop, plan: ws, subscription_id: subId, rotate }) });
  let r;
  try { r = await call(false); } catch (e) { return { ok: false, reason: "api_unreachable" }; }
  let j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) return { ok: false, reason: "provision_failed", status: r.status };
  if (j.existing && !s.api_key_managed) { // the key exists on our side but this shop has no copy of it: rotate to get a fresh one
    try { r = await call(true); j = await r.json().catch(() => ({})); } catch (e) { return { ok: false, reason: "api_unreachable" }; }
    if (!r.ok || !j.ok) return { ok: false, reason: "provision_failed", status: r.status };
  }
  if (j.api_key && (paid || !s.api_key || s.api_key_managed)) { s.api_key = j.api_key; s.api_key_managed = "1"; await putShop(env, shop, { ...sd, settings: s }); }
  return { ok: true, plan: ws, paid, quota: j.quota, current: cur ? { id: cur.id, ws: cur.ws, name: cur.name, invoices: cur.invoices } : { id: "shop_free", ws: "shop_free", name: "Free", invoices: 25, interval: "" } };
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
    if (p.valid && body.format === "zugferd" && data.pdf_base64) rec.pdf = data.pdf_base64; // B253: ZUGFeRD / Factur-X PDF (only when the shop turned it on)
  }
  // A failed attempt never replaces an earlier valid invoice (or its tag): the failure is stored next to it.
  let kept = false;
  if (!rec.valid) {
    const prev = await env.STORE.get(key, "json");
    if (prev && prev.valid && prev.xml) {
      const err = (rec.errors && rec.errors[0]) || { rule_id: "API", message: "failed" };
      rec = { ...prev, lastError: { rule_id: err.rule_id, message: String(err.message || "").slice(0, 300), fix: err.fix || "" }, lastAttemptAt: new Date().toISOString() }; kept = true;
    }
  }
  await env.STORE.put(key, JSON.stringify(rec), { expirationTtl: TTL, metadata: { order: rec.order, number: rec.number, valid: rec.valid, created: rec.created } });
  await idxUpdate(env, shop, order.id, { order: rec.order, number: rec.number, valid: rec.valid, created: rec.created, xml: !!rec.xml, errors: (rec.errors || []).slice(0, 2), ...(kept ? { lastError: rec.lastError, lastAttemptAt: rec.lastAttemptAt } : {}) });
  await audit(env, shop, "generate", order.id);
  // tag + metafield on the order (needs an access token)
  const tagToken = shopData.token;
  if (tagToken && !kept) {
    try {
      const tags = String(order.tags || "").split(",").map((x) => x.trim()).filter((x) => x && !/^e-invoice-/.test(x));
      tags.push(rec.valid ? "e-invoice-valid" : "e-invoice-failed");
      const input = { id: `gid://shopify/Order/${order.id}`, tags };
      if (rec.valid) input.metafields = [{ namespace: "wsystem", key: "einvoice_url", type: "url", value: await dlUrl(env, shop, order.id) }];
      await shopifyGql(env, shop, tagToken, "mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { message } } }", { input });
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

// B253: credit note for a refund. Does nothing unless the shop turned "credit_notes" on, and only for orders that already have a valid e-invoice.
export async function createCreditNote(env, shop, sd, refund, order, { f = fetch } = {}) {
  const key = `inv:${shop}:cn-${refund.id}`;
  if (await env.STORE.get(key)) return { skipped: "exists" };
  const orig = await env.STORE.get(`inv:${shop}:${order.id}`, "json");
  if (!orig || !orig.valid) return { skipped: "no_original_invoice" };
  const s = sd.settings;
  const body = buildCreditNote(order, refund, s, { precedingNumber: orig.number, precedingDate: String(orig.created || "").slice(0, 10) || undefined });
  if (!body.lines.length) return { skipped: "no_lines" };
  if (s.zugferd === "yes" && s.format !== "peppol-bis3") body.format = "zugferd";
  const headers = { "content-type": "application/json", "user-agent": "w-system-e-invoice-shopify/1.0" };
  if (s.api_key) headers["x-api-key"] = s.api_key;
  let res, data;
  try { res = await f(`${env.API_BASE || "https://api.wsystem.dev"}/einvoice/create`, { method: "POST", headers, body: JSON.stringify(body) }); data = await res.json(); } catch (e) { data = null; }
  let rec;
  if (!res || !res.ok || !data) {
    const msg = data && (data.detail || data.error) ? JSON.stringify(data.detail || data.error).slice(0, 300) : `API error ${res ? res.status : "unreachable"}`;
    rec = { kind: "credit_note", order: orderNumber(order), number: body.invoice_number, original: orig.number, valid: false, xml: "", errors: [{ rule_id: "API", message: msg, fix: "" }], created: new Date().toISOString() };
  } else {
    const p = parseResult(data, 0);
    rec = { kind: "credit_note", order: orderNumber(order), number: body.invoice_number, original: orig.number, format: body.format, valid: p.valid, xml: p.valid ? p.xml : "", errors: p.errors, created: new Date().toISOString() };
    if (p.valid && body.format === "zugferd" && data.pdf_base64) rec.pdf = data.pdf_base64;
  }
  await env.STORE.put(key, JSON.stringify(rec), { expirationTtl: TTL, metadata: { order: rec.order, number: rec.number, valid: rec.valid, created: rec.created } });
  await idxUpdate(env, shop, `cn-${refund.id}`, { order: rec.order, number: rec.number, valid: rec.valid, created: rec.created, xml: !!rec.xml, errors: (rec.errors || []).slice(0, 2), kind: "credit_note" });
  await audit(env, shop, "credit_note", refund.id);
  return rec;
}

async function onRefundWebhook(env, req, body) {
  const shop = (req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
  if (!SHOP_RE.test(shop)) return;
  const sd = await getShop(env, shop);
  if (!sd || sd.settings.credit_notes !== "yes" || sd.settings.trigger === "off") return;
  const refund = JSON.parse(body);
  if (!refund || !refund.id || !refund.order_id) return;
  await ensureAccess(env, shop, sd);
  if (!sd.token) return;
  const order = await findOrder(env, shop, sd.token, String(refund.order_id));
  if (!order) return;
  await createCreditNote(env, shop, sd, refund, order);
}

async function onCompliance(env, body) {
  const p = JSON.parse(body);
  const shop = String(p.shop_domain || "").toLowerCase();
  if (!SHOP_RE.test(shop)) return;
  const topic = p.__topic;
  if (topic === "shop/redact") return deleteShopData(env, shop);
  if (topic === "customers/redact") {
    const gone = new Set((p.orders_to_redact || []).map(String));
    for (const id of gone) await env.STORE.delete(`inv:${shop}:${id}`);
    const cur = (await env.STORE.get(`idx:${shop}`, "json")) || [];
    await env.STORE.put(`idx:${shop}`, JSON.stringify(cur.filter((x) => !gone.has(x.id))), { expirationTtl: TTL });
    return;
  }
  if (topic === "customers/data_request") {
    // Export: copy the stored invoice records (incl. XML) of the requested orders so the merchant can hand them to the customer.
    const records = [];
    for (const id of p.orders_requested || []) { const r = await env.STORE.get(`inv:${shop}:${id}`, "json"); if (r) records.push({ order_id: String(id), ...r }); }
    await env.STORE.put(`dsr:${shop}:${p.data_request && p.data_request.id || Date.now()}`, JSON.stringify({ at: new Date().toISOString(), customer_id: p.customer && p.customer.id, orders: p.orders_requested || [], records }), { expirationTtl: TTL });
  }
}

// ---------- router ----------
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(backupAll(env).then((r) => console.log("backup", JSON.stringify(r)))); },
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
        else if (path === "/webhooks/refunds-create") ctx.waitUntil(onRefundWebhook(env, req, body)); // B253: not subscribed until the app version with this topic is approved
        else if (path === "/webhooks/app-subscriptions") {
          const shop = (req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
          if (SHOP_RE.test(shop)) ctx.waitUntil((async () => { const sd = await getShop(env, shop); if (sd) { await ensureAccess(env, shop, sd); await syncBilling(env, shop, (await getShop(env, shop)) || sd); } })());
        } else if (path === "/webhooks/app-uninstalled") {
          const shop = (req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
          if (SHOP_RE.test(shop)) { const sd = await getShop(env, shop); if (sd) { if (sd.settings.api_key_managed && env.WSYSTEM_PROVISION_SECRET) ctx.waitUntil(fetch(`${env.API_BASE || "https://api.wsystem.dev"}/billing/shopify/provision`, { method: "POST", headers: { "content-type": "application/json", "x-provision-secret": env.WSYSTEM_PROVISION_SECRET }, body: JSON.stringify({ shop, plan: "shop_free" }) }).catch(() => {})); await putShop(env, shop, { settings: sd.settings }); } }
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
        if (!SHOP_RE.test(shop || "") || !/^(cn-)?\d+$/.test(id || "") || !safeEq((await hmac(env.ENC_KEY, `dl|${shop}|${id}`)).slice(0, 32), t)) return new Response("not found", { status: 404 });
        const rec = await env.STORE.get(`inv:${shop}:${id}`, "json");
        if (!rec || !rec.valid || !rec.xml) return new Response("not found", { status: 404 });
        await audit(env, shop, "download", id);
        if (url.searchParams.get("f") === "pdf") {
          if (!rec.pdf) return new Response("not found", { status: 404 });
          const bin = Uint8Array.from(atob(rec.pdf), (c) => c.charCodeAt(0));
          return new Response(bin, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${String(rec.number).replace(/[^\w.-]/g, "_")}.pdf"`, "cache-control": "no-store" } });
        }
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
            if (k === "api_key" && d[k].trim() !== sd.settings.api_key) delete s.api_key_managed; // merchant typed their own key
            s[k] = d[k].trim().slice(0, 300);
          }
          if (!["xrechnung", "en16931", "peppol-bis3"].includes(s.format)) s.format = "xrechnung";
          if (!["paid", "created", "off"].includes(s.trigger)) s.trigger = "paid";
          for (const k of ["zugferd", "credit_notes"]) if (s[k] !== "yes") s[k] = "no";
          await putShop(env, shop, { ...sd, settings: s });
          let webhooks = [];
          try { webhooks = await ensureWebhooks(env, shop, sd.token); } catch (e) { /* best effort */ }
          return json({ ok: true, webhooks });
        }
        if (path === "/api/invoices") {
          let idx = await env.STORE.get(`idx:${shop}`, "json");
          if (!idx) { // one-time backfill from the key listing (invoices created before the index existed)
            const l = await env.STORE.list({ prefix: `inv:${shop}:`, limit: 200 });
            idx = await Promise.all(l.keys.map(async (k) => { const r = (await env.STORE.get(k.name, "json")) || {}; return { id: k.name.split(":")[2], order: r.order, number: r.number, valid: r.valid, created: r.created, xml: !!r.xml, errors: (r.errors || []).slice(0, 2) }; }));
            idx.sort((a, b) => String(b.created).localeCompare(String(a.created))); idx = idx.slice(0, 50);
            await env.STORE.put(`idx:${shop}`, JSON.stringify(idx), { expirationTtl: TTL });
          }
          const invoices = await Promise.all(idx.slice(0, 25).map(async (i) => ({ order: i.order, number: i.number, valid: i.valid, created: i.created, xml: i.xml, errors: i.errors || [], lastError: i.lastError || null, lastAttemptAt: i.lastAttemptAt || null, url: await dlUrl(env, shop, i.id) })));
          await audit(env, shop, "list", "");
          return new Response(JSON.stringify({ invoices }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (path === "/api/data-requests") {
          const l = await env.STORE.list({ prefix: `dsr:${shop}:`, limit: 50 });
          const items = await Promise.all(l.keys.map(async (k) => { const r = await env.STORE.get(k.name, "json"); return { at: r.at, orders: r.orders, records: (r.records || []).map((x) => ({ order: x.order, number: x.number, valid: x.valid, xml: x.xml })) }; }));
          await audit(env, shop, "data-request-read", "");
          return new Response(JSON.stringify({ requests: items }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (path === "/api/billing" && req.method === "GET") return json({ live: plansOf(env).length > 0, plans: plansOf(env).map(({ ws, ...x }) => x), pricing_url: pricingUrl(env, shop), managed_key: !!sd.settings.api_key_managed, free_invoices: 25 });
        if (path === "/api/billing/sync" && req.method === "POST") return json(await syncBilling(env, shop, sd));
        if (path === "/api/billing/subscribe" && req.method === "POST") return json({ ok: true, url: pricingUrl(env, shop) }); // hosted Shopify plan page (managed pricing)
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
            order = await findOrder(env, shop, token, m[1]);
          } catch (e) { return fail("shopify_error", "Shopify did not return the order (" + String(e.message).slice(0, 60) + "). Check the app has order access.", 200, String(e.message).slice(0, 200)); }
          if (!order) return fail("order_not_found", `Order ${m[1]} was not found in this shop.`);
          if (!sd.settings.seller_name) return fail("no_settings", "Save your seller details first.");
          const existing = await env.STORE.get(`inv:${shop}:${order.id}`, "json");
          await audit(env, shop, "manual-create", order.id);
          let rec;
          try { rec = await generate(env, shop, order, { ...sd, token }, { force: true }); } catch (e) { return fail("generate_error", "Could not create the e-invoice.", 200, String(e.message).slice(0, 200)); }
          return json({ ok: true, valid: rec.valid, regenerated: !!existing, errors: rec.errors || [], ...(rec.lastError ? { kept_previous: true, lastError: rec.lastError } : {}) });
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
