import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const out = { date: '2026-09-10', note: 'Fresh-token authed re-captures (user_id in envelopes) + C14 eshopUrl variants', steps: [] };

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
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 2200), userIdSeen: (text.match(/"user_id":(-?\d+)/) ?? [])[1] });
      return text;
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const tag = 'PROBE' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await rq('B6 addcoupon bogus (fresh authed)', 'GET', S + '/v1/addcoupon/' + tag);
  await rq('B7 delcoupon/1 (fresh authed)', 'GET', S + '/v1/delcoupon/1');
  await rq('A12 setCountry 0 same-value (fresh authed)', 'POST', S + '/v1/setCountry', { countryId: 0 });
  await rq('B8 addGift empty (fresh authed)', 'POST', S + '/v2/addGift', { rangeIdsGiftCodes: [] });
  await rq('O10 feedback empty (fresh authed)', 'POST', S + '/v1/feedback', { text: '', info: '' });
  await rq('O8 costEstimate {} (fresh authed, full body)', 'POST', 'https://www.alza.cz/api/orders/v1/costEstimate', {});
  await rq('C9 hierarchicalFilter {} (fresh authed)', 'POST', S + '/v1/hierarchicalFilter', {});
  const created = await rq('B11 createCommodityList (fresh authed pair)', 'POST', S + '/v1/createCommodityList', { name: 'probe-' + tag });
  const id = (JSON.parse(created ?? '{}') ?? {}).data?.[0]?.id ?? null;
  if (id) await rq('B11 deleteCommodityList (id ' + id + ', fresh authed)', 'POST', S + '/v1/deleteCommodityList', { id });
  await rq('OR5 quickOrder summary (fresh authed, full body)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?country=CZ&pgrik=p__26752&ucik=u__401f1');
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
      out.push({ name, url: url.replace('https://webapi.alza.cz', ''), status: r.status, body: (await r.text()).slice(0, 2200) });
    } catch (e) { out.push({ name, url, error: String(e).slice(0, 200) }); }
  };
  await rq('C14 mainNavigation bare (webapi, fresh)', 'https://webapi.alza.cz/api/users/' + USERID + '/mainNavigation?country=CZ');
  await rq('C14 mainNavigation eshopUrl=https://www.alza.cz/ (webapi, fresh)', 'https://webapi.alza.cz/api/users/' + USERID + '/mainNavigation?country=CZ&eshopUrl=' + encodeURIComponent('https://www.alza.cz/'));
  await rq('R1 flag 1/1 +country=CZ (webapi, fresh)', 'https://webapi.alza.cz/api/users/1/commodities/1/review?country=CZ');
  await rq('R1 userReviewActions substituted (webapi, fresh, full body)', 'https://webapi.alza.cz/api/users/' + USERID + '/review/8692552/actions?country=cz');
  return out;
}, { BEARER, USERID });
out.steps.push(...r2);

writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup9-2026-09-10.json', JSON.stringify(out, null, 1));
for (const s of out.steps) console.log(String(s.name).slice(0, 58).padEnd(60), String(s.status ?? '').padEnd(5), 'uid=' + String(s.userIdSeen ?? '-').padEnd(10), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 120));
await browser.close();
