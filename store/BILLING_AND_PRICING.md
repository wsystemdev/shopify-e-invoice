# Shopify billing and pricing (APPROVED 2026-11-22, Zifeng: three-ladder strategy; switched to Shopify managed App Pricing 22 Nov)

## Plans (Shopify managed App Pricing, created in the Partner Dashboard pricing page; one plan carries monthly and yearly prices)
| Plan name | Handle | Monthly (USD) | Yearly (pay 10, get 12) | Invoices/month | W System plan (units/month) |
|---|---|---|---|---|---|
| Free | `free` | $0 | none | 50 | shop_free (600) |
| Shop | `shop` | $13 | $130 | 150 | shop (1,800) |
| Shop Plus | `shop-plus` | $32 | $320 | 750 | shop_plus (9,000) |
| Shop Pro | `shop-pro` | $65 | $650 | 2,000 | shop_pro (24,000) |
1 shop invoice = 12 units. The app code only knows the plan names/handles above (`DEFAULT_PLANS`, `matchPlan` in src/index.js; match by handle or slug of the name). Keep them identical in the Partner Dashboard. The site shows EUR reference prices (12/29/59, yearly 120/290/590); Shopify bills in USD.
Redirect URL for the plans: the embedded app root `/` (Shopify appends `plan_handle`; the Worker maps `/` + `shop` to `/app`).
Shopify net: 0% revenue share on the first USD 1M lifetime gross, then 15%; plus 2.9% processing. Sources: shopify.dev/docs/apps/launch/distribution/revenue-share.

## Flow
1. "Choose a plan" in the app opens Shopify's hosted page `https://admin.shopify.com/store/{store}/charges/{APP_HANDLE}/pricing_plans` (APP_HANDLE = `w-system-e-invoice`, Worker var). There is no appSubscriptionCreate call.
2. Every app load runs `POST /api/billing/sync`: the Worker reads `currentAppInstallation.activeSubscriptions` (Admin API; verified on wsystem-einvoice-test, the managed subscription is listed), maps the name/handle to a W System shop plan (none = shop_free) and calls `POST https://api.wsystem.dev/billing/shopify/provision` (header `x-provision-secret`). One key per shop (api_keys.email = `shopify:<shop>`); repeat calls change plan/quota only. The key is stored encrypted in the shop settings (`api_key`, flag `api_key_managed`).
3. Since 28 Apr 2026 Shopify no longer sends `APP_SUBSCRIPTIONS_UPDATE` for managed pricing and no `charge_id` on return, so the on-load sync is the source of truth (the webhook handler stays as a harmless extra). Uninstall downgrades the managed key to shop_free.
4. A merchant who pastes their own W System key and has no subscription keeps it. Subscribing replaces it with the managed key.
5. At the unit limit the API answers 429 monthly_quota_exhausted; the app shows the error and the plan table.

## Notes
- Dev stores in the same Partner org get managed plans at $0 (no Billing API test flag). The Admin API shows `test: false` for those; that is normal.
- Currency: Shopify bills USD; EUR is the reference on the website.
- If the Admin API ever stops listing managed subscriptions, switch the sync to the Partner API `activeSubscription` (needs a Partner API client).
