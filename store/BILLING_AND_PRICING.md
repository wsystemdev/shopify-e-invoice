# Shopify billing and pricing (APPROVED 2026-11-22, Zifeng: three-ladder strategy, same price in every store)

## Plans (Shopify Billing API, appSubscriptionCreate; defaults in `DEFAULT_PLANS` in src/index.js, env BILLING_PLANS overrides, "[]" turns paid plans off)
| Plan | Shopify price (USD) | Yearly (pay 10, get 12) | Invoices/month | W System plan (units/month) |
|---|---|---|---|---|
| Free | $0 | | 25 | shop_free (300) |
| Shop | $13 / 30 days | $130 | 150 | shop (1,800) |
| Shop Plus | $32 / 30 days | $320 | 750 | shop_plus (9,000) |
| Shop Pro | $65 / 30 days | $650 | 2,000 | shop_pro (24,000) |
EUR reference prices everywhere else: €0 / €12 / €29 / €59 (yearly €120 / €290 / €590). 1 shop invoice = 12 units. Superseded draft (Free 50 / €19 / €49) removed.
Shopify net: 0% revenue share on the first USD 1M lifetime gross (from 1 Jan 2025), then 15%; plus 2.9% processing. Sources: shopify.dev/docs/apps/launch/distribution/revenue-share, /billing.

## How a subscription becomes a W System key (built 22 Nov)
1. The app admin loads -> `POST /api/billing/sync`. The Worker reads the shop's ACTIVE subscriptions from Shopify (`currentAppInstallation.activeSubscriptions`), maps the highest to a W System shop plan (none = shop_free).
2. It calls `POST https://api.wsystem.dev/billing/shopify/provision` with header `x-provision-secret` (Worker secret `WSYSTEM_PROVISION_SECRET` = Render env `SHOPIFY_PROVISION_SECRET`). One key per shop (api_keys.email = `shopify:<shop>`); repeat calls change plan/quota only. The key is stored encrypted in the shop settings (`api_key`, flag `api_key_managed`); the merchant never copies a key.
3. Upgrade/downgrade/cancel: webhook `app_subscriptions/update` (-> `/webhooks/app-subscriptions`) re-syncs; uninstall downgrades the managed key to shop_free.
4. A merchant who pastes their own W System key and has no subscription keeps it (no provisioning). Subscribing replaces it with the managed key.
5. At the unit limit the API answers 429 monthly_quota_exhausted; the app shows the error and the plan table.

## Open points
- Shopify App Pricing (managed, configured in the Partner Dashboard) is now the default for NEW apps; the Billing API is "legacy but supported". We use the Billing API so the plan->key mapping stays in our Worker. If the reviewer asks to move, plans map 1:1 and the sync step reads the same active subscriptions.
- `app_subscriptions/update` is declared in shopify.app.toml: needs `shopify app deploy` with the next submission (the Worker also registers it through the Admin API on first open).
- Currency: Shopify bills USD here; EUR is the reference everywhere else. Not verified whether EUR charges are allowed for this app.
