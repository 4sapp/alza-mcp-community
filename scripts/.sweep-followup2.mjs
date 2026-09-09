import { chromium } from 'playwright';
import fs from 'fs';
import { readFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
const out = { date: '2026-09-09', steps: [] };
// B5 with country on www
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(9000);
out.steps.push(...await page.evaluate(async ({ BEARER }) => {
  const o = [];
  const rq = async (name, method, url, body, auth) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) headers['Authorization'] = 'Bearer ' + BEARER;
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
    o.push({ name, status: r.status, body: (await r.text()).slice(0, 200) });
  };
  await rq('B5 unlockbasket?country=CZ (GET)', 'GET', 'https://www.alza.cz/services/restservice.svc/v1/unlockbasket?country=CZ');
  return o;
}, { BEARER }));
// A7 on m.alza.cz (same-origin after navigation there)
await page.goto('https://m.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => out.steps.push({ name: 'goto m.alza.cz', note: String(e).split('\n')[0] }));
await page.waitForTimeout(9000);
out.steps.push(...await page.evaluate(async ({ BEARER, USERID }) => {
  const o = [];
  const rq = async (name, method, url, auth) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
    if (auth) headers['Authorization'] = 'Bearer ' + BEARER;
    try {
      const r = await fetch(url, { method, headers, credentials: 'include' });
      const t = await r.text();
      o.push({ name, status: r.status, body: t.slice(0, 200), isJson: t.trimStart().startsWith('{') });
    } catch (e) { o.push({ name, error: String(e).slice(0, 120) }); }
  };
  await rq('A7 m.alza.cz /api/user/…/v1/alzapremium/trial', 'GET', `https://m.alza.cz/api/user/${USERID}/v1/alzapremium/trial`, true);
  return o;
}, { BEARER, USERID }));
fs.writeFileSync('/tmp/sweep-followup2.json', JSON.stringify(out, null, 1));
for (const s of out.steps) console.log(s.name.padEnd(44), String(s.status ?? s.error ?? s.note).padEnd(5), (s.body || '').replace(/\s+/g, ' ').slice(0, 130));
await browser.close();
