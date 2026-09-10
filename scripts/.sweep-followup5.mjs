import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const TOKENS = '/home/dev/.alza-mcp/tokens.json';
const tokens = JSON.parse(readFileSync(TOKENS, 'utf8'));
const SECRET = 'ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a';
const USERID = '100000001';
const EMAIL = 'e2e-user@example.invalid';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const out = { date: '2026-09-09', transport: 'Playwright in-page fetch (www same-origin) + context.request (cross-host, no CORS) for identity/webapi; mobile headers throughout', refresh: null, webapiOrigin: null, steps: [] };
const log = (name, method, url, status, body, extra = {}) => { out.steps.push({ name, method, url: String(url).replace('https://www.alza.cz', ''), status, body: String(body ?? '').slice(0, 1400), ...extra }); };

// A4 refresh grant via context.request (browser network stack, no page-origin CORS)
const mHeaders = () => ({ 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
try {
  const r = await ctx.request.post('https://identity.alza.cz/connect/token', { headers: mHeaders(), form: { grant_type: 'refresh_token', client_id: 'alza_Android', client_secret: SECRET, refresh_token: tokens.refresh_token } });
  const t = await r.text(); const j = t.startsWith('{') ? JSON.parse(t) : null;
  out.refresh = { ok: r.ok(), status: r.status(), body: t.slice(0, 400), keys: j ? Object.keys(j) : null, err: !r.ok() ? t.slice(0, 200) : undefined };
  if (r.ok() && j?.access_token) { tokens.access_token = j.access_token; if (j.refresh_token) tokens.refresh_token = j.refresh_token; tokens.obtained_at = new Date().toISOString(); writeFileSync(TOKENS, JSON.stringify(tokens, null, 1)); }
} catch (e) { out.refresh = { error: String(e).slice(0, 200) }; }
const BEARER = tokens.access_token;

// Discover the webapi origin from the C6 router response (review hrefs)
const c6 = await ctx.request.get('https://www.alza.cz/api/router/legacy/catalog/product/5303618?pgrik=p__26752&ucik=u__401f1&country=CZ', { headers: { accept: 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), authorization: 'Bearer ' + BEARER } });
const c6text = await c6.text();
const reviewHrefs = [...new Set((c6text.match(/https?:\/\/[^"]+/g) ?? []).filter((h) => h.toLowerCase().includes('review')))].slice(0, 4);
log('C6 router product (review href scan)', 'GET', '/api/router/legacy/catalog/product/5303618', c6.status(), c6text.slice(0, 300), { reviewHrefs });
out.webapiOrigin = reviewHrefs[0] ? new URL(reviewHrefs[0]).origin : 'https://webapi.alza.cz';

// In-page same-origin probes with the (fresh) Bearer — authed variants of the guest-mode rows
const steps = await page.evaluate(async ({ BEARER, USERID, EMAIL }) => {
  const out = [];
  const rq = async (name, method, url, body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), 'Authorization': 'Bearer ' + BEARER };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 1200), userIdSeen: (text.match(/"user_id":(-?\d+)/) ?? [])[1] });
      return { r, text };
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); return {}; }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const tag = 'PROBE' + Math.random().toString(36).slice(2, 8).toUpperCase();

  await rq('A5 getUserData v2 (token sanity)', 'GET', S + '/v2/getUserData');
  await rq('A13 setIsic empty (authed)', 'POST', S + '/v1/setIsic', { isic: '' });
  await rq('B6 addcoupon bogus (authed)', 'GET', S + '/v1/addcoupon/' + tag);
  await rq('B7 delcoupon/1 integer (authed)', 'GET', S + '/v1/delcoupon/1');
  await rq('A12 setCountry 0 same-value (authed)', 'POST', S + '/v1/setCountry', { countryId: 0 });
  await rq('B8 addGift empty (authed)', 'POST', S + '/v2/addGift', { rangeIdsGiftCodes: [] });
  await rq('O10 feedback empty (authed)', 'POST', S + '/v1/feedback', { text: '', info: '' });
  await rq('O8 costEstimate {} (authed)', 'POST', 'https://www.alza.cz/api/orders/v1/costEstimate', {});
  await rq('C9 hierarchicalFilter {} (authed)', 'POST', S + '/v1/hierarchicalFilter', {});
  const created = await rq('B11 createCommodityList (authed pair)', 'POST', S + '/v1/createCommodityList', { name: 'probe-' + tag });
  const id2 = (JSON.parse(created.text ?? '{}') ?? {}).data?.[0]?.id ?? null;
  if (id2) await rq('B11 deleteCommodityList (id ' + id2 + ', authed)', 'POST', S + '/v1/deleteCommodityList', { id: id2 });
  return out;
}, { BEARER, USERID, EMAIL });
out.steps.push(...steps);

// Cross-host probes via context.request (no CORS): C14/C13/R1/OR5 on webapi.alza.cz
const W = out.webapiOrigin;
const xq = async (name, url, auth) => {
  const headers = { accept: 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID(), ...(auth ? { authorization: 'Bearer ' + BEARER } : {}) };
  try {
    const r = await ctx.request.get(url, { headers });
    const t = await r.text();
    log(name, 'GET', url, r.status(), t, { userIdSeen: (t.match(/"user_id":(-?\d+)/) ?? [])[1] });
  } catch (e) { log(name, 'GET', url, 'ERR', String(e).slice(0, 200)); }
};
await xq('C14 mainNavigation (webapi origin, authed)', W + '/api/users/' + USERID + '/mainNavigation?eshopUrl=' + encodeURIComponent('www.alza.cz'), true);
await xq('C13 visitors mainNavigation (webapi origin)', W + '/api/visitors/00000000-0000-0000-0000-000000000000/mainNavigation', false);
for (const h of reviewHrefs.slice(0, 3)) await xq('R1 review href (webapi): ' + h.slice(0, 80), h, true);
await xq('R1 flag-shape 1/1 (webapi origin, authed)', W + '/api/users/1/commodities/1/review', true);
await xq('OR5 quickOrder summary (webapi origin, authed)', W + '/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?pgrik=p__26752&ucik=u__401f1', true);

writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup5-2026-09-09.json', JSON.stringify(out, null, 1));
console.log('REFRESH:', JSON.stringify(out.refresh));
console.log('WEBAPI ORIGIN:', out.webapiOrigin);
for (const s of out.steps) console.log(String(s.name).slice(0, 52).padEnd(54), String(s.status ?? '').padEnd(5), 'uid=' + String(s.userIdSeen ?? '-').padEnd(10), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 120));
await browser.close();
