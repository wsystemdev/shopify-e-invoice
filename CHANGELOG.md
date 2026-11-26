# Changelog

## 1.0.3

- When Shopify leaves `tax_lines` at the tax on the undiscounted price (the line or order tax matches tax on the original price, not on the discounted price), net is recomputed from the discounted gross at the line's rate(s). `tax_lines` that are already post-discount are left unchanged, so Shopify's charged VAT is still used for reconcile / `vat_amounts`.
- Post-discount stacked taxes (e.g. 6 % + 1 % on the same discounted net) are no longer mis-detected as pre-discount / split, which had sent a tax-excluded 189.85 order out as 183.65 (payable −6.20).
- A paid discounted order then has payable 0.00, including the real #1016 shape (pre-discount `tax_lines` 7.97 + 1.69 + 0.94, `current_total_tax` 10.60, allocations 3.30 + 1.70, DHL 5.90, shop total 76.60).

## 1.0.2

- Discount codes that only appear in `discount_allocations` (with `total_discount` left at 0.00) are applied on the webhook path and on GraphQL `/api/create` (`findOrder`). A paid order's prepaid amount then matches the e-invoice total (payable 0).
- Allocations already include any line discount also reported in `total_discount`, so the two are not added together.
- `findOrder` / `allLineItems` now request `discountAllocations { allocatedAmountSet }` on line items and shipping lines.

## 1.0.1

- Per-rate reconcile of Shopify's per-line tax rounding (net shift within 3 cents, otherwise `vat_amounts`) so the e-invoice total equals the order total, for invoices and refund credit notes.
