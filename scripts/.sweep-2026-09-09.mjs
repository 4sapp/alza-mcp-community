import { chromium } from 'playwright';
import fs from 'fs';
import { readFileSync } from 'fs';
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
const j = (t) => { try { return JSON.parse(t); } catch { return null; } };
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
      out.push({ name, method, url: url.replace('https://www.alza.cz', ''), status: r.status, cf: r.headers.get('cf-mitigated') || undefined, body: text.slice(0, 260), parsed: p && typeof p === 'object' ? { err: p.err ?? p.error ?? (p.d && p.d.err), keys: Object.keys(p).slice(0, 8) } : undefined });
      return { r, text, p };
    } catch (e) { out.push({ name, method, url, error: String(e).slice(0, 200) }); return {}; }
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const sel = (gid, deliveryId, parcelShopId) => ({ deliveryGroupId: gid, deliveryId, deliveryServicesIds: [], parcelShopId, timeFrameId: 0, timeSlotId: 0 });
  // basket setup: web add → basketId; restservice add → cart state
  const add = await rq('setup: web basket add', 'POST', 'https://www.alza.cz/api/basket/v1/items', { items: [{ commodityId: 5303618, count: 1 }] });
  const addMatch = JSON.stringify(add.p ?? add.text).match(/order\/(\d+)\/item\/(\d+)/);
  const basketId = addMatch ? addMatch[1] : null;
  await rq('setup: restservice basket/add', 'POST', S + '/v2/basket/add', { code: 'FKP0383232', amount: 1 });
  // C2 category tree node
  await rq('C2 category/{id}', 'GET', S + '/v1/category/1?type=CATEGORY&typeId=0');
  // C5 legacy product detail
  const c5 = await rq('C5 legacy product detail', 'GET', 'https://www.alza.cz/api/legacy/catalog/v14/product/5303618?pgrik=&ucik=&country=CZ');
  // C6 router product detail
  await rq('C6 router product detail', 'GET', 'https://www.alza.cz/api/router/legacy/catalog/product/5303618');
  // C8 EAN list — EAN extracted from C5
  const eanMatch = JSON.stringify(c5.p ?? c5.text ?? '').match(/"eans?"\s*:\s*\[?\s*"?(\d{8,14})/);
  if (eanMatch) await rq('C8 getProductByEANlist (ean from C5: ' + eanMatch[1] + ')', 'POST', S + '/v1/getProductByEANlist', { eanList: [eanMatch[1]] });
  else out.push({ name: 'C8 skipped', reason: 'no EAN found in C5' });
  // A8 login-name validation
  await rq('A8 validateLoginName', 'GET', S + '/v1/validateLoginName?email=probe-' + Math.random().toString(36).slice(2, 8) + '@1secmail.com');
  // A9 ISIC validation
  await rq('A9 validateIsic (dummy card)', 'POST', S + '/v2/validateIsic', { cardNumber: '0', name: 'E2E Probe' });
  // B4 basket update (flag 0 / not delayed — neutral)
  if (basketId) await rq('B4 updBasket (basketId ' + basketId + ')', 'GET', S + '/v2/updBasket/' + basketId + '/0?isDelayedPayment=false');
  // B5 unlock basket
  await rq('B5 unlockbasket', 'POST', S + '/v1/unlockbasket');
  // D1 v13 → gid
  const gp = await rq('D1 getDeliveryPaymentGroups v13', 'GET', S + '/v13/getDeliveryPaymentGroups');
  const gid = ((gp.p?.deliveryGroups ?? []).find((g) => g.deliveryGroupId) || {}).deliveryGroupId;
  // D2 associations
  const d2 = await rq('D2 getDeliveryAssociations', 'POST', S + '/v4/getDeliveryAssociations', { cardId: 0, deliveryGroups: [sel(gid, 2680, 0)] });
  const assocCount = Array.isArray(d2.p?.data) ? d2.p.data.length : undefined;
  out.push({ name: 'D2 associations count', count: assocCount });
  // O1 checkout state step 1
  await rq('O1 sendOrder1', 'GET', S + '/v4/sendOrder1');
  // O6 order2 info
  await rq('O6 getOrder2Info', 'GET', S + '/v8/getOrder2Info');
  // G5 re-test: sendOrder2 → sendOrder3
  const so2 = await rq('G5 sendOrder2', 'POST', S + '/v7/sendOrder2', { deliveryGroups: [sel(gid, 2680, '1128203')], paymentId: 103, paymentCardId: 0, selectedDeliveryOptionId: 2680 });
  await rq('G5 sendOrder3 (expect 500)', 'POST', S + '/v5/sendOrder3', { parameters: { email: EMAIL } });
  // G6 re-test (auth)
  await rq('G6 getafterorderpayments (expect err:1)', 'GET', S + '/v2/getafterorderpayments/1056808137/1070772578', undefined, true);
  await rq('G6 afterOrderPayment (expect err:1)', 'POST', 'https://www.alza.cz/api/orders/v4/afterOrderPayment', { id: '1056808137', invoiceNumber: '1070772578', paymentId: 144 }, true);
  // A7 premium trial (auth)
  await rq('A7 alzapremium/trial', 'GET', 'https://www.alza.cz/api/user/' + USERID + '/v1/alzapremium/trial', undefined, true);
  // O4 approve order (auth)
  await rq('O4 approveOrder4', 'GET', S + '/v1/approveOrder4', undefined, true);
  return out;
}, { BEARER, USERID, EMAIL });
out.steps = steps;
fs.writeFileSync('/tmp/sweep-2026-09-09.json', JSON.stringify(out, null, 1));
for (const s of steps) if (!s.name.startsWith('setup')) console.log(s.name.padEnd(44), String(s.status ?? s.error ?? s.reason).padEnd(5), (s.body || '').replace(/\s+/g, ' ').slice(0, 110));
await browser.close();
