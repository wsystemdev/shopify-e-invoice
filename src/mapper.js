// Maps a Shopify order (webhook / REST JSON) to the body of POST /einvoice/create (W System API).
// Mirrors woo-e-invoice class-wsei-mapper.php.
export const EU = ["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"];
const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export const DEFAULT_SETTINGS = {
  api_key: "", format: "xrechnung", trigger: "paid", only_b2b: "no", small_business: "no",
  seller_name: "", seller_street: "", seller_city: "", seller_postcode: "", seller_country: "DE",
  seller_email: "", seller_phone: "", seller_contact: "", seller_vat_id: "", seller_tax_no: "", seller_reg_no: "",
  seller_iban: "", seller_bic: "", payment_terms: "", default_buyer_reference: "", vat_attr_names: "vat_id, vat id, vat, ust-idnr, ust-id, ustidnr, tax_id",
  invoice_prefix: "", email_copy: "no",
  zugferd: "no", credit_notes: "no", // B253: beta options, OFF unless the merchant turns them on
};

export function buyerVat(order, s) {
  const names = String(s.vat_attr_names || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const a of order.note_attributes || []) {
    if (names.includes(String(a.name || "").trim().toLowerCase()) && String(a.value || "").trim()) {
      return String(a.value).toUpperCase().replace(/[\s.\-]/g, "");
    }
  }
  return "";
}
export function buyerReference(order, s) {
  for (const a of order.note_attributes || []) {
    if (/leitweg|buyer.?ref|kaeuferreferenz|käuferreferenz/i.test(String(a.name || "")) && String(a.value || "").trim()) return String(a.value).trim();
  }
  return String(s.default_buyer_reference || "").trim() || orderNumber(order);
}
export const orderNumber = (order) => String(order.name || order.order_number || order.id).replace(/^#/, "");
export const isB2B = (order, s) => !!(order.billing_address && String(order.billing_address.company || "").trim()) || buyerVat(order, s) !== "";
export const invoiceNumber = (order, s) => `${s.invoice_prefix || ""}${orderNumber(order)}`;

function taxInfo(item, includes, grossLine, zeroCat) {
  const tl = (item.tax_lines || []).filter((t) => n(t.price) !== 0 || n(t.rate) > 0);
  const tax = tl.reduce((a, t) => a + n(t.price), 0);
  const rate = tl.reduce((a, t) => a + n(t.rate), 0) * 100;
  const net = includes ? grossLine - tax : grossLine;
  if (rate > 0) return { net, tax: r2(tax), cat: "S", rate: r2(rate) };
  if (Math.abs(net) > 0 && Math.abs(tax) > 0) return { net, tax: r2(tax), cat: "S", rate: Math.round((tax / net) * 1000) / 10 };
  return { net, tax: 0, cat: zeroCat, rate: 0 };
}

function line(desc, qty, net, v, sku) {
  qty = n(qty); net = r2(net);
  if (qty <= 0) qty = 1;
  if (net < 0) qty = -qty;
  let price = Math.round((net / qty) * 1e6) / 1e6;
  if (Math.abs(r2(price * qty) - net) > 0.001) {
    desc = `${Math.abs(qty)} x ${desc}`; qty = net < 0 ? -1 : 1; price = Math.abs(net);
  }
  const l = { description: String(desc), quantity: qty, unit: "C62", unit_price: price, vat_rate: v.rate, vat_category: v.cat };
  if (sku) l.seller_item_id = String(sku);
  return l;
}

// BET3: Shopify rounds tax per line; the API computes VAT per rate as base x rate. Per rate, where they differ, first try a net within
// 3 cents on the last line of that rate that reaches the same gross (works with every API version); otherwise send the VAT Shopify
// charged as vat_amounts (used by the W System API once supported, ignored before). Keeps the e-invoice total = the order total.
export function reconcile(raw) {
  const groups = {};
  raw.forEach((l, i) => { if (l.cat === "S") (groups[l.rate] = groups[l.rate] || []).push(i); });
  const va = []; const tol = Math.max(0.01, r2(0.005 * raw.length));
  for (const [rate, idx] of Object.entries(groups)) {
    const r = Number(rate);
    const net = r2(idx.reduce((a, i) => a + r2(raw[i].net), 0)); const tax = r2(idx.reduce((a, i) => a + (raw[i].tax || 0), 0));
    const gross = r2(net + tax);
    if (Math.abs(r2(net * r / 100) - tax) < 0.001) continue;
    let best = null;
    for (let d = -3; d <= 3; d++) { const x = r2(net + d / 100); if (Math.abs(r2(x + r2(x * r / 100)) - gross) < 0.001 && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    if (best !== null) { const last = idx[idx.length - 1]; raw[last] = { ...raw[last], net: r2(r2(raw[last].net) + best / 100) }; }
    else if (Math.abs(r2(net * r / 100) - tax) <= tol + 0.0001) va.push({ vat_category: "S", vat_rate: r, tax_amount: tax });
  }
  return { raw, vat_amounts: va };
}

const berlinDate = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(d);

export function zeroCat(order, set) {
  const sc = String(set.seller_country || "DE").toUpperCase();
  const ba = order.billing_address || order.shipping_address || {};
  const bc = String(ba.country_code || "").toUpperCase();
  const bvat = buyerVat(order, set);
  if (set.small_business === "yes") return "E";
  if (bc && bc !== sc && !EU.includes(bc)) return "G";
  if (bvat && bc !== sc && EU.includes(bc)) return "AE";
  return "Z";
}

export function buildInvoice(order, s, opts = {}) {
  const set = { ...DEFAULT_SETTINGS, ...s };
  const sc = String(set.seller_country || "DE").toUpperCase();
  const ba = order.billing_address || order.shipping_address || {};
  const bc = String(ba.country_code || "").toUpperCase();
  const bvat = buyerVat(order, set);
  const small = set.small_business === "yes";
  const includes = !!order.taxes_included;
  const zero = zeroCat(order, set);

  let raw = [];
  for (const it of order.line_items || []) {
    const qty = n(it.quantity);
    const disc = n(it.total_discount);
    const gross = n(it.price) * qty - disc;
    const t = taxInfo(it, includes, gross, zero);
    raw.push({ desc: it.title + (it.variant_title ? ` (${it.variant_title})` : ""), qty, sku: it.sku, ...t });
  }
  for (const it of order.shipping_lines || []) {
    const gross = n(it.discounted_price != null ? it.discounted_price : it.price);
    if (r2(gross) === 0) continue;
    const t = taxInfo(it, includes, gross, zero);
    raw.push({ desc: `Shipping: ${it.title}`, qty: 1, ...t });
  }
  let vatAmounts = [];
  if (!small) ({ raw, vat_amounts: vatAmounts } = reconcile(raw));
  const lines = raw.map((x) => line(x.desc, x.qty, x.net, x, x.sku));
  if (small) for (const l of lines) { l.vat_category = "E"; l.vat_rate = 0; }

  const name = `${ba.first_name || ""} ${ba.last_name || ""}`.trim() || ba.name || "";
  const company = String(ba.company || "").trim();
  const buyer = {
    name: company || name,
    street: `${ba.address1 || ""} ${ba.address2 || ""}`.trim(),
    city: ba.city || "", postal_code: ba.zip || "", country: bc,
    email: order.email || (order.customer && order.customer.email) || "",
  };
  if (company && name) buyer.contact_name = name;
  if (bvat) buyer.vat_id = bvat;

  const seller = {
    name: set.seller_name, street: set.seller_street, city: set.seller_city, postal_code: set.seller_postcode, country: sc,
    email: set.seller_email, phone: set.seller_phone, contact_name: set.seller_contact,
  };
  if (set.seller_vat_id) seller.vat_id = String(set.seller_vat_id).toUpperCase().replace(/\s/g, "");
  if (set.seller_tax_no) seller.tax_number = set.seller_tax_no;
  if (set.seller_reg_no) seller.company_id = set.seller_reg_no;

  const paid = ["paid", "partially_refunded", "refunded"].includes(order.financial_status);
  const gw = (order.payment_gateway_names || []).join(",").toLowerCase();
  const iban = String(set.seller_iban || "").replace(/\s/g, "");
  const payment = {};
  if (!paid && (/bank|manual|bacs|transfer|überweisung/.test(gw) || iban)) payment.means_code = "58";
  else if (/cash_on_delivery|cod/.test(gw)) payment.means_code = "10";
  else if (paid) payment.means_code = "68";
  else payment.means_code = "1";
  if (iban && payment.means_code === "58") {
    payment.iban = iban;
    if (set.seller_bic) payment.bic = set.seller_bic;
    payment.account_name = set.seller_name;
  }
  const number = invoiceNumber(order, set);
  payment.reference = number;
  let terms = set.payment_terms || "";
  if (paid) terms = `Paid via ${(order.payment_gateway_names || [])[0] || "online payment"} ${String(order.processed_at || order.created_at || "").slice(0, 10)}`.trim();
  if (terms) payment.terms = terms;

  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null));
  const today = opts.today || berlinDate();
  const body = {
    format: opts.format || (set.zugferd === "yes" && set.format !== "peppol-bis3" ? "zugferd" : set.format),
    invoice_number: number,
    issue_date: today,
    delivery_date: String(order.processed_at || order.created_at || "").slice(0, 10) || today,
    currency: order.currency || order.presentment_currency || "EUR",
    buyer_reference: buyerReference(order, set),
    order_reference: orderNumber(order),
    seller: strip(seller), buyer: strip(buyer), lines, payment,
  };
  if (vatAmounts.length) body.vat_amounts = vatAmounts;
  if (paid) body.prepaid_amount = r2(n(order.current_total_price != null ? order.current_total_price : order.total_price));
  if (small) body.vat_exemption_reason = { E: "No VAT charged under the small business scheme (section 19 UStG)." };
  return body;
}

export function parseResult(d, orderTotal) {
  const errors = (Array.isArray(d.errors) ? d.errors : []).map((e) => ({
    rule_id: e.rule_id || "", message: (e.explain && e.explain.what) || e.message || "", fix: (e.explain && e.explain.fix) || e.fix || "",
  }));
  const totals = d.totals || {};
  let mismatch = "";
  if (totals.total_with_vat != null && Math.abs(n(totals.total_with_vat) - n(orderTotal)) > 0.004) {
    mismatch = `The e-invoice total (${totals.total_with_vat}) differs from the order total (${orderTotal}), usually by rounding or tips/gift cards.`;
  }
  return { valid: !!d.valid, xml: d.xml || "", errors, totals, mismatch };
}

// ---- B253: credit note for a Shopify refund (refunds/create payload) -> POST /einvoice/create, type_code 381 ----
// Only used when the shop turned "credit_notes" on. `refund` = the refunds/create webhook JSON, `order` = the original order (REST shape,
// line_items need `id`). Amounts stay positive (EN 16931 credit note). Lines = refunded items + refunded shipping, taxed at the original rates.
export function buildCreditNote(order, refund, s, opts = {}) {
  const set = { ...DEFAULT_SETTINGS, ...s };
  const base = buildInvoice(order, set, opts);
  const includes = !!order.taxes_included;
  const zero = zeroCat(order, set);
  let raw = [];
  for (const rl of refund.refund_line_items || []) {
    const it = (order.line_items || []).find((x) => String(x.id) === String(rl.line_item_id || (rl.line_item && rl.line_item.id)));
    if (!it) continue;
    const qty = n(rl.quantity);
    if (qty <= 0) continue;
    const rate = (it.tax_lines || []).reduce((a, t) => a + n(t.rate), 0);
    const gross = n(rl.subtotal);                      // refunded amount of this line (tax-inclusive when the shop shows prices with tax)
    const t = taxInfo({ tax_lines: [{ rate, price: n(rl.total_tax) }] }, includes, gross, zero);
    raw.push({ desc: it.title + (it.variant_title ? ` (${it.variant_title})` : ""), qty, sku: it.sku, ...t });
  }
  for (const a of refund.order_adjustments || []) {
    if (a.kind !== "shipping_refund") continue;
    const gross = Math.abs(n(a.amount)) , tax = Math.abs(n(a.tax_amount));
    if (r2(gross) === 0) continue;
    const ship = (order.shipping_lines || [])[0] || {};
    const rate = (ship.tax_lines || []).reduce((x, t) => x + n(t.rate), 0);
    // shipping_refund.amount is tax-exclusive in Shopify's payload; add the tax back when the shop shows prices with tax so taxInfo can split it
    const t = taxInfo({ tax_lines: [{ rate, price: tax }] }, includes, includes ? gross + tax : gross, zero);
    raw.push({ desc: "Shipping (refund)", qty: 1, ...t });
  }
  let vatAmounts = [];
  if (set.small_business !== "yes") ({ raw, vat_amounts: vatAmounts } = reconcile(raw));
  const lines = raw.map((x) => line(x.desc, x.qty, x.net, x, x.sku));
  if (set.small_business === "yes") for (const l of lines) { l.vat_category = "E"; l.vat_rate = 0; }
  const body = { ...base, lines };
  delete body.prepaid_amount; delete body.vat_amounts;
  if (vatAmounts.length) body.vat_amounts = vatAmounts;
  const orig = base.invoice_number;
  body.invoice_number = `${set.invoice_prefix || ""}CN-${orderNumber(order)}-${String(refund.id || "").slice(-6)}`;
  body.type_code = "381";
  body.preceding_invoice = opts.precedingNumber || orig;
  body.preceding_invoice_date = opts.precedingDate || String(order.processed_at || order.created_at || "").slice(0, 10) || base.issue_date;
  body.issue_date = opts.today || berlinDate();
  body.delivery_date = String(refund.created_at || "").slice(0, 10) || body.issue_date;
  const iban = String(set.seller_iban || "").replace(/\s/g, "");  // BR-61: means 58 needs an account; otherwise "1" (not defined)
  body.payment = iban ? { means_code: "58", iban, account_name: set.seller_name, reference: body.invoice_number, terms: "Refund to the original payment method" }
    : { means_code: "1", reference: body.invoice_number, terms: "Refund to the original payment method" };
  if (set.small_business === "yes") body.vat_exemption_reason = { E: "No VAT charged under the small business scheme (section 19 UStG)." };
  return body;
}
