# Changelog

## 1.0.2

- Discount codes that only appear in `discount_allocations` (with `total_discount` left at 0.00) are applied on the webhook path and on GraphQL `/api/create` (`findOrder`). A paid order's prepaid amount then matches the e-invoice total (payable 0).
- Allocations already include any line discount also reported in `total_discount`, so the two are not added together.
- `findOrder` / `allLineItems` now request `discountAllocations { allocatedAmountSet }` on line items and shipping lines.

## 1.0.1

- Per-rate reconcile of Shopify's per-line tax rounding (net shift within 3 cents, otherwise `vat_amounts`) so the e-invoice total equals the order total, for invoices and refund credit notes.
