const T = {
  en: { title: "W System E-Invoice", intro: "Creates a validated XRechnung 3.0 / EN 16931 e-invoice for each order. XRechnung requires complete seller details including a contact name, phone and email.",
    api: "W System API key (optional)", apih: "Optional. Leave empty: the app sets up a free W System key for 25 e-invoices a month. Paste your own key only if you already have a W System plan.",
    format: "Format", trigger: "Create automatically", t_paid: "When the order is paid", t_created: "When the order is created", t_off: "Never (manual only)",
    only_b2b: "Only for business customers (billing company or VAT ID)", small: "Small business scheme (section 19 UStG, no VAT)", seller: "Seller", name: "Company name", street: "Street", postcode: "Postcode", city: "City", country: "Country (ISO)",
    email: "Contact email", phone: "Contact phone", contact: "Contact name", vat: "VAT ID", taxno: "Tax number", reg: "Registration number", iban: "IBAN (for bank transfer orders)", bic: "BIC",
    terms: "Payment terms", ref: "Default buyer reference (Leitweg-ID)", refh: "Used when an order has no buyer reference. Per order, add an order attribute named Leitweg-ID.", vatattr: "Order attribute names holding the customer VAT ID",
    prefix: "Invoice number prefix", emailcopy: "Email a copy of each valid XML to the seller email", save: "Save settings", saved: "Saved.", err: "Could not save", orders: "Recent e-invoices", create: "Create", order: "Order", status: "Status", number: "Number", dl: "Download XML",
    plan: "Your plan", planfree: "Free: 25 e-invoices a month. Your W System key is set up automatically.", planmore: "Need more? Plans are billed by Shopify:", curlabel: "Current plan", manage: "Billed by Shopify. To change or cancel, choose another plan below or open Settings > Billing in your Shopify admin. Cancelling returns you to the free plan.", monthly: "a month", yearly: "a year (pay 10 months, get 12)", inv: "e-invoices a month", sub: "Choose a plan", subbusy: "Opening Shopify...",
    ok: "Valid", bad: "Failed validation", none: "No e-invoices yet.", orderid: "Order number to create an e-invoice for", go: "Create e-invoice" },
  de: { title: "W System E-Rechnung", intro: "Erstellt für jede Bestellung eine geprüfte XRechnung 3.0 / EN 16931. Die XRechnung verlangt vollständige Verkäuferdaten inklusive Ansprechpartner, Telefon und E-Mail.",
    api: "W System API-Schlüssel (optional)", apih: "Optional. Leer lassen: Die App richtet einen kostenlosen W System Schlüssel für 25 E-Rechnungen im Monat ein. Eigenen Schlüssel nur eintragen, wenn Sie bereits einen W System Tarif haben.",
    format: "Format", trigger: "Automatisch erstellen", t_paid: "Wenn die Bestellung bezahlt ist", t_created: "Wenn die Bestellung angelegt wird", t_off: "Nie (nur manuell)",
    only_b2b: "Nur für Geschäftskunden (Rechnungsfirma oder USt-IdNr.)", small: "Kleinunternehmerregelung (§ 19 UStG, keine USt)", seller: "Verkäufer", name: "Firmenname", street: "Straße", postcode: "PLZ", city: "Ort", country: "Land (ISO)",
    email: "Kontakt-E-Mail", phone: "Kontakt-Telefon", contact: "Ansprechpartner", vat: "USt-IdNr.", taxno: "Steuernummer", reg: "Handelsregisternummer", iban: "IBAN (für Überweisungen)", bic: "BIC",
    terms: "Zahlungsbedingungen", ref: "Standard-Käuferreferenz (Leitweg-ID)", refh: "Wird genutzt, wenn eine Bestellung keine Käuferreferenz hat. Pro Bestellung ein Bestellattribut namens Leitweg-ID anlegen.", vatattr: "Namen der Bestellattribute mit der USt-IdNr. des Kunden",
    prefix: "Präfix der Rechnungsnummer", emailcopy: "Kopie jeder gültigen XML an die Verkäufer-E-Mail senden", save: "Einstellungen speichern", saved: "Gespeichert.", err: "Speichern fehlgeschlagen", orders: "Letzte E-Rechnungen", create: "Erstellen", order: "Bestellung", status: "Status", number: "Nummer", dl: "XML herunterladen",
    plan: "Ihr Tarif", planfree: "Kostenlos: 25 E-Rechnungen im Monat. Ihr W System Schlüssel wird automatisch eingerichtet.", planmore: "Mehr nötig? Die Tarife werden über Shopify abgerechnet:", curlabel: "Aktueller Tarif", manage: "Abrechnung über Shopify. Zum Ändern oder Kündigen wählen Sie unten einen anderen Tarif oder öffnen Einstellungen > Abrechnung im Shopify-Admin. Nach der Kündigung gilt wieder der kostenlose Tarif.", monthly: "im Monat", yearly: "im Jahr (10 Monate zahlen, 12 erhalten)", inv: "E-Rechnungen im Monat", sub: "Tarif wählen", subbusy: "Shopify wird geöffnet...",
    ok: "Gültig", bad: "Prüfung fehlgeschlagen", none: "Noch keine E-Rechnungen.", orderid: "Bestellnummer, für die eine E-Rechnung erstellt wird", go: "E-Rechnung erstellen" },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function adminPage({ apiKey, shop, host, locale, base = "" }) {
  const t = T[String(locale || "en").slice(0, 2)] || T.en;
  const f = (k, label, type = "text") => `<label>${esc(label)}<input name="${k}" type="${type}" autocomplete="off"></label>`;
  const sel = (k, label, opts) => `<label>${esc(label)}<select name="${k}">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>`;
  const yn = (k, label) => sel(k, label, [["no", "No"], ["yes", "Yes"]]);
  return `<!doctype html><html lang="${esc(locale || "en")}"><head><meta charset="utf-8"><meta name="shopify-api-key" content="${esc(apiKey)}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><title>${esc(t.title)}</title>
<style>body{font:14px/1.45 -apple-system,Segoe UI,sans-serif;margin:0;padding:16px;color:#202223;background:#f6f6f7}main{max-width:760px;margin:auto}.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px #0002}
h1{font-size:20px}h2{font-size:15px;margin:0 0 10px}label{display:block;margin:8px 0;font-weight:600}input,select{display:block;width:100%;box-sizing:border-box;padding:7px;margin-top:4px;border:1px solid #8c9196;border-radius:6px;font:inherit;font-weight:400}
.g{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.h{font-weight:400;color:#6d7175;font-size:12px}button{background:#008060;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px;border-bottom:1px solid #e1e3e5}.bad{color:#b42318}.ok{color:#047857}#toast.ok{border-left:4px solid #047857}#toast.bad{border-left:4px solid #b42318}#msg{margin-left:10px}</style></head><body><main>
<div id="toast" role="status" style="display:none;position:fixed;top:12px;right:12px;padding:10px 14px;border-radius:8px;background:#fff;box-shadow:0 2px 8px #0004;z-index:9"></div>
<h1>${esc(t.title)}</h1><div class="card"><p>${esc(t.intro)}</p></div>
<div class="card" id="plan"><h2>${esc(t.plan)}</h2><p id="curplan"><strong>${esc(t.planfree)}</strong></p><p class="h" id="curnote"></p><div id="plans"></div></div>
<form id="f" class="card">${f("api_key", t.api, "password")}<div class="h">${esc(t.apih)}</div>
<div class="g">${sel("format", t.format, [["xrechnung", "XRechnung 3.0 (UBL)"], ["en16931", "EN 16931 (UBL)"], ["peppol-bis3", "Peppol BIS Billing 3.0"]])}
${sel("trigger", t.trigger, [["paid", t.t_paid], ["created", t.t_created], ["off", t.t_off]])}${yn("only_b2b", t.only_b2b)}${yn("small_business", t.small)}</div>
<h2 style="margin-top:14px">${esc(t.seller)}</h2><div class="g">${f("seller_name", t.name)}${f("seller_street", t.street)}${f("seller_postcode", t.postcode)}${f("seller_city", t.city)}${f("seller_country", t.country)}${f("seller_contact", t.contact)}${f("seller_email", t.email, "email")}${f("seller_phone", t.phone)}${f("seller_vat_id", t.vat)}${f("seller_tax_no", t.taxno)}${f("seller_reg_no", t.reg)}${f("seller_iban", t.iban)}${f("seller_bic", t.bic)}${f("payment_terms", t.terms)}</div>
${f("default_buyer_reference", t.ref)}<div class="h">${esc(t.refh)}</div>${f("vat_attr_names", t.vatattr)}${f("invoice_prefix", t.prefix)}${yn("email_copy", t.emailcopy)}
<p><button type="submit">${esc(t.save)}</button><span id="msg"></span></p></form>
<form id="c" class="card"><h2>${esc(t.go)}</h2>${f("order", t.orderid)}<button type="submit">${esc(t.create)}</button><span id="cmsg"></span></form>
<div class="card"><h2>${esc(t.orders)}</h2><div id="list">${esc(t.none)}</div></div></main>
<script>
const BASE=${JSON.stringify(base)};const L=${JSON.stringify({ err: t.err,  ok: t.ok, bad: t.bad, planmore: t.planmore, curlabel: t.curlabel, manage: t.manage, planfree: t.planfree, monthly: t.monthly, yearly: t.yearly, inv: t.inv, sub: t.sub, subbusy: t.subbusy, dl: t.dl, none: t.none, saved: t.saved, order: t.order, status: t.status, number: t.number })};
async function api(p,o={}){const tok=await shopify.idToken();const r=await fetch(BASE+p,{cache:"no-store",...o,headers:{...(o.headers||{}),Authorization:"Bearer "+tok,"content-type":"application/json"}});if(!r.ok&&r.status!==400){let m="HTTP "+r.status;try{const j=await r.json();m=j.error||m}catch(e){}throw new Error(m)}return r.json()}
function toast(m,isErr){try{shopify.toast.show(m,{isError:!!isErr,duration:4000})}catch(e){}const el=document.getElementById("toast");el.textContent=m;el.className=isErr?"bad":"ok";el.style.display="block";clearTimeout(window._tt);window._tt=setTimeout(()=>el.style.display="none",5000)}
const F=document.getElementById("f");
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function load(){const s=await api("/api/settings");for(const [k,v] of Object.entries(s.settings||{})){if(F.elements[k])F.elements[k].value=v}
 const o=await api("/api/invoices");const rows=(o.invoices||[]).map(i=>"<tr><td>"+esc(i.order)+"</td><td>"+esc(i.number)+"</td><td class='"+(i.valid?"ok":"bad")+"'>"+(i.valid?L.ok:L.bad+(i.errors&&i.errors[0]?": "+esc(i.errors[0].rule_id+" "+i.errors[0].message+" "+i.errors[0].fix):""))+"</td><td>"+(i.xml?"<a href='"+esc(i.url)+"' target='_blank'>"+L.dl+"</a>":"")+"</td></tr>").join("");
 document.getElementById("list").innerHTML=rows?"<table><tr><th>"+L.order+"</th><th>"+L.number+"</th><th>"+L.status+"</th><th></th></tr>"+rows+"</table>":L.none}
F.onsubmit=async e=>{e.preventDefault();try{const d=Object.fromEntries(new FormData(F));const r=await api("/api/settings",{method:"POST",body:JSON.stringify(d)});if(r.ok){toast(L.saved,false);document.getElementById("msg").textContent=""}else toast(r.error||L.err,true)}catch(x){toast(L.err+": "+x.message,true)}};
document.getElementById("c").onsubmit=async e=>{e.preventDefault();try{const o=e.target.elements.order.value;const r=await api("/api/create",{method:"POST",body:JSON.stringify({order:o})});if(r.ok)toast(r.valid?L.ok:L.bad,!r.valid);else toast(r.error||L.err,true);load()}catch(x){toast(L.err+": "+x.message,true)}};
async function plans(){let cur=null;try{const sy=await api("/api/billing/sync",{method:"POST",body:"{}"});if(sy&&sy.ok&&sy.current)cur=sy.current}catch(x){}
 if(cur&&cur.id==="own_key"){document.getElementById("curplan").innerHTML="<strong>"+esc(cur.name)+"</strong>"}
 else if(cur&&cur.ws&&cur.ws!=="shop_free"){document.getElementById("curplan").innerHTML="<strong>"+esc(L.curlabel)+": "+esc(cur.name)+": "+cur.invoices+" "+L.inv+"</strong>";document.getElementById("curnote").textContent=L.manage}
 try{const b=await api("/api/billing");if(!b.live||!b.plans.length)return;
 const rows=b.plans.filter(p=>p.price!=="0.00"&&(!cur||p.id!==cur.id)).map(p=>"<tr><td>"+esc(p.name)+"</td><td>"+p.invoices+" "+L.inv+"</td><td>$"+esc(p.price.replace(".00",""))+" "+L.monthly+" / $"+esc(p.yearly.replace(".00",""))+" "+L.yearly+"</td></tr>").join("");
 document.getElementById("plans").innerHTML="<p class='h'>"+L.planmore+"</p><table>"+rows+"</table><p><button type='button' id='choose'>"+L.sub+"</button></p>";
 document.getElementById("choose").onclick=()=>{try{window.open(b.pricing_url,"_top")}catch(e){window.top.location.href=b.pricing_url}}}catch(x){}}
plans();
load().catch(x=>toast(L.err+": "+x.message,true));
</script></body></html>`;
}
