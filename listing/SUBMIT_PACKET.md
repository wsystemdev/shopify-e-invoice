# Shopify App Store submit packet: W System E-Invoice (READY, NOT SUBMITTED)
For Browser Ops. Paste text exactly; do not edit prices. Public name everywhere: **W System**. Never show zifengw@. Never paste secrets.

## 0. Before you start
- Dev Dashboard app: https://dev.shopify.com/dashboard/249174792/apps/450387968001 (distribution: Public / Shopify App Store; $19 registration is paid; listing is a Draft).
- Active app version: `compliance-1` (released 22 Nov 03:00; contains the three privacy webhooks, orders/create, orders/paid, app/uninstalled). The Worker serves everything at https://wsystem.dev/shopify.
- Billing (WS-14) is NOT final: do not submit until WS-14 reports that the plans below are live and a test subscription works. If Shopify asks why a paid plan exists in a "free" app, the plans below are the answer.

## 1. Protected customer data: Data protection details (16 answers)
Dev Dashboard > Apps > W System E-Invoice > Settings > Access requests > Protected customer data > Manage. Select **Customer data** and the fields **Name, Address, Email** (not Phone). Reason to paste for all fields: "Required fields of the e-invoice (XRechnung / EN 16931): buyer name, postal address and email are mandatory parts of the invoice. Nothing else is read." Then Data protection details. The exact question wording may differ; match by topic, in this order:

1. **Why does the app need protected customer data, and is it the minimum?** To create a legally valid e-invoice (XRechnung / EN 16931) the buyer's name, company, postal address, VAT ID and contact email are mandatory fields of the standard. Nothing else is read: no phone, no marketing data, no customer lists, no analytics.

2. **Which fields, and why each?** Name (buyer name/contact, BT-44/BT-56), address (buyer postal address, BG-8), email (buyer electronic address, BT-49), company and VAT ID from order attributes (BT-44, BT-48). Phone is not used.

3. **Is customer data used for anything other than the stated purpose (marketing, profiling, selling, AI training)?** No. It is used only to generate the merchant's invoice. It is not sold, shared for marketing, or used to train models.

4. **Do you inform merchants and customers about the processing, and where is your privacy policy?** The app listing, the admin page and https://wsystem.dev/privacy describe it; the merchant is the controller and W System the processor. A data processing agreement is available at https://wsystem.dev/legal/dpa (DPA §9.3 covers e-invoicing). Merchants are told in the admin page that order data is sent to the W System API.

5. **Do you honour customers' consent and opt-outs / marketing preferences?** The app does no marketing and sends no messages to customers, so consent for marketing does not apply. The optional email copy goes only to the merchant's own address and is off by default.

6. **Do you have a data retention period, and is data deleted when no longer needed?** Yes: 400 days automatic expiry of invoice records (German invoice retention is a merchant duty; the merchant keeps their own originals in their books). Shop data is deleted on `shop/redact`.

7. **Do you act on customer data erasure/access requests and the mandatory webhooks?** Yes: `customers/redact`, `shop/redact`, `customers/data_request` are implemented and tested. For a data request the invoice records are available to the merchant in the app; the request is logged for the merchant. `customers/data_request` now auto-exports: the stored invoice records (including XML) for the requested orders are copied to a data-request record the merchant can read in the app (`/api/data-requests`) and hand to the customer. Still open: there is no automatic email to the merchant; the answer should say the merchant is notified through Shopify's own data-request flow and finds the export in the app.

8. **Is data encrypted in transit?** Yes: HTTPS/TLS everywhere (Shopify to Worker, Worker to Shopify and to api.wsystem.dev, Cloudflare edge with HSTS).

9. **Is data encrypted at rest?** Cloudflare KV is encrypted at rest by Cloudflare. Tokens and API keys are additionally AES-GCM encrypted at application level. The invoice XML itself is not additionally encrypted at application level; it relies on the provider's encryption at rest.

10. **Are test and production data separated, and is real customer data used in development/testing?** Development uses a Shopify development store with fake orders only. Production uses the one Worker and KV namespace; no production data is copied to dev.

11. **Do you have backups, and are they protected / deleted with the data?** No separate backups of customer data are made. KV is managed by Cloudflare. Expiry and redact deletions therefore apply everywhere.

12. **Who can access protected customer data (staff access limited)?** Only the single operator of the W System Cloudflare account, protected by 2FA. No other staff or contractors have access. The W System API processes the order data transiently; The API does not log request bodies (access logs hold URL and status only). 

13. **Strong passwords for staff accounts?** Yes: the Cloudflare, GitHub and Shopify Partner accounts use vault-generated unique passwords with 2FA/TOTP.

