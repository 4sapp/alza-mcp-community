import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const out = { date: '2026-09-09', transport: 'Playwright in-page same-origin fetch; webapi.alza.cz page (JS challenge cleared); mobile headers + Bearer', steps: [] };

// Page 1: webapi.alza.cz — country=CZ variants + substituted userReviewActions
const p1 = await ctx.newPage();
try { await p1.goto('https://webapi.alza.cz/api/users/1', { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch {}
await p1.waitForTimeout(15000);
const r1 = await p1.evaluate(async ({ BEARER, USERID }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, method, url, status: r.status, body: text.slice(0, 1600) });
      return text;
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); }
  };
  await rq('C13 visitors mainNavigation +country=CZ (webapi)', 'GET', 'https://webapi.alza.cz/api/visitors/00000000-0000-0000-0000-000000000000/mainNavigation?country=CZ');
  await rq('C14 users mainNavigation +country=CZ (webapi, Bearer)', 'GET', 'https://webapi.alza.cz/api/users/' + USERID + '/mainNavigation?country=CZ&eshopUrl=' + encodeURIComponent('www.alza.cz'));
  await rq('R1 flag 0/1 +country=CZ (webapi, Bearer)', 'GET', 'https://webapi.alza.cz/api/users/0/commodities/1/review?country=CZ');
  // R1: reviews list → templated userReviewActions with {userId} substituted (foreign review id → expect denial)
  await rq('R1 reviews list (webapi, public)', 'GET', 'https://webapi.alza.cz/api/catalog/commodities/5303618/reviews?country=CZ&limit=5');
  await rq('R1 userReviewActions substituted (foreign review 8692552)', 'GET', 'https://webapi.alza.cz/api/users/' + USERID + '/review/8692552/actions?country=cz');
  await rq('R1 reviewStats (webapi, public)', 'GET', 'https://webapi.alza.cz/api/catalog/v2/commodities/5303618/reviewStats?country=CZ&pgrik=p__26752&ucik=u__401f1');
  await rq('OR5 quickOrder summary (webapi +country=CZ)', 'GET', 'https://webapi.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?country=CZ&pgrik=p__26752&ucik=u__401f1');
  return out;
}, { BEARER, USERID });
out.steps.push(...r1);

// Page 2: www.alza.cz — OR5/A13 country variants on restservice + api/users
const p2 = await ctx.newPage();
await p2.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await p2.waitForTimeout(8000);
const r2 = await p2.evaluate(async ({ BEARER, USERID }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 1200) });
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  await rq('OR5 quickOrder summary (restservice +country=CZ)', 'GET', S + '/v1/quickOrder/summary/commodities/5303618?country=CZ&pgrik=p__26752&ucik=u__401f1');
  await rq('OR5 quickOrder summary (api/users +country=CZ)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?country=CZ&pgrik=p__26752&ucik=u__401f1');
  await rq('A13 setIsic empty (+country=CZ query)', 'POST', S + '/v1/setIsic?country=CZ', { isic: '' });
  return out;
}, { BEARER, USERID });
out.steps.push(...r2);

writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup7-2026-09-09.json', JSON.stringify(out, null, 1));
for (const s of out.steps) console.log(String(s.name).slice(0, 56).padEnd(58), String(s.status ?? '').padEnd(5), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 150));
await browser.close();
