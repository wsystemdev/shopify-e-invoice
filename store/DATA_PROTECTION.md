# Shopify "Data protection details" (protected customer data, level 1 + 2): draft answers

Status: DRAFT for Zifeng's review. Not submitted. I could not open the Dev Dashboard form, so the answers follow the topics of Shopify's published level 1 and level 2 requirements (shopify.dev/docs/apps/launch/protected-customer-data) and may need to be pasted against the exact 16 question texts. Items marked **GAP** are not fully true today: fix them or answer "no" honestly before submitting.

## What the app actually does with customer data
- Receives `orders/paid` / `orders/create` webhooks (and reads one order on manual create). Fields used: billing name, company, address, email, order lines/amounts/taxes, order attributes (VAT ID, Leitweg-ID).
- Sends them to the W System API (api.wsystem.dev, POST /einvoice/create) to build and validate the e-invoice XML. The API returns the XML and result.
- Stores per order in Cloudflare KV: invoice number, order number, validation result and errors, and the XML (which contains the buyer's name, address, email, VAT ID). The order webhook payload itself is not stored. Stored only when validation passed (failed invoices keep error rules, no XML).
- Per shop: Shopify access token and the merchant's API key (both AES-GCM encrypted with a secret held only as a Worker secret) and the merchant's settings (seller data).
- Retention: invoice records expire automatically after 400 days (KV expiration). Data-request records expire after 400 days.
- Deletion: `customers/redact` deletes the listed orders' invoice records; `shop/redact` deletes all keys of the shop (invoices, settings, token, data-request records); `app/uninstalled` removes the access token. All webhooks verify Shopify's HMAC.
- Writes only a tag and a metafield (download URL) back to the order.

## Answers

1. **Why does the app need protected customer data, and is it the minimum?** To create a legally valid e-invoice (XRechnung / EN 16931) the buyer's name, company, postal address, VAT ID and contact email are mandatory fields of the standard. Nothing else is read: no phone, no marketing data, no customer lists, no analytics.
2. **Which fields, and why each?** Name (buyer name/contact, BT-44/BT-56), address (buyer postal address, BG-8), email (buyer electronic address, BT-49), company and VAT ID from order attributes (BT-44, BT-48). Phone is not used.
3. **Is customer data used for anything other than the stated purpose (marketing, profiling, selling, AI training)?** No. It is used only to generate the merchant's invoice. It is not sold, shared for marketing, or used to train models.
4. **Do you inform merchants and customers about the processing, and where is your privacy policy?** The app listing, the admin page and https://wsystem.dev/privacy describe it; the merchant is the controller and W System the processor. A data processing agreement is available at https://wsystem.dev/legal/dpa (DPA §9.3 covers e-invoicing). Merchants are told in the admin page that order data is sent to the W System API.
5. **Do you honour customers' consent and opt-outs / marketing preferences?** The app does no marketing and sends no messages to customers, so consent for marketing does not apply. The optional email copy goes only to the merchant's own address and is off by default.
6. **Do you have a data retention period, and is data deleted when no longer needed?** Yes: 400 days automatic expiry of invoice records (German invoice retention is a merchant duty; the merchant keeps their own originals in their books). Shop data is deleted on `shop/redact`.
7. **Do you act on customer data erasure/access requests and the mandatory webhooks?** Yes: `customers/redact`, `shop/redact`, `customers/data_request` are implemented and tested. For a data request the invoice records are available to the merchant in the app; the request is logged for the merchant. **GAP:** `customers/data_request` is logged, not auto-exported; the answer should state that data is supplied to the merchant on request within the legal period.
8. **Is data encrypted in transit?** Yes: HTTPS/TLS everywhere (Shopify to Worker, Worker to Shopify and to api.wsystem.dev, Cloudflare edge with HSTS).
9. **Is data encrypted at rest?** Cloudflare KV is encrypted at rest by Cloudflare. Tokens and API keys are additionally AES-GCM encrypted at application level. **GAP:** the invoice XML itself is not additionally application-encrypted (it relies on KV encryption at rest). Say so, or add field encryption before submission.
10. **Are test and production data separated, and is real customer data used in development/testing?** Development uses a Shopify development store with fake orders only. Production uses the one Worker and KV namespace; no production data is copied to dev.
11. **Do you have backups, and are they protected / deleted with the data?** No separate backups of customer data are made. KV is managed by Cloudflare. Expiry and redact deletions therefore apply everywhere.
12. **Who can access protected customer data (staff access limited)?** Only the single operator of the W System Cloudflare account, protected by 2FA. No other staff or contractors have access. The W System API processes the order data transiently and does not log request bodies (**verify before answering**).
13. **Strong passwords for staff accounts?** Yes: the Cloudflare, GitHub and Shopify Partner accounts use vault-generated unique passwords with 2FA/TOTP.
14. **Do you keep an access log of customer data access and review it?** **GAP:** Cloudflare account audit logs record administrative access, but there is no per-record access log or scheduled review for KV reads. Answer honestly ("partially") or add logging of reads in the Worker before submission.
15. **Data loss prevention strategy?** Minimal data collected, single storage location, secrets only in Worker secrets (never in code or logs), session-token authenticated admin API, HMAC-verified webhooks, download links with an unguessable HMAC token and only for valid invoices, no public listing endpoints, automatic expiry.
16. **Security incident response policy?** Yes: W System has a written incident response plan (`/workspace/integrations/INCIDENT_RESPONSE_PLAN.md`) with severity levels, roles, escalation, evidence handling and merchant/authority notification within 72 hours where GDPR requires. **GAP:** confirm the plan is the one W System wants to cite publicly and that it names the Shopify contact step.

## Where data is processed
Cloudflare (Worker and KV, global edge, EU/US) and the W System API (Render, EU). Sub-processors are listed at https://wsystem.dev/legal/dpa.

## Before submitting
Fix or soften the three GAP items (7, 9, 14, plus the 16 wording), verify item 12 (no body logging), and request the specific protected fields (name, address, email) with the reasons above in the Dev Dashboard: Apps, the app, Settings, Access requests, Protected customer data.
