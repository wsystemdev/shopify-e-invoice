# W System E-Invoice for Shopify

Creates validated **XRechnung 3.0 (UBL)**, **EN 16931** and **Peppol BIS Billing 3.0** e-invoices from Shopify orders through the [W System API](https://api.wsystem.dev). Same features as the [WooCommerce plugin](https://github.com/wsystemdev/woo-e-invoice).

Germany: since 1 Jan 2025 every business must be able to receive e-invoices; from 1 Jan 2027 businesses with more than EUR 800,000 turnover must send them for domestic B2B sales, from 1 Jan 2028 all businesses.

## Features
- Created automatically on `orders/paid` or `orders/create` (or manually from the admin page).
- Every invoice is validated (XML Schema, EN 16931 Schematron, KoSIT XRechnung rules). Errors are listed with the fix.
- Admin page (embedded app): API key (optional), seller data, format, trigger, B2B only, small business scheme (section 19 UStG), IBAN, default buyer reference (Leitweg-ID), VAT ID attribute names. English and German.
- Per order: order attribute `Leitweg-ID` (buyer reference) and `VAT ID` (customer VAT ID, enables intra-EU reverse charge).
- Handles several VAT rates, tax-inclusive and tax-exclusive shops, discounts, shipping, paid orders, bank transfer, exports outside the EU.
- Download link: the order gets the tag `e-invoice-valid` (or `e-invoice-failed`) and the metafield `wsystem.einvoice_url`; use it in notification templates, e.g. `{{ order.metafields.wsystem.einvoice_url }}`. The admin page also lists recent invoices with download links.
- Optional: email a copy of each valid XML to the seller address.
- GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) and `app/uninstalled` are handled.

Shopify cannot attach files to its own notification emails, so the customer gets the link above instead of an attachment.

## Architecture
A single Cloudflare Worker (free tier) plus one KV namespace. OAuth 2.0 token exchange with App Bridge session tokens (Shopify managed installation). Settings and the access token are stored encrypted (AES-GCM). Invoices are kept 400 days, then expire. No order data is stored besides the invoice XML and its validation result.

## Develop
```
npm install
npm test                # 20 unit tests, no network
wrangler kv namespace create STORE   # paste the id into wrangler.toml
wrangler secret put SHOPIFY_API_KEY
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put ENC_KEY          # 32+ random characters
wrangler deploy
# set APP_URL in wrangler.toml and shopify.app.toml to the Worker URL, then
shopify app deploy
```
Protected customer data: the app reads customer name, address and email from orders. Request protected customer data access (levels 1 and 2) in the Partner Dashboard.

## Beta options (both OFF by default)
- `zugferd` = yes: the app asks the W System API for `format: zugferd` (ZUGFeRD 2.3 / Factur-X EN 16931, PDF/A-3b with the XML embedded) instead of XML only. The PDF is stored with the invoice and downloads with `?f=pdf` on the invoice link. Not available together with the Peppol BIS format. Shown in the settings page as a Yes/No select.
- `credit_notes` = yes: a `refunds/create` webhook creates a credit note (type 381, referencing the original invoice number and date, refunded items and shipping at the original VAT rates). Only for orders that already have a valid e-invoice. The Worker code is in place (`POST /webhooks/refunds-create`), but the webhook topic is not subscribed until the app version that adds it is approved, so the setting has no effect yet and has no settings-page control yet. See `listing/POST_APPROVAL_ZUGFERD_CREDIT_NOTES.md`.

## Not included
No tips or gift-card handling; credit notes are not live yet (see above). Not tax or legal advice.

MIT licence. Operated by W System, https://wsystem.dev.
