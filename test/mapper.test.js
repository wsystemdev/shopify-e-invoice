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
