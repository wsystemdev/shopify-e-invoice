import test from "node:test";
import assert from "node:assert/strict";
import { buildInvoice, parseResult, buyerVat, buyerReference } from "../src/mapper.js";

const S = { seller_name: "Muster GmbH", seller_street: "Hauptstr. 1", seller_city: "Berlin", seller_postcode: "10115", seller_country: "DE", seller_email: "a@muster.example", seller_phone: "+4930123", seller_contact: "Max Muster", seller_vat_id: "DE 123456789", seller_iban: "DE02 1203 0000 0000 2020 51", seller_bic: "BYLADEM1001", format: "xrechnung" };
const order = (o = {}) => ({ id: 1, name: "#1001", currency: "EUR", taxes_included: true, financial_status: "pending", payment_gateway_names: ["bank_transfer"], total_price: "119.00",
  created_at: "2026-11-20T10:00:00+01:00", email: "b@kunde.example", billing_address: { first_name: "Eva", last_name: "Kunde", company: "Kunde AG", address1: "Weg 2", city: "Köln", zip: "50667", country_code: "DE" },
  note_attributes: [{ name: "VAT ID", value: "de 987.654.321" }, { name: "Leitweg-ID", value: "04011000-1234512345-35" }],
  line_items: [{ title: "Widget", variant_title: "Blue", sku: "W1", quantity: 1, price: "119.00", total_discount: "0.00", tax_lines: [{ price: "19.00", rate: 0.19 }] }], shipping_lines: [], ...o });

test("tax-inclusive line becomes net with 19% S", () => {
  const b = buildInvoice(order(), S, { today: "2026-11-21" });
  assert.equal(b.lines[0].unit_price, 100); assert.equal(b.lines[0].vat_rate, 19); assert.equal(b.lines[0].vat_category, "S");
  assert.equal(b.lines[0].description, "Widget (Blue)"); assert.equal(b.lines[0].seller_item_id, "W1");
  assert.equal(b.invoice_number, "1001"); assert.equal(b.issue_date, "2026-11-21"); assert.equal(b.delivery_date, "2026-11-20");
});
test("buyer vat and leitweg", () => {
  const o = order(); assert.equal(buyerVat(o, { vat_attr_names: "vat id" }), "DE987654321"); assert.equal(buyerReference(o, {}), "04011000-1234512345-35");
  assert.equal(buildInvoice(o, S).buyer.vat_id, "DE987654321");
});
test("buyer vat attr default names; reference falls back to default then order number", () => {
  const o = order({ note_attributes: [{ name: "vat_id", value: "ATU12345678" }] });
  const b = buildInvoice(o, S); assert.equal(b.buyer.vat_id, "ATU12345678"); assert.equal(b.buyer_reference, "1001");
  assert.equal(buildInvoice(o, { ...S, default_buyer_reference: "REF-9" }).buyer_reference, "REF-9");
});
test("bank transfer vs paid payment means", () => {
  const b = buildInvoice(order(), S); assert.equal(b.payment.means_code, "58"); assert.equal(b.payment.iban, "DE02120300000000202051"); assert.equal(b.payment.reference, "1001");
  const p = buildInvoice(order({ financial_status: "paid", payment_gateway_names: ["shopify_payments"], processed_at: "2026-11-20T12:00:00Z" }), S);
  assert.equal(p.payment.means_code, "68"); assert.equal(p.prepaid_amount, 119); assert.match(p.payment.terms, /Paid via shopify_payments 2026-11-20/); assert.equal(p.payment.iban, undefined);
});
test("tax exclusive, discount and shipping with 7% and 19%", () => {
  const o = order({ taxes_included: false, line_items: [
    { title: "Book", quantity: 2, price: "10.00", total_discount: "2.00", tax_lines: [{ price: "1.26", rate: 0.07 }] },
    { title: "Shirt", quantity: 1, price: "50.00", total_discount: "0", tax_lines: [{ price: "9.50", rate: 0.19 }] }],
    shipping_lines: [{ title: "DHL", price: "5.00", discounted_price: "4.00", tax_lines: [{ price: "0.76", rate: 0.19 }] }] });
  const b = buildInvoice(o, S);
  assert.equal(b.lines.length, 3); assert.equal(b.lines[0].unit_price, 9); assert.equal(b.lines[0].quantity, 2); assert.equal(b.lines[0].vat_rate, 7);
  assert.equal(b.lines[2].description, "Shipping: DHL"); assert.equal(b.lines[2].unit_price, 4);
});
test("zero-rated: intra-EU reverse charge, export, small business", () => {
  const zero = { price: "0.00", rate: 0 };
  const li = [{ title: "X", quantity: 1, price: "100", total_discount: "0", tax_lines: [zero] }];
  const eu = buildInvoice(order({ taxes_included: false, line_items: li, billing_address: { company: "SARL", country_code: "FR", first_name: "a", last_name: "b" }, note_attributes: [{ name: "vat_id", value: "FR12345678901" }] }), S);
  assert.equal(eu.lines[0].vat_category, "AE");
  const us = buildInvoice(order({ taxes_included: false, line_items: li, billing_address: { first_name: "a", last_name: "b", country_code: "US" }, note_attributes: [] }), S); assert.equal(us.lines[0].vat_category, "G");
  const sm = buildInvoice(order({ line_items: [{ title: "X", quantity: 1, price: "100", total_discount: "0", tax_lines: [] }], taxes_included: false }), { ...S, small_business: "yes" });
  assert.equal(sm.lines[0].vat_category, "E"); assert.ok(sm.vat_exemption_reason.E);
});
test("odd unit price collapses to quantity 1 so totals stay exact", () => {
  const o = order({ taxes_included: false, line_items: [{ title: "Bulk", quantity: 3, price: "3.33", total_discount: "0.01", tax_lines: [{ price: "1.90", rate: 0.19 }] }] });
  const l = buildInvoice(o, S).lines[0]; assert.equal(Math.round(l.quantity * l.unit_price * 100) / 100, 9.98);
});
test("seller empties are dropped and VAT id normalised", () => {
  const b = buildInvoice(order(), S); assert.equal(b.seller.vat_id, "DE123456789"); assert.equal(b.seller.tax_number, undefined);
});
test("parseResult flags total mismatch and maps errors", () => {
  const r = parseResult({ valid: false, errors: [{ rule_id: "BR-DE-2", explain: { what: "x", fix: "y" } }], totals: { total_with_vat: 118.99 }, xml: "<a/>" }, "119.00");
  assert.equal(r.valid, false); assert.equal(r.errors[0].fix, "y"); assert.match(r.mismatch, /differs/);
});

