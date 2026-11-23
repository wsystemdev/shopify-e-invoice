# Shopify App Store listing: W System E-Invoice (prepared, NOT submitted)

Screenshots (1600x900, demo data): screenshot-1-en.png, screenshot-2-en.png, screenshot-1-de.png, screenshot-2-de.png.
Still needed from the Partner Dashboard: app icon 1200x1200 (use the W System logo), a short screencast (optional), and the review-instructions test account.

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
- Free for 50 invoices a month, then from $13 a month (billed through Shopify). Your W System key is set up automatically
- English and German
**Pricing:** Free: 50 e-invoices a month. Shop: $13 a month for 150. Shop Plus: $32 a month for 750. Shop Pro: $65 a month for 2,000. Annual billing: pay 10 months, get 12 ($130, $320, $650 a year). Same price in every store. Billed through Shopify in USD.
**Search terms:** xrechnung, e-rechnung, e-invoice, en 16931, peppol
**Support:** hello@wsystem.dev, https://wsystem.dev/support
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
**Preis:** Kostenlos: 50 E-Rechnungen im Monat. Shop: 13 $ im Monat für 150. Shop Plus: 32 $ im Monat für 750. Shop Pro: 65 $ im Monat für 2.000. Jahreszahlung: 10 Monate zahlen, 12 erhalten (130 $, 320 $, 650 $ pro Jahr). Gleicher Preis in jedem Shop. Abrechnung über Shopify in USD.
**Grenzen:** keine ZUGFeRD-PDFs, noch keine Gutschriften für Erstattungen, keine Trinkgelder oder Geschenkgutscheine; keine Steuer- oder Rechtsberatung.

## Fees, contracts and review requirements (for Zifeng; fees checked on shopify.dev 21 Nov 2026)
- Partner / Dev Dashboard account: free. **App Store registration: one-time US$19 per Partner account** (needed for the reduced revenue share; waived only for accounts created before 1 Aug 2021). Needs his OK to pay.
- Revenue share: 0% on the first US$1M lifetime gross app revenue (since 1 Jan 2025), 15% above; 2.9% processing fee on anything billed through Shopify. All app charges are billed through Shopify (managed App Pricing), so the normal Shopify revenue share applies.
- Accepting the Shopify Partner Program Agreement and API terms is a contract: needs his OK.
- Protected customer data access (name, address, email on orders) must be requested in the Partner Dashboard and is reviewed by Shopify.
- Review checks: GDPR webhooks (done), session-token auth (done), a test store and instructions for the reviewer.

## Screenshots to capture (1600x900, dev store wsystem-einvoice-dev, Browser Ops)
1. App settings page (seller data filled, key masked).
2. Recent e-invoices list showing Valid rows with Download XML.
3. An order in the Shopify admin with the tag e-invoice-valid.
4. The downloaded XRechnung XML opened in a viewer (shows CustomizationID urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0).
5. A failed validation row with its fix hint (optional, shows the checking).
Current demo-data images exist in this folder (screenshot-1/2-en/de.png) and can be used as a fallback.

## Listing fields summary
Support email: hello@wsystem.dev. Privacy: https://wsystem.dev/privacy. Terms: https://wsystem.dev/terms. Public name everywhere: W System.
