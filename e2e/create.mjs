import fs from "fs"; import { hmac } from "../src/crypto.js";
const rd = (p) => Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const app = rd("/workspace/growth/secrets/shopify_app.env");
const b = (s) => Buffer.from(s).toString("base64url"); const now = Math.floor(Date.now() / 1000);
const h = b(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b(JSON.stringify({ iss: `https://${app.SHOPIFY_DEV_STORE}/admin`, dest: `https://${app.SHOPIFY_DEV_STORE}`, aud: app.SHOPIFY_CLIENT_ID, exp: now + 60, nbf: now - 5 }));
const tok = `${h}.${p}.${Buffer.from(await hmac(app.SHOPIFY_CLIENT_SECRET, h + "." + p, "base64"), "base64").toString("base64url")}`;
for (const order of process.argv.slice(2)) {
  const r = await fetch("https://wsystem.dev/shopify/api/create", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ order }) });
  console.log(order, r.status, (await r.text()).slice(0, 250));
}