// ---- B253: ZUGFeRD option + credit notes (both OFF by default) ----
import { buildCreditNote, DEFAULT_SETTINGS } from "../src/mapper.js";
const o2 = () => order({ financial_status: "partially_refunded", processed_at: "2026-11-20T12:00:00Z",
  line_items: [{ id: 11, title: "Widget", variant_title: "Blue", sku: "W1", quantity: 2, price: "119.00", total_discount: "0.00", tax_lines: [{ price: "38.00", rate: 0.19 }] },
               { id: 12, title: "Book", quantity: 1, price: "10.70", total_discount: "0.00", tax_lines: [{ price: "0.70", rate: 0.07 }] }],
  shipping_lines: [{ title: "DHL", price: "5.95", discounted_price: "5.95", tax_lines: [{ price: "0.95", rate: 0.19 }] }] });
const refund = { id: 9000123, order_id: 1, created_at: "2026-11-22T09:00:00Z",
  refund_line_items: [{ line_item_id: 11, quantity: 1, subtotal: 119.0, total_tax: 19.0 }, { line_item_id: 12, quantity: 1, subtotal: 10.7, total_tax: 0.7 }],
  order_adjustments: [{ kind: "shipping_refund", amount: "-5.00", tax_amount: "-0.95" }] };

test("defaults: zugferd and credit_notes are off; format unchanged", () => {
  assert.equal(DEFAULT_SETTINGS.zugferd, "no"); assert.equal(DEFAULT_SETTINGS.credit_notes, "no");
  assert.equal(buildInvoice(order(), S).format, "xrechnung");
  assert.equal(buildInvoice(order(), { ...S, format: "en16931" }).format, "en16931");
});
test("zugferd=yes switches format to zugferd (not for peppol-bis3)", () => {
  assert.equal(buildInvoice(order(), { ...S, zugferd: "yes" }).format, "zugferd");
  assert.equal(buildInvoice(order(), { ...S, zugferd: "yes", format: "peppol-bis3" }).format, "peppol-bis3");
});
test("credit note: 381, references original, refunded items + shipping at original rates, positive amounts, no prepaid", () => {
  const b = buildCreditNote(o2(), refund, S, { today: "2026-11-22", precedingNumber: "1001", precedingDate: "2026-11-20" });
  assert.equal(b.type_code, "381"); assert.equal(b.preceding_invoice, "1001"); assert.equal(b.preceding_invoice_date, "2026-11-20");
  assert.equal(b.invoice_number, "CN-1001-000123"); assert.equal(b.issue_date, "2026-11-22"); assert.equal(b.prepaid_amount, undefined);
  assert.equal(b.lines.length, 3);
  assert.deepEqual(b.lines.map((l) => [l.unit_price, l.quantity, l.vat_rate, l.vat_category]), [[100, 1, 19, "S"], [10, 1, 7, "S"], [5, 1, 19, "S"]]);
  assert.match(b.lines[0].description, /Widget \(Blue\)/); assert.match(b.lines[2].description, /Shipping/);
});
test("credit note: tax-exclusive shop, small business and unknown line skipped", () => {
  const o = o2(); o.taxes_included = false;
  const r = { ...refund, refund_line_items: [{ line_item_id: 11, quantity: 1, subtotal: 100.0, total_tax: 19.0 }, { line_item_id: 999, quantity: 1, subtotal: 5, total_tax: 0 }], order_adjustments: [] };
  const b = buildCreditNote(o, r, S);
  assert.equal(b.lines.length, 1); assert.equal(b.lines[0].unit_price, 100); assert.equal(b.lines[0].vat_rate, 19);
  const k = buildCreditNote(o, r, { ...S, small_business: "yes" });
  assert.equal(k.lines[0].vat_category, "E"); assert.equal(k.lines[0].vat_rate, 0); assert.ok(k.vat_exemption_reason.E);
});
test("credit note payment: IBAN set -> means 58 with IBAN (BR-61); no IBAN -> means 1", () => {
  const w = buildCreditNote(o2(), refund, { ...S, seller_iban: "DE02 1203 0000 0000 2020 51" }); assert.equal(w.payment.means_code, "58"); assert.equal(w.payment.iban, "DE02120300000000202051");
  const n = buildCreditNote(o2(), refund, { ...S, seller_iban: "" }); assert.equal(n.payment.means_code, "1"); assert.equal(n.payment.iban, undefined);
});

