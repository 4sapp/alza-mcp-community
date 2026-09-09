import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = await page.evaluate(async () => {
  const o = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const rq = async (name, url, method = 'GET', body) => {
    const headers = { 'Accept': 'application/json', 'Balancer-Guid': crypto.randomUUID(), 'x-correlation-id': crypto.randomUUID() };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
    const t = await r.text();
    o.push({ name, status: r.status, body: t.slice(0, 260) });
    return t;
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const W = 'https://www.alza.cz/Services/EShopService.svc';
  // GetZipCodes body-field variants (PascalCase, DataContract-style)
  for (const body of [{ Search: 'Hradec Králové' }, { Input: 'Hradec Králové' }, { ZipCode: '50004' }, { Value: '50004' }, { Text: 'Hradec Králové' }, { Query: '50004' }]) {
    await rq('GetZipCodes ' + JSON.stringify(body), W + '/GetZipCodes', 'POST', body);
  }
  // basket + D1 action scan
  await rq('basket add', 'https://www.alza.cz/api/basket/v1/items', 'POST', { items: [{ commodityId: 5303618, count: 1 }] });
  const gp = await rq('D1 v13 (with basket)', S + '/v13/getDeliveryPaymentGroups');
  const gpj = j(gp);
  const dels = (gpj?.deliveryGroups ?? []).flatMap((g) => g.deliveries ?? []);
  const has = (x) => x.afterSelectAction || x.afterDeselectAction;
  o.push({ name: 'D1 action scan', deliveries: dels.length, withActions: dels.filter(has).length, sampleNullFields: Object.keys(dels[0] ?? {}).filter((k) => /action/i.test(k)).map((k) => k + '=' + (dels[0][k] ? 'present' : 'null')), payments: (gpj?.payments ?? []).length, paymentsWithActions: (gpj?.payments ?? []).filter(has).length, alzaPlusBanner: gpj?.alzaPlusActionBannerAction ? 'present' : 'null' });
  // chatbot: navigation with country; chat with listCategoryId variants
  const vid = crypto.randomUUID();
  const nav = await rq('chatbot navigation ?country=CZ', `https://chatbotapi.alza.cz/api/visitors/${vid}/v1/navigation?country=CZ`);
  o.push({ name: 'chatbot nav keys', keys: Object.keys(j(nav) ?? {}).slice(0, 10) });
  const c1 = await rq('chat POST listCategoryId:[]', `https://chatbotapi.alza.cz/api/visitors/${vid}/v1/chat?country=CZ`, 'POST', { country: 'CZ', pageType: 1, forceInitialize: false, initialInput: null, referrer: 'https://www.alza.cz/', listCategoryId: [] });
  const cj1 = j(c1);
  o.push({ name: 'chat [] result', configId: cj1?.configuration?.configId, teamName: cj1?.configuration?.teamName, showChat: cj1?.showChat, keys: Object.keys(cj1 ?? {}).slice(0, 6) });
  const c2 = await rq('chat POST listCategoryId:[{0,0}]', `https://chatbotapi.alza.cz/api/visitors/${vid}/v1/chat?country=CZ`, 'POST', { country: 'CZ', pageType: 1, forceInitialize: false, initialInput: null, referrer: 'https://www.alza.cz/', listCategoryId: [{ categoryId: 0, categoryTypeId: 0 }] });
  const cj2 = j(c2);
  o.push({ name: 'chat [{0,0}] result', configId: cj2?.configuration?.configId, teamName: cj2?.configuration?.teamName, showChat: cj2?.showChat });
  return o;
});
fs.writeFileSync('/tmp/p2-probe2.json', JSON.stringify({ date: '2026-09-09', steps: out }, null, 1));
for (const s of out) console.log(String(s.name ?? '').padEnd(42), String(s.status ?? '').padEnd(5), (s.body || JSON.stringify(s.keys ?? s.withActions ?? s.configId ?? '')).replace(/\s+/g, ' ').slice(0, 190));
await browser.close();
