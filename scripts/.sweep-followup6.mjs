import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const EMAIL = 'e2e-user@example.invalid';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const out = { date: '2026-09-09', transport: 'Playwright in-page same-origin fetch on www.alza.cz and webapi.alza.cz (JS challenge cleared by navigation); mobile headers + Bearer', steps: [] };

// Page 1: www.alza.cz — full A5 body + 401-stability retries
const p1 = await ctx.newPage();
await p1.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await p1.waitForTimeout(8000);
const r1 = await p1.evaluate(async ({ BEARER, USERID }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
    const text = await r.text();
    out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 6000) });
    return text;
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const a5 = await rq('A5 getUserData v2 (full body)', 'GET', S + '/v2/getUserData');
  const ids = [...new Set((a5.match(/"(?:userId|user_id|customerId|userID|id)"\s*:\s*"?(\d{5,})/g) ?? []).map((m) => m.replace(/"[^"]+"\s*:\s*/, '')))];
  await rq('OR5 quickOrder summary (api/users, 401 stability retest)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?pgrik=p__26752&ucik=u__401f1');
  await rq('A13 setIsic empty (401 stability retest)', 'POST', S + '/v1/setIsic', { isic: '' });
  await rq('R1 flag 0/1 (www SPA-404 retest)', 'GET', 'https://www.alza.cz/api/users/0/commodities/1/review');
  const c6 = await fetch('https://www.alza.cz/api/router/legacy/catalog/product/5303618?pgrik=p__26752&ucik=u__401f1&country=CZ', { headers: { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER }, credentials: 'include' });
  const c6t = await c6.text();
  const reviewHrefs = [...new Set((c6t.match(/https?:\/\/[^"]+/g) ?? []).filter((h) => h.toLowerCase().includes('review')))].slice(0, 4);
  out.push({ name: 'C6 review href scan', status: c6.status, reviewHrefs, body: c6t.slice(0, 600) });
  return { out, ids };
}, { BEARER, USERID });
out.steps.push(...r1.out);
const uid = r1.ids[0] ?? USERID;

// Page 2: webapi.alza.cz — navigate so the JS challenge clears, then same-origin fetches
const p2 = await ctx.newPage();
let nav = 'ok';
try { await p2.goto('https://webapi.alza.cz/api/users/1', { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch (e) { nav = String(e).slice(0, 120); }
await p2.waitForTimeout(15000);
const r2 = await p2.evaluate(async ({ BEARER, USERID, EMAIL }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, method, url, status: r.status, body: text.slice(0, 1400), isAlzaChallenge: text.includes('alza-component-version') || text.includes('Alza.cz</title>') });
      return text;
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); }
  };
  await rq('C14 mainNavigation (webapi same-origin, eshopUrl)', 'GET', 'https://webapi.alza.cz/api/users/' + USERID + '/mainNavigation?eshopUrl=' + encodeURIComponent('www.alza.cz'));
  await rq('C13 visitors mainNavigation (webapi same-origin)', 'GET', 'https://webapi.alza.cz/api/visitors/00000000-0000-0000-0000-000000000000/mainNavigation');
  await rq('R1 flag 0/1 (webapi same-origin)', 'GET', 'https://webapi.alza.cz/api/users/0/commodities/1/review');
  await rq('R1 flag 1/1 (webapi same-origin)', 'GET', 'https://webapi.alza.cz/api/users/1/commodities/1/review');
  await rq('OR5 quickOrder summary (webapi same-origin)', 'GET', 'https://webapi.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?pgrik=p__26752&ucik=u__401f1');
  return out;
}, { BEARER, USERID, EMAIL });
out.steps.push(...r2);
out.webapiNav = nav;

// R1 review hrefs discovered from C6 — fetched from the webapi page (same-origin)
for (const h of (r1.out.find((s) => s.name === 'C6 review href scan')?.reviewHrefs ?? []).slice(0, 3)) {
  const res = await p2.evaluate(async ({ BEARER, url }) => {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER }, credentials: 'include' });
      return { status: r.status, body: (await r.text()).slice(0, 1200) };
    } catch (e) { return { error: String(e).slice(0, 200) }; }
  }, { BEARER, url: h });
  out.steps.push({ name: 'R1 review href (webapi): ' + h.slice(0, 80), ...res });
}

writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup6-2026-09-09.json', JSON.stringify(out, null, 1));
console.log('A5 id candidates:', r1.ids, '→ using', uid);
for (const s of out.steps) console.log(String(s.name).slice(0, 52).padEnd(54), String(s.status ?? '').padEnd(5), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 130));
await browser.close();