// ---- BET3: per-line tax rounding vs base x rate ----
const b3order = (items, extra = {}) => ({ name: "#B3", currency: "EUR", taxes_included: true, financial_status: "paid", payment_gateway_names: ["paypal"],
  created_at: "2026-11-24T10:00:00+01:00", billing_address: { company: "Kunde GmbH", country_code: "DE", address1: "Weg 5", city: "München", zip: "80331" },
  line_items: items.map(([title, qty, price, rate, tax], i) => ({ id: i + 1, title, quantity: qty, price: String(price), total_discount: "0", sku: "", tax_lines: [{ rate, price: String(tax) }] })),
  shipping_lines: [], ...extra });
const b3total = (b) => { const by = {}; for (const l of b.lines) by[l.vat_rate] = (by[l.vat_rate] || 0) + Math.round(l.quantity * l.unit_price * 100) / 100;
  const ov = Object.fromEntries((b.vat_amounts || []).map((v) => [v.vat_rate, v.tax_amount])); let t = 0;
  for (const [r, x0] of Object.entries(by)) { const x = Math.round(x0 * 100) / 100; t += x + (ov[r] ?? Math.round(x * Number(r)) / 100); } return Math.round(t * 100) / 100; };
test("BET3: 9.99 incl. 19 % sends the charged VAT as vat_amounts", () => {
  const b = buildInvoice(b3order([["Pen", 1, 9.99, 0.19, 1.60]]), { seller_country: "DE" }, { today: "2026-11-26" });
  assert.deepEqual(b.vat_amounts, [{ vat_category: "S", vat_rate: 19, tax_amount: 1.6 }]);
  assert.equal(b3total(b), 9.99);
});
test("BET3: mixed rates, total equals order total", () => {
  const b = buildInvoice(b3order([["Pen", 3, 9.99, 0.19, 4.79], ["Book", 2, 12.95, 0.07, 1.69], ["Coffee", 1, 4.99, 0.07, 0.33]]), { seller_country: "DE" }, { today: "2026-11-26" });
  assert.equal(b3total(b), 60.86);
});
test("BET3: exact orders carry no vat_amounts", () => {
  const b = buildInvoice(b3order([["Service", 1, 119, 0.19, 19]]), { seller_country: "DE" }, { today: "2026-11-26" });
  assert.equal(b.vat_amounts, undefined);
  assert.equal(b3total(b), 119);
});

