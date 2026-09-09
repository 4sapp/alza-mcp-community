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
  const c6 = await (await fetch('https://www.alza.cz/api/router/legacy/catalog/product/5303618', { headers, credentials: 'include' })).text();
  const j6 = JSON.parse(c6);
  const data = j6.data ?? j6;
  o.push({ name: 'C6 data keys', keys: Object.keys(data).slice(0, 30) });
  // any 8-14 digit fields with ean-ish names anywhere in the body
  o.push({ name: 'ean-ish matches', found: [...new Set([...c6.matchAll(/([A-Za-z]{0,10}[Ee]an[A-Za-z]{0,6})"?\s*[:]\s*"?(\d{8,14})/g)].map((m) => m[1] + '=' + m[2]))].slice(0, 5) });
  // C4 external product (different serializer?)
  const c4 = await (await fetch('https://www.alza.cz/api/legacy/catalog/v14/external/product/5303618', { headers, credentials: 'include' })).text();
  o.push({ name: 'C4 external product', status: 200, size: c4.length, eanish: [...new Set([...c4.matchAll(/([A-Za-z]{0,10}[Ee]an[A-Za-z]{0,6})"?\s*[:]\s*"?(\d{8,14})/g)].map((m) => m[1] + '=' + m[2]))].slice(0, 5) });
  // fallback: books carry ISBN/EAN — use the E2E book code via restservice product search? simpler: try a known book id FKP0383232 → numeric id unknown; instead scan C4 for any 13-digit run
  const c13 = [...new Set([...c4.matchAll(/\b(\d{13})\b/g)].map((m) => m[1]))];
  o.push({ name: '13-digit runs in C4', found: c13.slice(0, 5) });
  if (c13.length) {
    const r = await fetch('https://www.alza.cz/services/restservice.svc/v1/getProductByEANlist', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ eanList: [c13[0]] }), credentials: 'include' });
    const t = await r.text();
    o.push({ name: 'C8 getProductByEANlist (' + c13[0] + ')', status: r.status, body: t.slice(0, 220) });
  }
  return o;
});
fs.writeFileSync('/tmp/sweep-c8b.json', JSON.stringify({ date: '2026-09-09', steps: out }, null, 1));
for (const s of out) console.log(String(s.name ?? '').padEnd(38), String(s.status ?? '').padEnd(5), JSON.stringify(s.keys ?? s.found ?? s.eanish ?? s.body ?? '').replace(/\\s+/g, ' ').slice(0, 220));
await browser.close();
