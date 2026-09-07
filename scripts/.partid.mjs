import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const out = await page.evaluate(async () => {
  const r = await fetch('https://www.alza.cz/api/anonymous/v1/orders/1057075103', { headers: { Accept: 'application/json' }, credentials: 'include' });
  const o = await r.json();
  const p = (o.parts || [])[0];
  return {
    orderNumber: o.orderNumber, status: o.status, created: o.created,
    part: p ? { partNumber: p.partNumber, status: p.status, phase: p.phase, partial: p.partialDeliveryPaymentInfo } : null,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