// PC-3 / PC-4: split-rate shipping and cross-rate total reconcile
import { taxParts, reconcile } from "../src/mapper.js";
test("PC-3: shipping taxed 19 % + 7 % on split bases becomes two lines, not one 26 % line", () => {
  const ship = { tax_lines: [{ rate: 0.19, price: "0.40" }, { rate: 0.07, price: "0.18" }] }; // 2.10 net @19 + 2.62 net @7 (≈), gross 5.30
  const p = taxParts(ship, true, 5.30, "Z");
  assert.equal(p.length, 2);
  assert.deepEqual(p.map((x) => x.rate), [19, 7]);
  assert.equal(Math.round((p[0].net + p[1].net) * 100) / 100, 4.72);
});
test("PC-3: stacked taxes on the same base (state + county) keep one line at the summed rate", () => {
  const it = { tax_lines: [{ rate: 0.06, price: "6.00" }, { rate: 0.02, price: "2.00" }] };
  const p = taxParts(it, false, 100, "Z");
  assert.equal(p.length, 1); assert.equal(p[0].rate, 8);
});
test("PC-4: 3 x 9.99 (19 %) + 4.99 (7 %) gives 34.96 on APIs with and without vat_amounts", () => {
  const raw = [{ desc: "A", qty: 3, net: 25.18, tax: 4.79, cat: "S", rate: 19 }, { desc: "B", qty: 1, net: 4.66, tax: 0.33, cat: "S", rate: 7 }];
  const { raw: out, vat_amounts: va } = reconcile(raw);
  const by = {}; for (const l of out) by[l.rate] = Math.round(((by[l.rate] || 0) + l.net) * 100) / 100;
  const r2x = (x) => Math.round(x * 100) / 100;
  const old = Object.entries(by).reduce((a, [r, v]) => a + v + r2x(v * r / 100), 0);
  assert.equal(r2x(old), 34.96);
  const vm = Object.fromEntries(va.map((v) => [v.vat_rate, v.tax_amount]));
  const neu = Object.entries(by).reduce((a, [r, v]) => a + v + (vm[r] ?? r2x(v * r / 100)), 0);
  assert.equal(r2x(neu), 34.96);
  assert.equal(vm[19], 4.79);
});

test("PC-8: 49.50 × 19 % rounds to 9.41 (integer cents), so vat_amounts or the total match the shop", () => {
  const { raw, vat_amounts: va } = reconcile([{ desc: "A", qty: 1, net: 49.50, tax: 9.41, cat: "S", rate: 19 }]);
  const net = raw.reduce((a, l) => a + l.net, 0);
  const calc = Number(Math.round((net * 19) / 100 + "e+2") + "e-2");
  const tax = va.length ? va[0].tax_amount : calc;
  assert.equal(Number(Math.round(net + tax + "e+2") + "e-2"), 58.91);
  // r2 itself must not turn 9.405 into 9.40
  const shopTax = Number(Math.round(49.50 * 0.19 + "e+2") + "e-2");
  assert.equal(shopTax, 9.41);
});

test("PC-11: split shipping keeps a 0.00-tax tiny share as its own rate, not one 26 % line", () => {
  const ship = { tax_lines: [{ rate: 0.19, price: "1.11" }, { rate: 0.07, price: "0.00" }] };
  const p = taxParts(ship, true, 6.99, "Z");
  assert.ok(p.length === 2, JSON.stringify(p));
  assert.deepEqual(p.map((x) => x.rate), [19, 7]);
  assert.equal(p.find((x) => x.rate === 7).tax, 0);
});

test("PC-9: credit note splits mixed-rate shipping refund per rate, not one line at 26 %", () => {
  const order = {
    name: "#1001", currency: "EUR", taxes_included: true, financial_status: "paid",
    billing_address: { first_name: "A", last_name: "B", address1: "S 1", city: "Berlin", zip: "10115", country_code: "DE", company: "Kunde GmbH" },
    line_items: [{ id: 1, title: "Pen", quantity: 1, price: "11.90", sku: "P", tax_lines: [{ rate: 0.19, price: "1.90" }] }],
    shipping_lines: [{ title: "DHL", price: "5.30", tax_lines: [{ rate: 0.19, price: "0.40" }, { rate: 0.07, price: "0.18" }] }],
  };
  const refund = {
    id: 99, created_at: "2026-11-26T00:00:00+01:00",
    refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: "11.90", total_tax: "1.90" }],
    order_adjustments: [{ kind: "shipping_refund", amount: "-4.72", tax_amount: "-0.58" }],
  };
  const b = buildCreditNote(order, refund, { seller_country: "DE", credit_notes: "yes" }, { today: "2026-11-26" });
  const ships = b.lines.filter((l) => /Shipping/.test(l.description));
  assert.ok(ships.length === 2, JSON.stringify(b.lines));
  assert.deepEqual(ships.map((l) => l.vat_rate).sort((a, b) => a - b), [7, 19]);
  assert.ok(!ships.some((l) => l.vat_rate === 26));
});