14. **Do you keep an access log of customer data access and review it?** Yes, partially: the Worker writes a per-record access log (action + order id, 90 days). There is no scheduled human review yet; answer "logged, reviewed on incident or on request", not "reviewed weekly".

15. **Data loss prevention strategy?** Minimal data collected, single storage location, secrets only in Worker secrets (never in code or logs), session-token authenticated admin API, HMAC-verified webhooks, download links with an unguessable HMAC token and only for valid invoices, no public listing endpoints, automatic expiry.

16. **Security incident response policy?** Yes: W System has a written incident response plan with severity levels, roles, escalation, evidence handling and merchant/authority notification within 72 hours where GDPR requires.

(Honesty note, keep as answered: invoice XML relies on Cloudflare encryption at rest plus encrypted tokens/keys; access log exists but has no scheduled review.)

## 2. Listing fields
App-level settings in Dev Dashboard > Distribution > Manage listing. Primary language English; add German as a second language. Support email hello@wsystem.dev, privacy https://wsystem.dev/privacy, terms https://wsystem.dev/terms (use as "Terms of use / EULA" link if asked).

## English
**App name (max 30):** W System E-Invoice
**Tagline (max 62):** XRechnung and EN 16931 e-invoices from your orders
**Introduction (max 100):** Create validated XRechnung 3.0 e-invoices for German B2B orders, automatically.
**Description:**
From 1 January 2027 German businesses with more than EUR 800,000 turnover must send e-invoices for domestic B2B sales, and from 1 January 2028 all businesses must. A PDF is no longer enough.
W System E-Invoice creates a structured e-invoice for each order and checks it before you use it.
**Feature bullets:**
- XRechnung 3.0 (UBL), EN 16931 or Peppol BIS Billing 3.0 from every order
- Validated against the XML Schema, EN 16931 and KoSIT XRechnung rules; errors come with a fix hint
- Created automatically when an order is paid or created, or manually
- Download link on the order (tag and metafield) and a list of recent invoices in the app
- Several VAT rates, discounts, shipping, bank transfer with IBAN, intra-EU reverse charge, exports, small business scheme (section 19 UStG)
- Leitweg-ID per order for public-sector buyers
- Free for 25 invoices a month, then from €12 (billed through Shopify). Your W System key is set up automatically
- English and German
**Pricing:** Free: 25 e-invoices a month. Shop: EUR 12 a month for 150. Shop Plus: EUR 29 a month for 750. Shop Pro: EUR 59 a month for 2,000. Annual billing: pay 10 months, get 12 (EUR 120, 290, 590 a year). Same price in every store. Billed through Shopify.
**Search terms:** xrechnung, e-rechnung, e-invoice, en 16931, peppol
**Support:** hello@wsystem.dev, https://wsystem.dev/shopify-xrechnung
**Privacy policy:** https://wsystem.dev/privacy   **Terms:** https://wsystem.dev/terms
**Scope (state honestly in the listing):** built for business-to-business (B2B) orders. Consumer (B2C) orders do not need an e-invoice in Germany; use "Only for business customers". The customer VAT ID and Leitweg-ID must be collected as order attributes (checkout field or app).
**Limits stated honestly:** no ZUGFeRD PDF, no credit notes for refunds yet, no tips or gift cards; not tax or legal advice.


## Deutsch
**App-Name:** W System E-Rechnung
**Tagline:** XRechnung und EN 16931 direkt aus Ihren Bestellungen
**Einführung:** Erstellen Sie automatisch geprüfte XRechnungen für Ihre deutschen B2B-Bestellungen.
**Beschreibung:**
Ab 1. Januar 2027 müssen Unternehmen mit mehr als 800.000 € Vorjahresumsatz inländische B2B-Rechnungen als E-Rechnung ausstellen, ab 1. Januar 2028 alle Unternehmen. Ein PDF reicht nicht mehr.
W System E-Rechnung erstellt zu jeder Bestellung eine strukturierte E-Rechnung und prüft sie, bevor Sie sie verwenden.
**Funktionen:**
- XRechnung 3.0 (UBL), EN 16931 oder Peppol BIS Billing 3.0 aus jeder Bestellung
- Geprüft gegen XML-Schema, EN-16931- und KoSIT-XRechnung-Regeln; Fehler mit Korrekturhinweis
- Automatisch bei Zahlung oder Anlage der Bestellung, oder manuell
- Download-Link an der Bestellung (Tag und Metafeld) und Liste der letzten Rechnungen in der App
- Mehrere Steuersätze, Rabatte, Versand, Überweisung mit IBAN, innergemeinschaftliche Lieferung (Reverse Charge), Export, Kleinunternehmer (§ 19 UStG)
- Leitweg-ID je Bestellung für öffentliche Auftraggeber
- Ohne Konto nutzbar (20 Rechnungen pro Tag); kostenloser API-Schlüssel mit 500 Einheiten im Monat
- Deutsch und Englisch
**Preis:** Kostenlos: 25 E-Rechnungen im Monat. Shop: 12 € im Monat für 150. Shop Plus: 29 € im Monat für 750. Shop Pro: 59 € im Monat für 2.000. Jahreszahlung: 10 Monate zahlen, 12 erhalten (120 €, 290 €, 590 € pro Jahr). Gleicher Preis in jedem Shop. Abrechnung über Shopify.
**Grenzen:** keine ZUGFeRD-PDFs, noch keine Gutschriften für Erstattungen, keine Trinkgelder oder Geschenkgutscheine; keine Steuer- oder Rechtsberatung.


