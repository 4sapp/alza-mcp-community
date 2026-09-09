import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(9000);
const out = await page.evaluate(async () => {
  const o = [];
  const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
  const c6 = await fetch('https://www.alza.cz/api/router/legacy/catalog/product/5303618', { headers, credentials: 'include' });
  const body = await c6.text();
  o.push({ name: 'C6 full-body size', status: c6.status, size: body.length });
  const eans = [...new Set([...body.matchAll(/"eans?"\s*:\s*\[?\s*[\[{]?"?(\d{8,14})/g)].map((m) => m[1]))];
  o.push({ name: 'eans found in C6', eans: eans.slice(0, 4) });
  if (eans.length) {
    const r = await fetch('https://www.alza.cz/services/restservice.svc/v1/getProductByEANlist', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ eanList: [eans[0]] }), credentials: 'include' });
    const t = await r.text();
    o.push({ name: 'C8 getProductByEANlist (ean ' + eans[0] + ')', status: r.status, body: t.slice(0, 200) });
  }
  return o;
});
fs.writeFileSync('/tmp/sweep-c8.json', JSON.stringify({ date: '2026-09-09', steps: out }, null, 1));
for (const s of out) console.log(s.name?.padEnd(40), String(s.status ?? '').padEnd(5), (s.body || JSON.stringify(s.eans ?? s.size ?? '')).replace(/\s+/g, ' ').slice(0, 130));
await browser.close();
