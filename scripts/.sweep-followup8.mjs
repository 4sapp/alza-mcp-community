import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const out = { date: '2026-09-10', note: 'Fresh access token minted 2026-09-10T06:30Z via scripts/alza-auth-refresh.mjs (refresh grant, RT rotated; discovery 403 → APK default endpoint). Re-probes settle whether the 2026-09-09 401s were expiry- or policy-level.', steps: [] };

const p1 = await ctx.newPage();
await p1.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await p1.waitForTimeout(8000);
const r1 = await p1.evaluate(async ({ BEARER, USERID }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 900) });
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  await rq('A5 getUserData v2 (FRESH token sanity)', 'GET', S + '/v2/getUserData');
  await rq('A13 setIsic empty (FRESH token)', 'POST', S + '/v1/setIsic', { isic: '' });
  await rq('OR5 quickOrder summary api/users (FRESH token)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?country=CZ&pgrik=p__26752&ucik=u__401f1');
  return out;
}, { BEARER, USERID });
out.steps.push(...r1);

const p2 = await ctx.newPage();
try { await p2.goto('https://webapi.alza.cz/api/users/1', { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch {}
await p2.waitForTimeout(15000);
const r2 = await p2.evaluate(async ({ BEARER, USERID }) => {
  const out = [];
  const rq = async (name, url) => {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER }, credentials: 'include' });
      out.push({ name, url, status: r.status, body: (await r.text()).slice(0, 500) });
    } catch (e) { out.push({ name, url, error: String(e).slice(0, 200) }); }
  };
  await rq('C14 users mainNavigation +country=CZ (webapi, FRESH token)', 'https://webapi.alza.cz/api/users/' + USERID + '/mainNavigation?country=CZ&eshopUrl=' + encodeURIComponent('www.alza.cz'));
  await rq('R1 flag 0/1 +country=CZ (webapi, FRESH token)', 'https://webapi.alza.cz/api/users/0/commodities/1/review?country=CZ');
  await rq('R1 userReviewActions substituted (FRESH token)', 'https://webapi.alza.cz/api/users/' + USERID + '/review/8692552/actions?country=cz');
  return out;
}, { BEARER, USERID });
out.steps.push(...r2);

writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup8-2026-09-10.json', JSON.stringify(out, null, 1));
for (const s of out.steps) console.log(String(s.name).slice(0, 58).padEnd(60), String(s.status ?? '').padEnd(5), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 130));
await browser.close();