test("187.43 net stacked 6%+1% stays one line and totals 200.55", () => {
  const net = 187.43;
  const t6 = Math.round(net * 0.06 * 100) / 100;
  const t1 = Math.round(net * 0.01 * 100) / 100;
  const gross = Math.round((net + t6 + t1) * 100) / 100;
  assert.equal(t6, 11.25); assert.equal(t1, 1.87); assert.equal(gross, 200.55);
  const it = { tax_lines: [{ rate: 0.06, price: t6.toFixed(2) }, { rate: 0.01, price: t1.toFixed(2) }] };
  const p = taxParts(it, false, net, "Z");
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.equal(p[0].rate, 7);
  const b = buildInvoice(order({
    taxes_included: false, total_price: String(gross), current_total_price: String(gross), financial_status: "paid",
    line_items: [{ title: "Good", quantity: 1, price: String(net), total_discount: "0.00", tax_lines: it.tax_lines }],
    shipping_lines: [],
  }), S, { today: "2026-11-26" });
  assert.equal(b.lines.length, 1);
  assert.equal(b.lines[0].vat_rate, 7);
  const tot = (b.lines || []).reduce((a, l) => a + Math.round(l.quantity * l.unit_price * 100) / 100, 0);
  const tax = (b.vat_amounts && b.vat_amounts[0] ? b.vat_amounts[0].tax_amount : Math.round(tot * 7) / 100);
  assert.equal(Math.round((tot + tax) * 100) / 100, 200.55);
});

test("random stacked fuzz: 0 mis-splits", () => {
  let s = 20261126;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const r2x = (x) => Math.round(x * 100) / 100;
  const cases = [[[0.06, "s"], [0.01, "c"]], [[0.05, "g"], [0.07, "p"]], [[0.0625, "s"], [0.025, "c"]]];
  let bad = 0; const N = 2000;
  for (let i = 0; i < N; i++) {
    const rates = cases[i % cases.length];
    const net = r2x(1 + rnd() * 300);
    const item = { tax_lines: rates.map(([r]) => ({ rate: r, price: r2x(net * r).toFixed(2) })) };
    const parts = taxParts(item, false, net, "Z");
    const sumRate = r2x(rates.reduce((a, [r]) => a + r, 0) * 100);
    if (parts.length !== 1 || Math.abs(parts[0].rate - sumRate) > 0.001) bad++;
  }
  assert.equal(bad, 0, `${bad} of ${N} mis-split`);
});

test("100%-discounted multi-quantity line sends unit_price 0, not null", () => {
  const mk = (price, qty, disc) => order({
    taxes_included: true, financial_status: "paid", total_price: "10.00", current_total_price: "10.00",
    line_items: [
      { title: "Gift", quantity: qty, price, total_discount: disc, tax_lines: [{ rate: 0.19, price: "0.00" }] },
      { title: "Real", quantity: 1, price: "10.00", total_discount: "0.00", tax_lines: [{ rate: 0.19, price: "1.60" }] },
    ],
    shipping_lines: [],
  });
  for (const [p, q, d] of [["19.90", 3, "59.70"], ["0.10", 3, "0.30"], ["9.99", 1, "9.99"], ["33.33", 3, "99.99"], ["4.95", 7, "34.65"]]) {
    const b = buildInvoice(mk(p, q, d), S, { today: "2026-11-26" });
    const gift = b.lines.find((l) => l.description === "Gift");
    assert.ok(gift, `missing Gift line for ${q} x ${p} -${d}: ` + JSON.stringify(b.lines));
    assert.equal(gift.unit_price, 0);
    assert.equal(Number.isNaN(gift.unit_price), false);
    assert.notEqual(gift.unit_price, null);
  }
});

