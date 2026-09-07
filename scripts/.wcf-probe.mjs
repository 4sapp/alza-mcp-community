import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const candidates = [
 'LeaveOrder1','LeaveOrder2','LeaveOrder3','LeaveOrder4',
 'SaveOrder1','SaveOrder2','SaveOrder3','SaveOrder4',
 'SaveAndConfirmOrder1','SaveAndConfirmOrder2','SaveAndConfirmOrder3',
 'CheckOrder1','CheckOrder2','CheckOrder3','CheckOrder4','CheckOrder5',
 'SendOrder1','SendOrder2','SendOrder3','SendOrder4','SendOrder5',
 'VerifyUser','VerifyEmail','VerifyPhone',
 'GetAfterPaymentDialog','CreateAfterPayment','GetAfterOrderPayments','AfterOrderPayment',
 'GetOrderStatus','GetOrderDetail','GetOrderDetails','GetInvoice','GetInvoiceList','DownloadInvoice',
 'CancelOrder','CancelOrderPart','GetCancelOrderReasons',
 'GetAvailableCoupons','ApplyCoupon','ValidateCoupon','RemoveCoupon',
 'GetPaymentMethods','GetDeliveryMethods','GetDeliveryOptions',
 'GetPickupPlaces','GetPickupPoints','SelectPickupPoint','GetPickupTimeframes',
 'GetOrderConfirmation','GetOrderHelpdeskQuestions','GetOrderMessages',
 'GetOrderNotifications','SendOrderEmail','GetOrderDocuments','GetOrderParts',
 'GetAlzaPlusStatus','GetAlzaPremiumStatus','ActivateAlzaPlus','CancelAlzaPlus',
 'GetSubscriptionStatus','GetWarrantyClaims','SubmitWarrantyClaim',
 'GetShippingTimeframes','GetDeliveryTimeframes','GetBranches','GetZipCodes',
 'GetOrderStatistics','GetOrderProgress','GetOrderTimeline',
 'GetAvailablePayments','GetPaymentStatus','CreatePayment','GetPaymentLink',
 'GetOrderHash','ValidateOrderHash','GetOrderLink',
 'GetProductAvailability','GetBasketInfo','GetBasket','SaveBasket','GetCoupons',
 'GetPromotions','GetGiftOptions','GetOrderServices','AddOrderService',
 'GetOrderAddInfo','GetOrder2Info','GetOrder3Info',
 'GetOrder','GetOrders','GetMyOrders','GetUnpaidOrders',
];
const res = await page.evaluate(async (ops) => {
  const out = {};
  for (const op of ops) {
    try {
      const r = await fetch(`/Services/EShopService.svc/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({}),
      });
      const t = await r.text();
      out[op] = { status: r.status, body: t.slice(0, 220) };
    } catch (e) {
      out[op] = { status: -1, body: String(e).slice(0, 120) };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}, candidates);
fs.writeFileSync('/tmp/wcf-probe.json', JSON.stringify(res, null, 1));
for (const [op, v] of Object.entries(res)) {
  const html = /<!DOCTYPE html/i.test(v.body || '');
  const tag = html ? 'CF-HTML' : (v.status >= 400 ? 'ERR' : 'OK');
  console.log(`${v.status} ${tag.padEnd(7)} ${op.padEnd(28)} ${(v.body || '').slice(0, 100).replace(/\n/g, ' ')}`);
}
await browser.close();
