import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = { date: '2026-09-09', steps: [] };
const res = await page.evaluate(async () => {
  const steps = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
  // a) C11 navigation: look for the full homePage/categories route (C12 fragment)
  {
    const r = await fetch('https://www.alza.cz/api/catalog/v2/homePage/userNavigation', { headers: { Accept: 'application/json' }, credentials: 'include' });
    const nav = j(await r.text());
    const links = [];
    const scan = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.href === 'string' && /homePage\/categor/i.test(o.href)) links.push(o.href);
      if (typeof o.webLink === 'string' && /homePage\/categor/i.test(o.webLink)) links.push(o.webLink);
      for (const v of Object.values(o)) { if (v && typeof v === 'object') scan(v); else if (Array.isArray(v)) v.forEach(scan); }
    };
    scan(nav);
    steps.push({ step: 'C11 navigation category-carousel hrefs', status: r.status, links: [...new Set(links)].slice(0, 8), topKeys: nav ? Object.keys(nav).slice(0, 12) : [] });
  }
  // b) G4: web basket add (browser session) + basket id extraction
  let basketId = null;
  {
    const r = await fetch('https://www.alza.cz/api/basket/v1/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ items: [{ commodityId: 7229946, count: 1 }] }), credentials: 'include',
    });
    const p = j(await r.text());
    const m = JSON.stringify(p).match(/order\/(\d+)\/item\/(\d+)/);
    basketId = m ? Number(m[1]) : null;
    steps.push({ step: 'G4 POST basket/v1/items (browser)', status: r.status, basketId, keys: p ? Object.keys(p) : [], itemId: m ? m[2] : null });
  }
  // c) G4: cart + items reads with the basket id
  if (basketId) {
    const vid = null; // cart route needs the visitor id too — capture from statusSummary
    const sr = await fetch(`https://www.alza.cz/api/visitors/x/statusSummary`, { headers: { Accept: 'application/json' } }).catch(() => null);
    // visitor id: use the one from the page's own calls — fetch statusSummary via the same visitor id the page uses is unknown here; instead use cart with a placeholder to learn the 4xx shape
    const cartR = await fetch(`https://www.alza.cz/api/v1/visitors/00000000-0000-0000-0000-000000000000/baskets/${basketId}/checkout/cart?country=CZ`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const cart = j(await cartR.text());
    steps.push({ step: 'G4 checkout/cart (wrong visitor probe)', status: cartR.status, body: JSON.stringify(cart).slice(0, 300) });
  }
  // d) G5: fresh guest restservice basket + sendOrder2 + sendOrder3
  {
    const add = await fetch('https://www.alza.cz/services/restservice.svc/v2/basket/add', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'FKP0383232', amount: 1 }), credentials: 'include' });
    const gp = await fetch('https://www.alza.cz/services/restservice.svc/v13/getDeliveryPaymentGroups', { headers: { Accept: 'application/json' }, credentials: 'include' });
    const gpj = j(await gp.text());
    let gid = null;
    if (gpj && Array.isArray(gpj.deliveryGroups)) for (const g of gpj.deliveryGroups) { if (!gid && g.deliveryGroupId) gid = g.deliveryGroupId; }
    const so2 = await fetch('https://www.alza.cz/services/restservice.svc/v7/sendOrder2', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ deliveryGroups: [{ deliveryGroupId: gid, deliveryId: 2680, deliveryServicesIds: [], parcelShopId: '1128203', timeFrameId: 0, timeSlotId: 0 }], paymentId: 103, paymentCardId: 0, selectedDeliveryOptionId: 2680 }), credentials: 'include' });
    const so3 = await fetch('https://www.alza.cz/services/restservice.svc/v5/sendOrder3', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ parameters: { email: 'e2e-user@example.invalid' } }), credentials: 'include' });
    steps.push({ step: 'G5 sendOrder3 re-test', addStatus: add.status, gid, sendOrder2: so2.status, sendOrder3: so3.status, sendOrder3Body: (await so3.text()).slice(0, 120) });
  }
  // e) G6: mobile after-order pair on WCF order 1056808137 (still open?)
  {
    const p1 = await fetch('https://www.alza.cz/services/restservice.svc/v2/getafterorderpayments/1056808137/1070772578', { headers: { Accept: 'application/json' }, credentials: 'include' });
    const j1 = j(await p1.text());
    const p2 = await fetch('https://www.alza.cz/api/orders/v4/afterOrderPayment', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ id: 1056808137, invoiceNumber: '1070772578', paymentId: 144 }), credentials: 'include' });
    const j2 = j(await p2.text());
    steps.push({ step: 'G6 after-order re-test', getafterorderpayments: { status: p1.status, err: j1.err, msg: j1.msg }, afterOrderPayment: { status: p2.status, err: j2.err, msg: j2.msg } });
  }
  return steps;
});
out.steps.push(...res);
fs.writeFileSync('/tmp/gap-fix-probe.json', JSON.stringify(out, null, 1));
for (const s of res) console.log(JSON.stringify(s).slice(0, 400));
await browser.close();
