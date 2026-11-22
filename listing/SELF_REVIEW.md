# Shopify App Store AI self-review (manual, 22 Nov 2026)
The Shopify AI Toolkit skill `shopify-app-store-review` is deprecated (merged into `shopify`) and runs inside an agent host, not headless. Equivalent manual pass against https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements (conditional groups 5.x skipped: no theme/payment/checkout/sales-channel extensions).

| Req | Result | Note |
|---|---|---|
| 1.1.1 session tokens | Pass | App Bridge script + JWT session tokens (verifySessionToken); no cookies/localStorage |
| 1.1.2-1.1.16 | Pass / n.a. | No checkout, themes, payments, POS, refunds, lending, product copy |
| 1.1.4 factual info | Pass | No generated data; listing text should keep claims to what the app does |
| 1.2.1-1.2.3 billing | Pass (verify live) | Shopify managed App Pricing, hosted plan page, in-app change/cancel via Shopify; on-load sync. Needs the 4 plans live in Partner Dashboard |
| 2.2.1 Shopify APIs | Pass | Admin GraphQL, webhooks |
| 2.2.3 App Bridge | Pass | app-bridge.js script tag in head, first script |
| 2.2.4 GraphQL only | **Was failing, fixed** | REST `/orders.json` lookup and `PUT /orders/{id}.json` tagging replaced with GraphQL (`orders(query:"name:#N")`, `orderUpdate`); deployed; verified live (order lookup and tag/metafield write). Webhook payloads are unchanged |
| 2.2.6, 2.2.7 | n.a. | No admin extensions or modals |
| 2.3.1 no manual shop URL | Pass | No shop-domain input |
| 2.3.2-2.3.4 install/OAuth | Needs review | Uses Shopify managed installation + token exchange (no OAuth redirect code in the Worker); the Dev Dashboard version uses managed install. Test reinstall once on a dev store |
| 3.1.1 TLS | Pass | wsystem.dev behind Cloudflare HTTPS |
| 3.2 scopes | Pass | read_orders, write_orders only; no read_all_orders. Order query avoids the `customer` field (needs protected-customer scope) |
| Protected customer data | Needs review | App reads buyer name/address/email from orders: complete the Protected customer data access request (name, address, email) in the Dev Dashboard and the data-use justification (DATA_PROTECTION.md) |

Other findings (not in the checklist but flagged by the image check): screenshot 01-settings.png still shows an old hint ("20 calls per day", "500 units") that the app no longer displays; 05-plans.png shows the old pre-managed plan table (names/annual rows). Re-shoot both after the managed plans are live. Pricing inside 05-plans.png is acceptable (app UI) but must match the listing.
Known limit: a forced regeneration that fails (e.g. quota exhausted) replaces an earlier valid invoice record with the failed one (dev store orders 1009/1011 are in that state now: dev key quota used up).
