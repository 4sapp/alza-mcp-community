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
    o.push({ name, status: r.status, body: t.slice(0, 300) });
    return t;
  };
  const S = 'https://www.alza.cz/services/restservice.svc';
  const W = 'https://www.alza.cz/Services/EShopService.svc';
  // 1) GetZipCodes input shapes
  await rq('GetZipCodes {} (baseline)', W + '/GetZipCodes', 'POST', {});
  await rq('GetZipCodes {input:"Hradec Králové"}', W + '/GetZipCodes', 'POST', { input: 'Hradec Králové' });
  await rq('GetZipCodes {input:"50004"}', W + '/GetZipCodes', 'POST', { input: '50004' });
  await rq('GetZipCodes {input:"50004", deliveryId:2680}', W + '/GetZipCodes', 'POST', { input: '50004', deliveryId: 2680 });
  // 2) D1 v13 full: are afterSelectAction/afterDeselectAction ever non-null?
  const gp = await rq('D1 v13 full', S + '/v13/getDeliveryPaymentGroups');
  const gpj = j(gp);
  const scan = (items, kind) => (items ?? []).map((x) => ({ id: x.id ?? x.deliveryId ?? x.paymentId, afterSelect: x.afterSelectAction ? (x.afterSelectAction.appLink ?? 'present') : null, afterDeselect: x.afterDeselectAction ? 'present' : null })).filter((x) => x.afterSelect || x.afterDeselect || kind === 'all');
  const dels = (gpj?.deliveryGroups ?? []).flatMap((g) => g.deliveries ?? []);
  o.push({ name: 'D1 action scan', deliveriesTotal: dels.length, deliveriesWithActions: scan(dels).filter((x) => x.afterSelect || x.afterDeselect).slice(0, 4), paymentsWithActions: scan(gpj?.payments).filter((x) => x.afterSelect || x.afterDeselect).slice(0, 4), firstDeliveryFields: Object.keys(dels[0] ?? {}).filter((k) => /action/i.test(k)) });
  // 3) chatbot family (cross-host)
  const vid = crypto.randomUUID();
  const nav = await rq('chatbot navigation', `https://chatbotapi.alza.cz/api/visitors/${vid}/v1/navigation`);
  o.push({ name: 'chatbot nav keys', keys: Object.keys(j(nav) ?? {}).slice(0, 8) });
  const chat = await rq('chatbot chat POST (pageType 1 product context)', `https://chatbotapi.alza.cz/api/visitors/${vid}/v1/chat?country=CZ`, 'POST', { country: 'CZ', pageType: 1, forceInitialize: false, initialInput: null, referrer: 'https://www.alza.cz/', commodityType: 0, commodityCode: null, entityId: null, listCategoryId: null, seoPrefix: null, manufacturer: null });
  const cj = j(chat);
  o.push({ name: 'chat POST shape', keys: Object.keys(cj ?? {}).slice(0, 6), configId: cj?.configuration?.configId, teamName: cj?.configuration?.teamName, welcomeText: cj?.configuration?.welcomeText, sessionExist: cj?.configuration?.sessionExist, showChat: cj?.showChat });
  return o;
});
fs.writeFileSync('/tmp/p2-probe.json', JSON.stringify({ date: '2026-09-09', steps: out }, null, 1));
for (const s of out) console.log(String(s.name ?? '').padEnd(44), String(s.status ?? '').padEnd(5), (s.body || JSON.stringify(s.keys ?? s.deliveriesWithActions ?? s.firstDeliveryFields ?? '')).replace(/\s+/g, ' ').slice(0, 200));
await browser.close();
