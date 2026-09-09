import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const res = await page.evaluate(async () => {
  const steps = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 250); } };
  const vid = crypto.randomUUID();
  // C12: resolved carousel route (bare + with the HATEOAS params)
  for (const [label, url] of [['c12_bare', 'https://www.alza.cz/api/catalog/v1/homePage/categories/1'],
                              ['c12_full', 'https://www.alza.cz/api/catalog/v1/homePage/categories/1?pgri=p__26752&ui=u__401f1']]) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const p = j(await r.text());
    steps.push({ step: label, status: r.status, keys: p && typeof p === 'object' ? Object.keys(p).slice(0, 12) : String(p).slice(0, 120), snippet: JSON.stringify(p).slice(0, 260) });
  }
  // G4 cookie-less add: no credentials + own Balancer-Guid (visitor-keyed basket?)
  let bid2 = null;
  {
    const r = await fetch('https://www.alza.cz/api/basket/v1/items', {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json', 'Balancer-Guid': vid },
      body: JSON.stringify({ items: [{ commodityId: 7229946, count: 1 }] }),
    });
    const p = j(await r.text());
    const m = JSON.stringify(p).match(/order\/(\d+)\/item\/(\d+)/);
    bid2 = m ? m[1] : null;
    steps.push({ step: 'G4 add (cookie-less, own Balancer-Guid)', status: r.status, basketId: bid2, itemId: m ? m[2] : null, keys: p && typeof p === 'object' ? Object.keys(p) : [] });
  }
  // G4 cookie-less cart read for that basket
  if (bid2) {
    const r = await fetch(`https://www.alza.cz/api/v1/visitors/${vid}/baskets/${bid2}/checkout/cart?country=CZ`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    const p = j(await r.text());
    const ri = await fetch(`https://www.alza.cz/api/v1/anonymous/baskets/${bid2}/checkout/cart/items?country=CZ`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    const pi = j(await ri.text());
    steps.push({ step: 'G4 cart+items (cookie-less)', cartStatus: r.status, cartMaxStep: p && p.maxStep, itemsStatus: ri.status, items: pi && pi.items });
  }
  return steps;
});
fs.writeFileSync('/tmp/gap-fix-probe3.json', JSON.stringify({ date: '2026-09-09', steps: res }, null, 1));
for (const s of res) console.log(JSON.stringify(s).slice(0, 320));
await browser.close();
