/**
 * Concise, human/LLM-readable summaries for the large account envelopes.
 * The full upstream envelope is always preserved in `structuredContent` —
 * the text channel only needs the high-signal fields (per the MCP
 * best-practices audit, docs/mcp-best-practices-audit.md F-06).
 * All formatters are defensive: unknown/missing fields are skipped, never thrown on.
 */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A scalar identifier (string or number) — Alza mixes both across endpoints. */
function scalar(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

const FOOTER = "_Full envelope (identifiers, line details, raw fields) is in structuredContent._";

import type { ToolResult } from "./types.js";
import { toStructuredContent } from "./structured.js";

/** Tool result with a concise text channel; the full envelope stays in structuredContent. */
export function withConciseText(value: unknown, format: (v: unknown) => string): ToolResult {
  let text: string;
  try {
    text = capText(format(value));
  } catch {
    text = capText(JSON.stringify(value, null, 2) ?? "null");
  }
  return { content: [{ type: "text", text }], structuredContent: toStructuredContent(value) };
}

export function formatCart(env: unknown): string {
  const top = asRecord(env) ?? {};
  const info = asRecord(top.info) ?? {};
  const items = asRecord(top.items) ?? {};
  const lines: string[] = [];
  if (num(info.err) === 1) {
    lines.push("# Alza cart", "", `Alza rejected the read (err:1): ${str(info.msg) ?? "no message"}.`);
    return lines.join("\n");
  }
  const userId = num(info.user_id);
  lines.push(`# Alza cart${userId !== undefined ? ` (user ${userId})` : ""}`);
  const cnt = num(info.basket_cnt);
  if (cnt !== undefined) lines.push(`${cnt} item line(s)${str(info.pricePay) ? ` · total ${info.pricePay}` : ""}`);
  if (str(info.email)) lines.push(`account: ${info.email}`);
  if (str(info.orderId)) lines.push(`orderId: ${info.orderId}`);
  const data = Array.isArray(items.data) ? items.data : undefined;
  if (data) {
    lines.push("", "## Items");
    for (const row of data) {
      const r = asRecord(row);
      if (!r) continue;
      const name = str(r.name) ?? str(r.code) ?? "item";
      const code = str(r.code);
      const count = num(r.count);
      const price = str(r.priceVat) ?? str(r.price);
      lines.push(`- ${count !== undefined ? `${count}× ` : ""}${name}${code ? ` (${code})` : ""}${price ? ` — ${price}` : ""}`);
    }
  } else if (str(items.msg)) {
    lines.push("", `items: ${items.msg}`);
  }
  const vouchers = num(items.vouchers_cnt);
  if (vouchers !== undefined) lines.push(`vouchers: ${vouchers}`);
  lines.push("", FOOTER);
  return lines.join("\n");
}

/** Without a valid token Alza still answers the `user_data` read with HTTP 200, but with
 * an anonymous account: `user_id: -1` and a null e-mail (observed 2026-10-07). */
export function isAnonymousUserData(env: unknown): boolean {
  return num(asRecord(env)?.user_id) === -1;
}

export const ANONYMOUS_NOTE =
  "Not signed in: Alza returned the anonymous account (`user_id: -1`). Account data below is not the user's. Check `account_status`, then sign in with `auth_start` / `auth_exchange`.";

export function formatProfile(env: unknown): string {
  const top = asRecord(env) ?? {};
  if (num(top.err) === 1) return `# Alza profile\n\nAlza rejected the read (err:1): ${str(top.msg) ?? "no message"}.`;
  if (isAnonymousUserData(top)) return `# Alza profile: not signed in\n\n${ANONYMOUS_NOTE}\n\n${FOOTER}`;
  const lines: string[] = [];
  const userId = num(top.user_id);
  lines.push(`# Alza profile${userId !== undefined ? ` (user ${userId})` : ""}`);
  if (str(top.user_name)) lines.push(`name: ${top.user_name}`);
  if (str(top.email)) lines.push(`email: ${top.email}`);
  const addr = num(top.deliveryaddress_cnt);
  if (addr !== undefined) lines.push(`delivery addresses: ${addr} (per-address actions in structuredContent — pass them to address_upsert/address_delete/address_search)`);
  const baskets = num(top.baskets_cnt);
  if (baskets !== undefined) lines.push(`baskets: ${baskets}`);
  if (top.vip === true) lines.push("vip: yes");
  if (top.twoFactorAuth === true) lines.push("two-factor auth: enabled");
  lines.push("", FOOTER);
  return lines.join("\n");
}

export function formatAddToCart(env: unknown): string {
  const top = asRecord(env) ?? {};
  const lines: string[] = ["# Added to Alza cart"];
  if (num(top.err) === 1) {
    lines.push("", `Alza rejected the add (err:1): ${str(top.msg) ?? "no message"}.`);
    lines.push("", FOOTER);
    return lines.join("\n");
  }
  const data = asRecord(top.data);
  if (data) {
    lines.push(`- ${str(data.name) ?? str(data.code) ?? "product"}${scalar(data.code) ? ` (${data.code})` : ""}${num(data.count) !== undefined ? ` × ${data.count}` : ""}`);
    if (scalar(data.orderItemId)) lines.push(`orderItemId: ${data.orderItemId}`);
  }
  const cnt = num(top.basket_cnt);
  if (cnt !== undefined) lines.push(`cart now holds ${cnt} line(s)`);
  const orderTotal = str(asRecord(top.order)?.priceToPay);
  if (orderTotal) lines.push(`cart total: ${orderTotal}`);
  lines.push("", FOOTER);
  return lines.join("\n");
}

export function formatOrder(env: unknown): string {
  const top = asRecord(env) ?? {};
  const order = asRecord(top.order);
  const lines: string[] = ["# Alza order"];
  if (order && num(order.err) === 1) {
    // Issue #79: the order read itself carries the rejection (`{order: {err: 1, msg}}`).
    lines.push("", `Alza rejected the read (err:1): ${str(order.msg) ?? "no message"}.`);
  } else if (order) {
    const id = scalar(order.orderId) ?? scalar(order.order_id);
    if (id) lines.push(`orderId: ${id}`);
    const status = str(order.orderStatus) ?? str(order.status) ?? str(order.statusDesc);
    if (status) lines.push(`status: ${status}`);
    const total = str(order.priceVat) ?? str(order.pricePay) ?? str(order.totalPrice);
    if (total) lines.push(`total: ${total}`);
    if (str(order.email)) lines.push(`email: ${order.email}`);
    const parts = Array.isArray(order.parts) ? order.parts : undefined;
    if (parts) lines.push(`parts: ${parts.length}`);
  } else if (num(top.err) === 1) {
    lines.push("", `Alza rejected the read (err:1): ${str(top.msg) ?? "no message"}.`);
  }
  if (asRecord(top.part)) lines.push("", "part detail included (structuredContent).");
  lines.push("", FOOTER);
  return lines.join("\n");
}

export function formatCheckoutPreview(env: unknown): string {
  const top = asRecord(env) ?? {};
  const lines: string[] = ["# Checkout preview (order NOT submitted)"];
  const token = str(top.confirmationToken);
  if (token) lines.push(`confirmation token for place_order: ${token}`);
  const cart = top.cart;
  if (cart !== undefined) {
    try {
      const cartLines = formatCart(cart).split("\n");
      lines.push("", "## Cart", ...cartLines.slice(1));
    } catch {
      lines.push("", "cart: (see structuredContent)");
    }
  }
  const groups = asRecord(top.deliveryPaymentGroups);
  if (groups) {
    const deliveries = groups.deliveries ?? groups.delivery;
    const count = Array.isArray(deliveries) ? deliveries.length : undefined;
    lines.push(`delivery/payment groups: ${count !== undefined ? `${count} delivery option(s)` : "see structuredContent"} — pass a selected_delivery_option_id to delivery_options/checkout_preview as needed`);
  }
  lines.push("", "_Full preview (checkout state, all delivery/payment options) is in structuredContent._");
  return lines.join("\n");
}

/** Upper bound for the text channel (issue #73). Larger envelopes keep their
 * full data in structuredContent; the text gets a truncated preview + pointer. */
export const TEXT_CHANNEL_LIMIT = 20_000;

export function capText(text: string, limit = TEXT_CHANNEL_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [text truncated: showed ${limit} of ${text.length} characters. The complete result is in structuredContent.]`;
}

/** Generic JSON result: pretty JSON text (capped) + the full value as structuredContent (non-object bodies wrapped, #63). */
export function jsonResult(value: unknown): ToolResult {
  const structured = toStructuredContent(value);
  return { content: [{ type: "text", text: capText(JSON.stringify(structured, null, 2)) }], structuredContent: structured };
}

/** Strip tags/whitespace from Alza's HTML snippets (warnings, legends). */
function plain(v: unknown, max = 200): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const LIST_LIMIT = 60;

function optionLine(item: unknown): string | undefined {
  const r = asRecord(item);
  if (!r) return undefined;
  const id = scalar(r.id);
  const name = str(r.name) ?? "option";
  const extra = [str(r.itemType), str(r.groupName) ?? str(r.group), str(r.price)].filter(Boolean).join(", ");
  const href = str(asRecord(r.deliveryOption)?.href);
  return `- ${id !== undefined ? `[${id}] ` : ""}${name}${extra ? ` (${extra})` : ""}${href ? ` — deliveryOption.href: ${href}` : ""}`;
}

function listSection(title: string, items: unknown[], lines: string[]): void {
  lines.push("", `## ${title} (${items.length})`);
  for (const item of items.slice(0, LIST_LIMIT)) {
    const line = optionLine(item);
    if (line) lines.push(line);
  }
  if (items.length > LIST_LIMIT) lines.push(`- … ${items.length - LIST_LIMIT} more in structuredContent`);
}

function warningLines(warnings: unknown, lines: string[]): void {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  lines.push("", `## Notices (${warnings.length})`);
  for (const w of warnings.slice(0, 5)) {
    const t = plain(w);
    if (t) lines.push(`- ${t}`);
  }
}

/** `delivery_options` (getDeliveryPaymentGroups): ids, names and prices per group. */
export function formatDeliveryOptions(env: unknown): string {
  const top = asRecord(env) ?? {};
  const lines: string[] = ["# Alza delivery & payment options"];
  if (num(top.err) === 1) {
    lines.push("", `Alza rejected the read (err:1): ${str(top.msg) ?? "no message"}.`);
    return lines.join("\n");
  }
  const err = plain(top.deliveryError);
  if (err) lines.push(`delivery error: ${err}`);
  const groups = Array.isArray(top.deliveryGroups) ? top.deliveryGroups : [];
  for (const g of groups) {
    const group = asRecord(g);
    if (!group) continue;
    const deliveries = Array.isArray(group.deliveries) ? group.deliveries : [];
    listSection(`Delivery group ${scalar(group.deliveryGroupId) ?? "?"}: deliveries`, deliveries, lines);
  }
  if (Array.isArray(top.payments)) listSection("Payments", top.payments, lines);
  const tip = plain(top.deliveryTip) ?? plain(top.paymentTip);
  if (tip) lines.push("", `tip: ${tip}`);
  warningLines(top.warnings, lines);
  lines.push("", "Ids in [brackets] are the `selected_delivery_option_id` / `delivery_id` / `payment_id` values later steps take.", FOOTER);
  return lines.join("\n");
}

/** `payment_methods`: the payment projection of the delivery/payment groups. */
export function formatPaymentMethods(env: unknown): string {
  const top = asRecord(env) ?? {};
  const lines: string[] = ["# Alza payment methods"];
  listSection("Payments", Array.isArray(top.payments) ? top.payments : [], lines);
  const tip = plain(top.paymentTip);
  if (tip) lines.push("", `tip: ${tip}`);
  warningLines(top.warnings, lines);
  lines.push("", "Ids in [brackets] are the `payment_id` values `web_place_order`/checkout take.", FOOTER);
  return lines.join("\n");
}

/** `order_document`: metadata only; a binary body (base64 PDF) stays in structuredContent. */
export function formatOrderDocument(env: unknown): string {
  const top = asRecord(env) ?? {};
  const lines: string[] = [`# Order document${str(top.name) ? `: ${top.name}` : ""}`];
  if (str(top.contentType)) lines.push(`content type: ${top.contentType}`);
  const bytes = num(top.byteLength);
  if (bytes !== undefined) lines.push(`size: ${bytes} bytes`);
  if (str(top.href)) {
    try { lines.push(`source host: ${new URL(String(top.href)).hostname}`); } catch { /* metadata only */ }
  }
  if (typeof top.base64 === "string") lines.push("", "The binary body is in structuredContent.base64 (not repeated in this text).");
  else if (typeof top.text === "string") lines.push("", "## Text body", capText(top.text, TEXT_CHANNEL_LIMIT - 2_000));
  return lines.join("\n");
}
