# Post-approval changes: ZUGFeRD PDF + credit notes (B253). NOT applied. Do nothing here while the app is in review.

State of the code (Worker only, committed, backward compatible): `zugferd` and `credit_notes` are per-shop settings, both default "no". With both off the app behaves exactly like the reviewed version. The `/webhooks/refunds-create` handler exists but nothing delivers to it yet.

## 1. shopify.app.toml: add one webhook subscription (needs `shopify app deploy` = a new app version)
```toml
  [[webhooks.subscriptions]]
  topics = ["refunds/create"]
  uri = "/webhooks/refunds-create"
```
Scopes: refunds/create needs read_orders, already granted. No new scope, no new protected customer data field.
(Alternative without a toml change: subscribe through the Admin GraphQL API in `ensureWebhooks` by adding `["REFUNDS_CREATE", "/webhooks/refunds-create"]` to WEBHOOKS. Do it only for shops with credit_notes = yes, and only after approval.)

## 2. Worker (wrangler deploy)
WARNING: wrangler.toml is incomplete. The live Worker also has the BACKUP kv binding, APP_HANDLE var and the 02:17 cron, deployed via the Cloudflare API (see comment in wrangler.toml). A plain `wrangler deploy` could drop them. Add them to wrangler.toml first (or deploy through the Cloudflare API as before), then deploy the committed Worker code. Free-tier text (25 -> 50) is owned by another worker; deploy from a tree that includes the intended state of that change.

## 3. Settings page
Add a "Credit notes for refunds (beta)" Yes/No select (`credit_notes`) next to the ZUGFeRD select in src/admin.js, with EN and DE labels. (The ZUGFeRD select is already in the Worker-served settings page.)

## 4. Listing text (Partner Dashboard > Distribution > Listing; may trigger re-review)
- EN "Limits stated honestly" line 27 in listing/LISTING.md and line 70 in SUBMIT_PACKET.md: replace "no ZUGFeRD PDF, no credit notes for refunds yet, no tips or gift cards; not tax or legal advice." with "creates XRechnung XML or a ZUGFeRD / Factur-X PDF; credit notes for refunds (type 381); no tips or gift cards; not tax or legal advice."
- DE line 46 / line 90: "Grenzen: keine Trinkgelder oder Geschenkgutscheine; keine Steuer- oder Rechtsberatung. Erstellt XRechnung (XML) oder ZUGFeRD / Factur-X (PDF); Gutschriften für Erstattungen (Typ 381)."
- Feature list / demo text: add "ZUGFeRD / Factur-X PDF" and "Credit notes on refunds".
- Data protection answers (store/DATA_PROTECTION.md): the refund payload contains no new personal data fields; state that refund data (amounts, line items) is processed to create the credit note.
- Screenshots: add a settings screenshot showing the two new selects.

## 5. App version
`shopify app deploy` with the toml change creates a new app version (name e.g. `credit-notes-1`) and releases it. Do this only after the current review is approved. Then smoke-test on a dev store: refund an order that already has a valid e-invoice, check the credit note record and PDF download.

## 6. Verification still missing (no Shopify dev store available on the box)
- The refunds/create payload shape (`refund_line_items[].subtotal`, `total_tax`, `order_adjustments[].kind = shipping_refund`) is implemented from Shopify's documented REST webhook shape and unit-tested, not against a live Shopify delivery.
- Credit-note JSON was checked against the real W System API logic (local): valid EN 16931 CII for zugferd and valid XRechnung UBL.