App icon: 1200x1200 W System logo (upload from /workspace/site if available; ask me if missing). Categories: Orders and shipping > Invoicing (or Finances > Accounting, whichever Shopify offers). Demo store URL: https://wsystem-einvoice-dev.myshopify.com.

## 3. Screenshots (upload in this order, 1600x900, all in listing/screens/)
1. 01-settings.png  (settings page; Sidekick bar cropped out)
2. 02-recent-einvoices.png  (list with Valid rows and downloads)
3. 03-order-1011-tag.png  (order with the e-invoice-valid tag; Sidekick cropped out)
4. 04-1011-xml.png  (generated XRechnung XML)
Alt texts: 1 "App settings with seller data and format", 2 "Recent e-invoices with validation status and XML download", 3 "Order tagged e-invoice-valid", 4 "Generated XRechnung 3.0 file".

## 4. Pricing (same price in every store; currency EUR; set in the listing's Pricing section, matching the app's Billing API plans)
| Plan | Monthly | Annual (10 months for 12) | Included invoices per month |
|---|---|---|---|
| Free | 0 | n/a | 25 |
| Shop | 12.00 | 120.00 | 150 |
| Shop Plus | 29.00 | 290.00 | 750 |
| Shop Pro | 59.00 | 590.00 | 2,000 |
Plan descriptions: "Up to N e-invoices a month, validated against XRechnung and EN 16931 rules." Do not add free trials. Pricing is approved by Zifeng (t-approval in the parent chat), do not change.

## 5. Instructions for Shopify reviewers (paste into "Testing instructions")
1. Install the app on your test store. Open it from Apps. No account or login is needed.
2. Optional: get a free W System API key at https://api.wsystem.dev/account/free-key (email only, no card; 500 units, enough for about 60 test invoices) and paste it in "W System API key". Without a key the free daily tier of the API (20 calls) also works.
3. Fill seller details (company, address, contact name, phone, email, VAT ID, IBAN). Example valid data: Muster GmbH, Musterstraße 1, 10115 Berlin, DE, Max Muster, +49 30 1234567, any email, VAT ID DE123456788.
4. Create a test order with a billing address in Germany and a company name, mark it as paid (Orders > order > Mark as paid). With "When the order is paid" selected, the app creates the e-invoice within seconds. The order gets the tag e-invoice-valid and the app list shows the invoice with a Download XML link.
5. To test B2B cases add the order attribute "VAT ID" (e.g. FR12345678901 for an order to France: reverse charge) or "Leitweg-ID" (e.g. 04011000-1234512345-35).
6. You can also create an invoice manually: in the app enter the order number (for example 1001) and click Create.
7. Data deletion: uninstalling deletes the access token; Shopify's shop/redact and customers/redact webhooks delete stored invoices.
Dev store for our own demo (read only for reviewers, optional): https://wsystem-einvoice-dev.myshopify.com. No password is shared; reviewers use their own store. A dedicated reviewer API key with a bigger quota would be a unit grant and needs Zifeng's OK: not created.

## 6. Exact submit steps (Browser Ops)
1. Confirm with the requester that WS-14 billing is live (plans exist and test subscription works).
2. Dev Dashboard > app > Settings > Access requests > Protected customer data: select Customer data, apply reason; fields Name, Address, Email, apply reason; fill Data protection details (section 1); Save.
3. Dev Dashboard > app > Distribution: choose Public distribution if not already; open Manage listing.
4. Fill listing fields (section 2) in English, then add German; upload icon and the four screenshots in order (section 3); enter pricing (section 4); paste testing instructions (section 5); set support email/URLs.
5. Check the automated checks panel (App Store requirements): expect webhooks, session token auth, and app URL passing. Report any failing check with its text; do not work around it.
6. Review all fields once, then STOP and report "ready to submit" to the requester. Click Submit for review only after the requester confirms (the owner has not yet said to submit).
7. After submission, report the confirmation text and any "protected customer data review" notice.
