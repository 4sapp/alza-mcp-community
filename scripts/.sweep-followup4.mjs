import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const TOKENS = '/home/dev/.alza-mcp/tokens.json';
const tokens = JSON.parse(readFileSync(TOKENS, 'utf8'));
const SECRET = 'ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a';
const USERID = '100000001';

// A4: refresh the access token out-of-page (identity host allows direct node fetch)
let refresh = { ok: false };
try {
  const res = await fetch('https://identity.alza.cz/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'alza_Android', client_secret: SECRET, refresh_token: tokens.refresh_token }),
  });
  const j = await res.json().catch(() => null);
  refresh = { ok: res.ok, status: res.status, keys: j ? Object.keys(j) : null, expiresIn: j?.expires_in, tokenType: j?.token_type, scope: j?.scope, err: j && !res.ok ? (j.error ?? JSON.stringify(j).slice(0, 200)) : undefined };
  if (res.ok && j?.access_token) {
    tokens.access_token = j.access_token;
    if (j.refresh_token) tokens.refresh_token = j.refresh_token;
    tokens.obtained_at = new Date().toISOString();
    writeFileSync(TOKENS, JSON.stringify(tokens, null, 1));
  }
} catch (e) { refresh.error = String(e).slice(0, 200); }
const BEARER = tokens.access_token;
const EMAIL = 'e2e-user@example.invalid';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = { date: '2026-09-09', transport: 'Playwright in-page fetch + out-of-page identity refresh grant; fresh Bearer after rotation', refresh, steps: [] };
const steps = await page.evaluate(async ({ BEARER, USERID, EMAIL }) => {
  const out = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const rq = async (name, method, url, body, auth) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) headers['Authorization'] = 'Bearer ' + BEARER;
    try {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
      const text = await r.text();
      const p = j(text);
      const entry = { name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 1200), parsed: p && typeof p === 'object' ? { err: p.err ?? p.error ?? (p.d && p.d.err), msg: p.msg, keys: Object.keys(p).slice(0, 12) } : undefined };
      out.push(entry);
      return { r, text, p, entry };
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); return {}; }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const tag = 'PROBE' + Math.random().toString(36).slice(2, 8).toUpperCase();

  // sanity: fresh token accepted on a known-authed GET (A5 getUserData)
  await rq('A5 getUserData (fresh Bearer sanity)', 'GET', S + '/v1/getUserData', undefined, true);

  // C14 with fresh Bearer (both eshopUrl shapes) + C13 comparison
  await rq('C14 mainNavigation (fresh, eshopUrl=www.alza.cz)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/mainNavigation?eshopUrl=' + encodeURIComponent('www.alza.cz'), undefined, true);
  await rq('C14 mainNavigation (fresh, bare)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/mainNavigation', undefined, true);
  await rq('C13 visitors mainNavigation (comparison)', 'GET', 'https://www.alza.cz/api/visitors/00000000-0000-0000-0000-000000000000/mainNavigation', undefined, false);

  // OR5 corrected route (dex string: /v1/quickOrder/summary/commodities/ under restservice.svc) + the old /api/users variant
  await rq('OR5 quickOrder summary (restservice route, pgrik/ucik from C6)', 'GET', S + '/v1/quickOrder/summary/commodities/5303618?pgrik=p__26752&ucik=u__401f1&country=CZ', undefined, true);
  await rq('OR5 quickOrder summary (api/users route, fresh)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?pgrik=p__26752&ucik=u__401f1', undefined, true);

  // A13 setIsic with fresh Bearer (empty value)
  await rq('A13 setIsic empty (fresh Bearer)', 'POST', S + '/v1/setIsic', { isic: '' }, true);

  // R1: learn the real review route from the C6 router response (full body scan for review hrefs)
  const c6 = await rq('C6 router product (full href scan)', 'GET', 'https://www.alza.cz/api/router/legacy/catalog/product/5303618?pgrik=p__26752&ucik=u__401f1&country=CZ');
  const hrefs = [...new Set((c6.text?.match(/https?:\/\/[^"]+/g) ?? []).filter((h) => h.toLowerCase().includes('review')))].slice(0, 6);
  c6.entry.reviewHrefs = hrefs;
  for (const h of hrefs.slice(0, 3)) await rq('R1 review href from C6 router: ' + h.slice(0, 90), 'GET', h, undefined, true);
  await rq('R1 flag-shape retest (fresh)', 'GET', 'https://www.alza.cz/api/users/1/commodities/1/review', undefined, true);

  // B11: cleanup the orphaned list from followup3 + a clean reversible create/delete pair
  await rq('B11 deleteCommodityList (cleanup id 166247730)', 'POST', S + '/v1/deleteCommodityList', { id: 166247730 });
  const created = await rq('B11 createCommodityList (probe-…, clean pair)', 'POST', S + '/v1/createCommodityList', { name: 'probe-' + tag });
  const listId = created.p?.data?.[0]?.id ?? null;
  created.entry.extractedId = listId;
  if (listId) await rq('B11 deleteCommodityList (id ' + listId + ')', 'POST', S + '/v1/deleteCommodityList', { id: listId });

  // B7 delcoupon with an integer couponId (ModelState said Int32)
  await rq('B7 delcoupon/1 (integer binding probe)', 'GET', S + '/v1/delcoupon/1');

  // O9 addOrderService with integer first segment (ModelState said orderItemId Int32)
  await rq('O9 addOrderService/12345/1/0 (integer binding probe)', 'GET', S + '/v1/addOrderService/12345/1/0');

  return out;
}, { BEARER, USERID, EMAIL });
out.steps = steps;
writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup4-2026-09-09.json', JSON.stringify(out, null, 1));
console.log('REFRESH:', JSON.stringify(refresh));
for (const s of steps) console.log(String(s.name).slice(0, 56).padEnd(58), String(s.status ?? '').padEnd(5), String(s.error ?? '').slice(0, 50), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 140));
await browser.close();
