const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function hmac(secret, data, out = "hex") {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return out === "base64" ? b64(sig) : hex(sig);
}
export function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function aesKey(secret) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return b64(iv) + "." + b64(ct);
}
export async function unseal(secret, blob) {
  const [i, c] = String(blob).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(i) }, await aesKey(secret), unb64(c));
  return new TextDecoder().decode(pt);
}
const b64url = (s) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
// Verify an App Bridge session token (HS256 JWT signed with the app secret).
export async function verifySessionToken(token, secret, clientId, now = Date.now() / 1000) {
  const p = String(token || "").split(".");
  if (p.length !== 3) return null;
  const sig = (await hmac(secret, p[0] + "." + p[1], "base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (!safeEq(sig, p[2])) return null;
  let c; try { c = JSON.parse(atob(b64url(p[1]))); } catch { return null; }
  if (c.aud !== clientId || c.exp < now - 5 || c.nbf > now + 5) return null;
  const m = /^https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)\/admin$/.exec(String(c.dest || ""));
  return m ? { shop: m[1], claims: c } : null;
}