test("P2 #1016: discount code allocations apply when total_discount is 0, payable 0 on a paid order", () => {
  // 49.90 + 31.70 = 81.60; QA-FIX5 5.00 split 3.30 + 1.70; shop total / prepaid 76.60
  const o = order({
    name: "#1016", taxes_included: true, financial_status: "paid",
    total_price: "76.60", current_total_price: "76.60", payment_gateway_names: ["shopify_payments"],
    line_items: [
      { title: "A", quantity: 1, price: "49.90", total_discount: "0.00",
        discount_allocations: [{ amount: "3.30", discount_application_index: 0 }],
        tax_lines: [{ rate: 0.19, price: "7.44" }] },
      { title: "B", quantity: 1, price: "31.70", total_discount: "0.00",
        discount_allocations: [{ amount: "1.70", discount_application_index: 0 }],
        tax_lines: [{ rate: 0.19, price: "4.79" }] },
    ],
    shipping_lines: [],
  });
  const b = buildInvoice(o, S, { today: "2026-11-26" });
  assert.equal(b.prepaid_amount, 76.60);
  assert.equal(b3total(b), 76.60);
  assert.equal(b.lines.length, 2);
});

test("P2: mixed line discount plus code allocations are not double-counted", () => {
  // total_discount 2.00 (line) plus allocations 2.00 + 1.50 (line + code) => take 3.50, not 2.00 or 5.50
  const o = order({
    taxes_included: true, financial_status: "paid",
    total_price: "46.50", current_total_price: "46.50",
    line_items: [{
      title: "A", quantity: 1, price: "50.00", total_discount: "2.00",
      discount_allocations: [
        { amount: "2.00", discount_application_index: 0 },
        { amount: "1.50", discount_application_index: 1 },
      ],
      tax_lines: [{ rate: 0.19, price: "7.43" }],
    }],
    shipping_lines: [],
  });
  const b = buildInvoice(o, S, { today: "2026-11-26" });
  assert.equal(b.prepaid_amount, 46.50);
  assert.equal(b3total(b), 46.50);
});

test("P2: shipping discount_allocations are applied, and discounted_price is not double-counted", () => {
  const shipAlloc = {
    taxes_included: false, financial_status: "paid",
    total_price: "64.14", current_total_price: "64.14",
    line_items: [{ title: "W", quantity: 1, price: "50.00", total_discount: "0.00", tax_lines: [{ rate: 0.19, price: "9.50" }] }],
    shipping_lines: [{ title: "DHL", price: "5.90", discount_allocations: [{ amount: "2.00" }], tax_lines: [{ rate: 0.19, price: "0.74" }] }],
  };
  const b = buildInvoice(order(shipAlloc), S, { today: "2026-11-26" });
  const ship = b.lines.find((l) => /Shipping: DHL/.test(l.description));
  assert.ok(ship, JSON.stringify(b.lines));
  assert.equal(ship.unit_price, 3.9);
  assert.equal(b3total(b), 64.14);
  const already = order({
    ...shipAlloc,
    shipping_lines: [{ title: "DHL", price: "5.90", discounted_price: "3.90", discount_allocations: [{ amount: "2.00" }], tax_lines: [{ rate: 0.19, price: "0.74" }] }],
  });
  const b2 = buildInvoice(already, S, { today: "2026-11-26" });
  const ship2 = b2.lines.find((l) => /Shipping: DHL/.test(l.description));
  assert.equal(ship2.unit_price, 3.9);
  assert.equal(b3total(b2), 64.14);
});

test("P2: 100% discount code on a line yields unit_price 0", () => {
  const o = order({
    taxes_included: true, financial_status: "paid",
    total_price: "10.00", current_total_price: "10.00",
    line_items: [
      { title: "Gift", quantity: 2, price: "10.00", total_discount: "0.00",
        discount_allocations: [{ amount: "20.00", discount_application_index: 0 }],
        tax_lines: [{ rate: 0.19, price: "0.00" }] },
      { title: "Real", quantity: 1, price: "10.00", total_discount: "0.00",
        tax_lines: [{ rate: 0.19, price: "1.60" }] },
    ],
    shipping_lines: [],
  });
  const b = buildInvoice(o, S, { today: "2026-11-26" });
  const gift = b.lines.find((l) => l.description === "Gift");
  assert.ok(gift, JSON.stringify(b.lines));
  assert.equal(gift.unit_price, 0);
  assert.equal(b.prepaid_amount, 10);
  assert.equal(b3total(b), 10);
});
