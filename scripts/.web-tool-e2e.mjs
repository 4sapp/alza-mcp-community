import { chromium } from 'playwright';
import fs from 'fs';

// Live verification 2026-09-08 of the new-goal task-6 implementations:
//  - G2: getDeliveryPaymentGroups v13 (live-verified)
//  - G3: personalPickup/v1 pickup family (form + list + detail)
//  - G1: the exact WCF chain + bodies of alza_web_place_order /
//    alza_web_pay_after_order (SaveOrder2 → SaveOrder3 →
//    SaveAndConfirmOrder2 [113-gate retry] → CheckOrder4 → SendOrder4;
//    then GetAfterPaymentDialog → CreateAfterPayment 144 MojePlatba).
// Minimal-cost real order: book FKP0383232 (35 CZK) + AlzaBox.
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);

const out = { date: '2026-09-08', steps: [] };
const rec = (name, data) => { out.steps.push({ step: name, ...data }); };

const res = await page.evaluate(async () => {
  const steps = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
  const wcf = async (op, body) => {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), credentials: 'include',
    });
    const p = j(await r.text());
    const d = (p && typeof p === 'object' && 'd' in p) ? p.d : p;
    steps.push({ op, status: r.status, errorLevel: d ? d.ErrorLevel : null, message: d ? d.Message : null, body: d });
    return d;
  };

  // 1) minimal-cost item into the guest basket
  let add;
  {
    const r = await fetch('https://www.alza.cz/services/restservice.svc/v2/basket/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ code: 'FKP0383232', amount: 1 }), credentials: 'include',
    });
    add = j(await r.text());
    steps.push({ step: 'basket/add FKP0383232', status: r.status, item: add && add.data ? { name: add.data.name, price: add.data.price, orderItemId: add.data.orderItemId } : add });
  }

  // 2) G2: v13 live + live gid + the server-driven pickup deliveryOption href
  let gid = null, pickupFormHref = null, alzaBoxPrice = null;
  {
    const r = await fetch('https://www.alza.cz/services/restservice.svc/v13/getDeliveryPaymentGroups', { headers: { Accept: 'application/json' }, credentials: 'include' });
    const gp = j(await r.text());
    if (gp && Array.isArray(gp.deliveryGroups)) {
      for (const g of gp.deliveryGroups) {
        if (!gid && g.deliveryGroupId) gid = g.deliveryGroupId;
        for (const d of g.deliveries || []) {
          if (d.id === 2680) alzaBoxPrice = d.priceDecimal;
          if (d.deliveryOption && d.deliveryOption.href) pickupFormHref = d.deliveryOption.href;
        }
      }
    }
    steps.push({ step: 'G2 getDeliveryPaymentGroups v13', status: r.status, liveGroupId: gid, alzaBoxPrice, pickupFormHref });
  }
  // basket orderId for the pickup family (from the deliveryOption href)
  let basketOrderId = null;
  if (pickupFormHref) { const m = pickupFormHref.match(/orderId=(\d+)/); if (m) basketOrderId = Number(m[1]); }

  // 3) G3: the personalPickup/v1 family (form → list → detail)
  let placeDetail = null, parcelShopId = null, placeId = null;
  {
    const formR = await fetch(`https://www.alza.cz/api/personalPickup/v1/pickupPlaceForm?orderId=${basketOrderId}&groupId=${gid}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const form = j(await formR.text());
    steps.push({ step: 'G3 pickupPlaceForm', status: formR.status, types: form && form.types ? form.types.map(t => ({ type: t.type, name: t.name, count: t.count })) : form });
    const listR = await fetch(`https://www.alza.cz/api/personalPickup/v1/places?types[0]=1&latitude=50.105&longitude=14.238&orderId=${basketOrderId}&groupId=${gid}&limit=1&offset=0`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const list = j(await listR.text());
    const items = list && list.pickupPlaces && list.pickupPlaces.items ? list.pickupPlaces.items : (list && list.pickupPlaces ? list.pickupPlaces : []);
    const first = Array.isArray(items) ? items[0] : (items && items[0]);
    placeId = first ? (first.id ?? first.placeId) : null;
    steps.push({ step: 'G3 pickup places list', status: listR.status, firstPlace: first ? { id: placeId, name: first.name, deliveryId: first.deliveryId } : null, rawKeys: list && list.pickupPlaces ? Object.keys(list.pickupPlaces) : [] });
    if (placeId) {
      const detR = await fetch(`https://www.alza.cz/api/personalPickup/v1/places/${placeId}?orderId=${basketOrderId}&groupId=${gid}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
      placeDetail = j(await detR.text());
      parcelShopId = placeDetail && placeDetail.parcelShopId;
      steps.push({ step: 'G3 pickup place detail', status: detR.status, detail: { id: placeId, deliveryId: placeDetail && placeDetail.deliveryId, parcelShopId, isFree: placeDetail && placeDetail.isFree, typeText: placeDetail && placeDetail.typeText, standardPrice: placeDetail && placeDetail.detail ? placeDetail.detail.standardPrice : null } });
    }
  }

  // 4) G1 order: the exact alza_web_place_order WCF chain
  const save2 = {
    selectedDeliveriesForGroups: [{ deliveryGroupId: gid, deliveryId: 2680, parcelShopId: parcelShopId ?? '1128203', deliveryAccesoriesIds: [] }],
    paymentId: 103, paymentCardId: 0, alzaPlusSubscriptionId: 0, cetelemLeasingId: 0,
  };
  const save3 = { registerUser: false, login: 'e2e-user@example.invalid', name: 'E2E Test', street: 'Example Street 2', city: 'Hradec Králové', zip: '50004', phone: '+420601234567', email: 'e2e-user@example.invalid', countryId: 0 };
  await wcf('SaveOrder2', save2);
  await wcf('SaveOrder3', save3);
  const confirm1 = await wcf('SaveAndConfirmOrder2 (1st)', save2);
  let confirm2 = null;
  if (Number(confirm1.ErrorLevel) === 113) {
    await new Promise((r) => setTimeout(r, 2000));
    confirm2 = await wcf('SaveAndConfirmOrder2 (retry)', save2);
  }
  await wcf('CheckOrder4', {});
  const send4 = await wcf('SendOrder4', { quotation: false, internalDescription: '', verificationId: null, verificationCode: null, userConsents: [{ consentId: '2', value: false }], basketConsents: [] });
  const orderDetail = send4 && send4.GetOrderDetailAction;
  const orderId = send4 && send4.OrderId;
  const webLink = orderDetail && (orderDetail.webLink || orderDetail.href);
  const hashM = webLink && webLink.match(/x=([A-Z0-9]+)/);
  const orderHash = hashM ? hashM[1] : null;
  steps.push({ step: 'G1 order created', orderId, errorLevel: send4 && send4.ErrorLevel, webLink, orderHash });

  // 5) order read (anonymous) — part id + status + amount
  let orderRead = null;
  if (orderId) {
    const r = await fetch(`https://www.alza.cz/api/anonymous/v1/orders/${orderId}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    orderRead = j(await r.text());
    const part = orderRead && orderRead.parts ? orderRead.parts[0] : null;
    steps.push({ step: 'order read (pre-payment)', status: r.status, part: part ? { partId: part.id ?? part.partId, status: part.status, price: part.price ?? part.priceWithVat } : null, topStatus: orderRead && orderRead.status, keys: orderRead ? Object.keys(orderRead).slice(0, 20) : [] });
  }

  // 6) G1 payment: dialog (PA8 read) + CreateAfterPayment 144 MojePlatba (PA9)
  let partId = null;
  if (orderRead && orderRead.parts && orderRead.parts[0]) partId = orderRead.parts[0].id ?? orderRead.parts[0].partId;
  let dialogMethods = null;
  {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/GetAfterPaymentDialog', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ orderId: String(orderId), invoiceId: null, price: null, isPartialPay: false, isSwitchToCashAvailable: false, orderHash: orderHash ?? '' }),
      credentials: 'include',
    });
    const p = j(await r.text());
    const d = (p && typeof p === 'object' && 'd' in p) ? p.d : p;
    // the dialog HTML embeds the payment methods; capture the value + any method ids
    const html = (d && d.Value) || '';
    dialogMethods = [...new Set((html.match(/\b(213|216|219|143|144|203|103)\b/g) || []))];
    steps.push({ step: 'G1 GetAfterPaymentDialog (read)', status: r.status, errorLevel: d ? d.ErrorLevel : null, methodIdsInDialog: dialogMethods });
  }
  let payment = null;
  {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/CreateAfterPayment', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ orderId: String(orderId), paymentId: 144, hash: orderHash ?? '', enableAD: false, invoiceId: '0', price: null, smsCode: null, smsId: 0, isTrusted: false, amountToPay: null, headerId: null, orderPaymentId: '0' }),
      credentials: 'include',
    });
    const p = j(await r.text());
    const d = (p && typeof p === 'object' && 'd' in p) ? p.d : p;
    payment = { status: r.status, errorLevel: d ? d.ErrorLevel : null, message: d ? d.Message : null, value: d && (d.Value || d.urlNext || d.url_next) };
    steps.push({ step: 'G1 CreateAfterPayment 144 MojePlatba', ...payment });
  }

  // 7) final order state
  if (orderId) {
    const r = await fetch(`https://www.alza.cz/api/anonymous/v1/orders/${orderId}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const orderRead2 = j(await r.text());
    const part = orderRead2 && orderRead2.parts ? orderRead2.parts[0] : null;
    steps.push({ step: 'order read (final)', status: r.status, part: part ? { partId: part.id ?? part.partId, status: part.status } : null, topStatus: orderRead2 && orderRead2.status });
  }

  return { steps, orderId, orderHash, parcelShopId, gid };
});

out.steps.push(...res.steps);
out.order_id = res.orderId;
out.order_hash = res.orderHash;
out.parcel_shop_id = res.parcelShopId;
out.group_id = res.gid;
const p = '/home/dev/Development/alza-mcp/docs/live-evidence/web-tool-e2e-2026-09-08.json';
fs.writeFileSync(p, JSON.stringify(out, null, 1));
for (const s of res.steps) {
  const extra = s.body ? JSON.stringify(s.body).slice(0, 160) : '';
  console.log(`${s.status ?? '-'} ${s.step} ${s.errorLevel !== undefined ? 'ErrorLevel=' + s.errorLevel + ' ' : ''}${(s.message || '').slice(0, 60)} ${extra.slice(0, 140)}`);
}
console.log('ORDER:', res.orderId, 'HASH:', res.orderHash, 'PARCEL:', res.parcelShopId);
await browser.close();
