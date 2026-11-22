# Shopify billing: status and pricing draft (NO prices set, needs Zifeng's OK)

## Status
- The Worker supports Shopify's Billing API (`appSubscriptionCreate`, endpoints `/api/billing` and `/api/billing/subscribe`). It is OFF: plans come from the env var `BILLING_PLANS` (JSON array of `{id,name,price,currency}`), which is empty. `BILLING_TEST=1` makes test charges. Nothing is charged today; the app is free to install and the merchant uses their own W System API key.
- Risk: Shopify requires app charges to go through its Billing API. A free app that only talks to a separately paid external API is a grey area; reviewers may ask. If rejected, we turn on a paid plan below. A paid plan also needs a build step: when a subscription is confirmed, the Worker must create/upgrade a W System API key for that shop (not built yet).

## Pricing suggestion (draft only)
Existing W System API: free key 500 units/month (one e-invoice = 8 units, about 60 invoices); Starter EUR 19 = 5,000 units (625 invoices); Pro EUR 49 = 25,000 units (3,125 invoices).
| Shopify plan | Price | Includes |
|---|---|---|
| Free | EUR 0 | Up to 50 e-invoices a month (own free key: about 60) |
| Standard | EUR 19 / 30 days | up to 600 e-invoices |
| Plus | EUR 49 / 30 days | up to 3,000 e-invoices |
Shopify keeps 0% revenue share on the first USD 1M lifetime, plus 2.9% processing, so net is about 97%. Option: add a 7-day free trial on paid plans. Compare: competing German e-invoice apps charge roughly EUR 10 to 40 a month. Not set anywhere; price changes need Zifeng's OK.

## Business model notes (for his question)
- The plugins are a free funnel: each install puts the W System API in front of a merchant with a legal deadline (1 Jan 2027 for large sellers, 1 Jan 2028 for all). Revenue comes from API units (free key, then Starter/Pro) and Peppol sending, not from the plugin.
- Most Shopify and Woo merchants are small B2C shops with few B2B orders. Expect low volume per merchant, so the free tier will cover many; the money is in merchants with regular B2B orders (a few hundred invoices a month) and in agencies installing it for several shops.
- Individual companies: the buyer is the shop owner, not a developer. Landing pages already lead with outcome (deadline, XRechnung); keep the plugin pages as the main entry, make the free key one click, and show invoices-per-month and the price in the same place. No new site structure needed beyond a pricing line for platform plugins and the Shopify page flag switch on approval.
