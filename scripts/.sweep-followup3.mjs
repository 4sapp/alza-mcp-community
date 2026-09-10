import { chromium } from 'playwright';
import fs from 'fs';
import { readFileSync, writeFileSync } from 'fs';
const tokens = JSON.parse(readFileSync('/home/dev/.alza-mcp/tokens.json', 'utf8'));
const BEARER = tokens.access_token;
const USERID = '100000001';
const EMAIL = 'e2e-user@example.invalid';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = { date: '2026-09-09', transport: 'Playwright in-page fetch, same-origin www.alza.cz, mobile headers (Balancer-Guid/x-correlation-id), Bearer for auth rows', steps: [] };
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
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, body: text.slice(0, 300), parsed: p && typeof p === 'object' ? { err: p.err ?? p.error ?? (p.d && p.d.err), keys: Object.keys(p).slice(0, 10) } : undefined });
      return { r, text, p };
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); return {}; }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const tag = 'PROBE' + Math.random().toString(36).slice(2, 8).toUpperCase();

  // A10 o3Info — bare GET, no input, no auth (the cheapest row in the registry)
  await rq('A10 o3Info (bare GET)', 'GET', S + '/v2/o3Info');

  // C14 authenticated mainNavigation — plain GET, user id + Bearer
  await rq('C14 mainNavigation (Bearer, eshopUrl)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/mainNavigation?eshopUrl=' + encodeURIComponent('https://www.alza.cz/'), undefined, true);
  await rq('C14 mainNavigation (Bearer, bare)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/mainNavigation', undefined, true);

  // R1 user review — APK flag semantics (i==true?1:0) vs the id-style URL the MCP currently sends
  await rq('R1 user review flags 0/1 (user scope 0, commodity scope 1)', 'GET', 'https://www.alza.cz/api/users/0/commodities/1/review', undefined, true);
  await rq('R1 user review flags 1/1', 'GET', 'https://www.alza.cz/api/users/1/commodities/1/review', undefined, true);
  await rq('R1 user review id-style (current MCP URL)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/commodities/5303618/review', undefined, true);

  // B6/B7 coupon add/remove with a bogus code (app-level error expected, no real discount)
  await rq('B6 addcoupon (bogus ' + tag + ')', 'GET', S + '/v1/addcoupon/' + tag);
  await rq('B7 delcoupon (bogus ' + tag + ')', 'GET', S + '/v1/delcoupon/' + tag);

  // B11 shopping list create + delete (reversible pair)
  const created = await rq('B11 createCommodityList (probe-…)', 'POST', S + '/v1/createCommodityList', { name: 'probe-' + tag });
  const listId = (created.p && (created.p.id ?? created.p.commodityListId ?? created.p.data?.id ?? created.p.data?.commodityListId)) ?? null;
  out[out.length - 1].extractedId = listId;
  if (listId) await rq('B11 deleteCommodityList (id ' + listId + ')', 'POST', S + '/v1/deleteCommodityList', { id: listId });

  // O9 add order service (bogus service name → observe route binding)
  await rq('O9 addOrderService (bogus probeService/1/0)', 'GET', S + '/v1/addOrderService/probeService/1/0');

  // OR5 quick-order summary — pgrik/ucik from a fresh C6 router response
  const c6 = await rq('C6 router product (for OR5 pgrik/ucik)', 'GET', 'https://www.alza.cz/api/router/legacy/catalog/product/5303618');
  const selfHref = c6.p?.self?.href ?? (c6.text.match(/https:\/\/[^"]*pgrik[^"]*/) || [])[0];
  const pgrik = selfHref?.match(/pgrik=([^&"]+)/)?.[1];
  const ucik = selfHref?.match(/ucik=([^&"]+)/)?.[1];
  out[out.length - 1].pgrik = pgrik; out[out.length - 1].ucik = ucik;
  if (pgrik) await rq('OR5 quickOrder summary (pgrik/ucik from C6)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618?pgrik=' + encodeURIComponent(pgrik) + '&ucik=' + encodeURIComponent(ucik), undefined, true);
  else await rq('OR5 quickOrder summary (bare)', 'GET', 'https://www.alza.cz/api/users/' + USERID + '/v1/quickOrder/summary/commodities/5303618', undefined, true);

  // O8 cost estimate — the 2026.17 request DTO is payment/order-referencing (CostEstimate: afterOrderPaymentId, cardId, cardType, deliveryPaymentPrice, encryptedCard, invoiceId, isAfterOrder, masterOrderId, orderId, paymentId, paymentReference, priceToPay, priceWithText)
  await rq('O8 costEstimate {}', 'POST', 'https://www.alza.cz/api/orders/v1/costEstimate', {});
  await rq('O8 costEstimate {isAfterOrder:false}', 'POST', 'https://www.alza.cz/api/orders/v1/costEstimate', { isAfterOrder: false });

  // C9 hierarchical filter — minimal payload (server-echoed tree)
  await rq('C9 hierarchicalFilter {}', 'POST', S + '/v1/hierarchicalFilter', {});

  // A12 set country — same-value no-op (country id from D3 getAllDeliveryCountries)
  const dc = await rq('D3 getAllDeliveryCountries (for A12 countryId)', 'GET', S + '/v1/getAllDeliveryCountries');
  const cz = (dc.p?.data ?? dc.p ?? []).find?.((c) => String(c.iso ?? c.code ?? c.name ?? '').toUpperCase().includes('CZ')) ?? null;
  out[out.length - 1].czCountry = cz ? { id: cz.id ?? cz.countryId, iso: cz.iso ?? cz.code ?? cz.name } : 'not-found';
  const czId = cz?.id ?? cz?.countryId;
  if (czId !== undefined) await rq('A12 setCountry (same-value id ' + czId + ')', 'POST', S + '/v1/setCountry', { countryId: czId }, true);

  // A13 set ISIC — empty value (expect validation error, nothing persisted)
  await rq('A13 setIsic (empty → validation error)', 'POST', S + '/v1/setIsic', { isic: '' }, true);

  // B8 add gift — empty codes (expect app-level error)
  await rq('B8 addGift (empty rangeIdsGiftCodes)', 'POST', S + '/v2/addGift', { rangeIdsGiftCodes: [] });

  // O10 feedback — empty text/info (expect validation error, nothing stored)
  await rq('O10 feedback (empty text/info)', 'POST', S + '/v1/feedback', { text: '', info: '' }, true);
  await rq('O10 feedback (no auth, empty)', 'POST', S + '/v1/feedback', { text: '', info: '' });

  return out;
}, { BEARER, USERID, EMAIL });
out.steps = steps;
writeFileSync('/home/dev/Development/alza-mcp/docs/live-evidence/verification-sweep-followup3-2026-09-09.json', JSON.stringify(out, null, 1));
for (const s of steps) console.log(String(s.name).padEnd(48), String(s.status ?? '').padEnd(5), String(s.error ?? '').slice(0, 60), (s.body ?? '').replace(/\s+/g, ' ').slice(0, 160));
await browser.close();
