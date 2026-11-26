// Maps a Shopify order (webhook / REST JSON) to the body of POST /einvoice/create (W System API).
// Mirrors woo-e-invoice class-wsei-mapper.php.
export const EU = ["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"];
const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
// PC-8: integer-cent rounding. (x + EPS) * 100 mis-rounds half cents (49.50 × 19 % → 9.40 instead of 9.41).
const r2 = (x) => { const v = Number(x); return Math.sign(v) * Math.round(Number((Math.abs(v) * 100).toPrecision(15))) / 100 + 0; };   // integer-cent rounding without exponent strings (no NaN for 5e-17)

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

// PC-3: a price taxed at several rates. Two shapes exist: stacked taxes on the SAME base (e.g. US state + county: the rates add up,
// one line) and a price SPLIT over rates (EU shipping/bundles in a 19 % + 7 % cart: each rate taxes its own share of the net; summing
// the rates gave one line at 26 %). Split when the bases implied by tax/rate add up to the net; otherwise keep the summed rate.
export function taxParts(item, includes, grossLine, zeroCat) {
  // PC-11: keep a positive rate even when that share's tax rounded to 0.00, otherwise a tiny 7 % (or 19 %)
  // shipping share is dropped and the rest is mapped as one line at the summed 26 %.
  const tl = (item.tax_lines || []).filter((t) => n(t.rate) > 0);
  const one = taxInfo(item, includes, grossLine, zeroCat);
  if (tl.length < 2 || one.cat !== "S") return [one];
  const net = one.net;
  const est = tl.map((t) => n(t.price) / n(t.rate));
  const sumEst = est.reduce((a, b) => a + b, 0);
  // Stacked = each implied base is the full net (state + county). A tiny 0.00-tax share has an implied
  // base of 0, so it is a split, not stacked, even though sumEst is then close to maxEst.
  const stacked = est.every((e, i) => Math.abs(e - net) <= 0.005 / n(tl[i].rate) + 0.011);   // each implied base = full net, within that tax's own cent rounding
  if (stacked) return [one];
  const out = []; let left = r2(net);
  const denom = sumEst || 1;
  tl.forEach((t, i) => {
    const part = i === tl.length - 1 ? r2(left) : r2(net * est[i] / denom);
    left = r2(left - part);
    out.push({ net: part, tax: r2(n(t.price)), cat: "S", rate: r2(n(t.rate) * 100), split: true });
  });
  return out;
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

// BET3 / PC-4 / PC-5 (same rules as the Shopware plugin's reconcile()): Shopify rounds tax per line; the API rounds each line net to
// cents (EN 16931) and computes VAT per rate as base x rate. Per rate, where the gross differs, first try a net within 3 cents on that
// rate's last line that reaches the same gross (works with every API version). Second pass: if a rate's gross cannot be reached by any
// net (e.g. 3 x 9.99 incl. 19 %), shift another rate's net by 1-2 cents so the e-invoice total equals the order total on today's API.
// Then vat_amounts carries, per rate, the gross Shopify charged minus the net sent, wherever base x rate misses it and the difference
// is within the API's per-line rounding bound (0.005 per line, min 0.01, max 0.99): with an API that supports vat_amounts every rate's
// gross is exact; API versions without it ignore the field.
const apiTotal = (raw) => {
  const by = {};
  for (const l of raw) { const k = `${l.cat}|${l.rate}`; by[k] = (by[k] || 0) + r2(l.net); }
  return r2(Object.entries(by).reduce((a, [k, v]) => { const x = r2(v); const rt = l2rate(k); return a + x + r2(x * rt / 100); }, 0));
};
const l2rate = (k) => (k.startsWith("S|") ? Number(k.slice(2)) : 0);
export function reconcile(raw) {
  raw = raw.map((l) => ({ ...l, net: r2(l.net), gross: r2(r2(l.net) + (l.cat === "S" ? (l.tax || 0) : 0)) }));
  const groups = {};
  raw.forEach((l, i) => { if (l.cat === "S") (groups[l.rate] = groups[l.rate] || []).push(i); });
  const lastOf = (idx) => { const q1 = idx.filter((i) => Math.abs(n(raw[i].qty)) === 1); return q1.length ? q1[q1.length - 1] : idx[idx.length - 1]; };
  const gsum = (idx, f) => r2(idx.reduce((a, i) => a + raw[i][f], 0));
  for (const [rate, idx] of Object.entries(groups)) {
    const r = Number(rate); const net = gsum(idx, "net"); const gross = gsum(idx, "gross");
    if (Math.abs(r2(net + r2(net * r / 100)) - gross) < 0.001) continue;
    let best = null;
    for (let d = -3; d <= 3; d++) { const x = r2(net + d / 100); if (Math.abs(r2(x + r2(x * r / 100)) - gross) < 0.001 && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    if (best !== null) { const k = lastOf(idx); raw[k] = { ...raw[k], net: r2(raw[k].net + best / 100) }; }
  }
  const target = r2(raw.reduce((a, l) => a + l.gross, 0));
  if (Math.abs(apiTotal(raw) - target) > 0.001) {
    outer: for (const d of [1, -1, 2, -2]) {
      for (const idx of Object.values(groups)) {
        const k = lastOf(idx); const tr = raw.slice(); tr[k] = { ...tr[k], net: r2(tr[k].net + d / 100) };
        if (Math.abs(apiTotal(tr) - target) < 0.001) { raw = tr; break outer; }
      }
    }
  }
  const tol = Math.min(0.99, Math.max(0.01, r2(0.005 * raw.length)));
  const va = [];
  for (const [rate, idx] of Object.entries(groups)) {
    const r = Number(rate); const net = gsum(idx, "net"); const charged = r2(gsum(idx, "gross") - net); const calc = r2(net * r / 100);
    if (Math.abs(charged - calc) > 0.001 && Math.abs(charged - calc) <= tol + 0.0001) va.push({ vat_category: "S", vat_rate: r, tax_amount: charged });
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
    const desc = it.title + (it.variant_title ? ` (${it.variant_title})` : "");
    for (const t of taxParts(it, includes, gross, zero)) raw.push(t.split ? { desc: `${qty !== 1 ? `${qty} x ` : ""}${desc} (${t.rate} %)`, qty: 1, sku: it.sku, ...t } : { desc, qty, sku: it.sku, ...t });
  }
  for (const it of order.shipping_lines || []) {
    const gross = n(it.discounted_price != null ? it.discounted_price : it.price);
    if (r2(gross) === 0) continue;
    for (const t of taxParts(it, includes, gross, zero)) raw.push({ desc: t.split ? `Shipping: ${it.title} (${t.rate} %)` : `Shipping: ${it.title}`, qty: 1, ...t });
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
    // PC-9: refund mixed-rate shipping with one line per original rate, not one "Shipping (refund)" at the summed rate.
    // shipping_refund.amount is tax-exclusive; add the tax back when the shop shows prices with tax.
    const refundGross = includes ? gross + tax : gross;
    const origGross = n(ship.discounted_price != null ? ship.discounted_price : ship.price) || 0;
    const origLines = (ship.tax_lines || []).filter((t) => n(t.rate) > 0);
    let taxLines;
    if (origLines.length >= 2 && origGross) {
      const factor = refundGross / origGross;
      taxLines = origLines.map((t) => ({ rate: t.rate, price: r2(n(t.price) * factor) }));
    } else {
      const rate = origLines.reduce((x, t) => x + n(t.rate), 0) || (ship.tax_lines || []).reduce((x, t) => x + n(t.rate), 0);
      taxLines = [{ rate, price: tax }];
    }
    for (const part of taxParts({ tax_lines: taxLines }, includes, refundGross, zero)) {
      raw.push({ desc: part.split ? `Shipping (refund) (${part.rate} %)` : "Shipping (refund)", qty: 1, ...part });
    }
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
