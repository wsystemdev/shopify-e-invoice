# Deploy the compliance webhook topics (customers/data_request, customers/redact, shop/redact)
`shopify.app.toml` already declares them. Shopify CLI >= 5 deploys with a service account token (the old SHOPIFY_CLI_PARTNERS_TOKEN can no longer be created):
1. Browser Ops, Dev Dashboard (https://dev.shopify.com/dashboard/249174792) > organization Settings > Service accounts > Add service account. Name: "release". Token expiry: 90 days. Permission: App development, app "W System E-Invoice". Copy the token once.
2. Save it on the box as `SHOPIFY_SERVICE_ACCOUNT_TOKEN=...` in /workspace/growth/secrets/shopify_service.env (chmod 600; never paste in chat).
3. Then I run: `cd /workspace/integrations/shopify-e-invoice && set -a && . /workspace/growth/secrets/shopify_service.env && set +a && npx @shopify/cli@latest app deploy --allow-updates`
No browser login is needed after step 1. Fallback: `shopify auth login` shows a device code URL (https://accounts.shopify.com/activate-with-code) for Browser Ops to confirm.
