import { chromium } from 'playwright';
import fs from 'fs';
import { readFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(9000);
const steps = await page.evaluate(async ({ BEARER }) => {
  const out = [];
  const rq = async (name, method, url, body, auth) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) headers['Authorization'] = 'Bearer ' + BEARER;
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, status: r.status, body: text.slice(0, 220) });
      return { r, text };
    } catch (e) { out.push({ name, error: String(e).slice(0, 150) }); return {}; }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  // C6 first to obtain canonical pgrik/ucik + EAN
  const c6 = await rq('C6 router product (bare)', 'GET', 'https://www.alza.cz/api/router/legacy/catalog/product/5303618');
  const selfHref = c6.text?.match(/"self"\s*:\s*{[^}]*?"href"\s*:\s*"([^"]+)"/)?.[1] ?? '';
  const pgrik = selfHref.match(/pgrik=([^&"]+)/)?.[1] ?? 'p__26752';
  const ucik = selfHref.match(/ucik=([^&"]+)/)?.[1] ?? 'u__401f1';
  const ean = c6.text?.match(/"eans?"\s*:\s*\[?\s*"?(\d{8,14})/)?.[1];
  // C2 variants: server ModelState wants T and P
  for (const [label, q] of [['T=CATEGORY&P=0', '?T=CATEGORY&P=0'], ['T=CATEGORY&P=1', '?T=CATEGORY&P=1'], ['T=0&P=0', '?T=0&P=0'], ['type+T+P', '?type=CATEGORY&typeId=0&T=CATEGORY&P=0']]) {
    await rq('C2 variant ' + label, 'GET', S + '/v1/category/1' + q);
  }
  // C5 with server-provided pgrik/ucik
  await rq('C5 with pgrik/ucik from C6', 'GET', `https://www.alza.cz/api/legacy/catalog/v14/product/5303618?pgrik=${pgrik}&ucik=${ucik}&country=CZ`);
  // C8 with EAN from C6
  if (ean) await rq('C8 EAN ' + ean, 'POST', S + '/v1/getProductByEANlist', { eanList: [ean] });
  // B5 as GET (POST gave 405)
  await rq('B5 unlockbasket as GET', 'GET', S + '/v1/unlockbasket');
  // O6 with country
  await rq('O6 ?country=CZ', 'GET', S + '/v8/getOrder2Info?country=CZ');
  await rq('O6 ?Country=CZ', 'GET', S + '/v8/getOrder2Info?Country=CZ');
  // A7 variants
  await rq('A7 www ?country=CZ', 'GET', 'https://www.alza.cz/api/user/100000001/v1/alzapremium/trial?country=CZ', undefined, true);
  await rq('A7 m.alza.cz', 'GET', 'https://m.alza.cz/api/user/100000001/v1/alzapremium/trial', undefined, true);
  await rq('A7 api.alza.cz', 'GET', 'https://api.alza.cz/api/user/100000001/v1/alzapremium/trial', undefined, true);
  return out;
}, { BEARER });
fs.writeFileSync('/tmp/sweep-followup.json', JSON.stringify({ date: '2026-09-09', steps }, null, 1));
for (const s of steps) console.log(s.name.padEnd(30), String(s.status ?? s.error).padEnd(5), (s.body || '').replace(/\s+/g, ' ').slice(0, 120));
await browser.close();
