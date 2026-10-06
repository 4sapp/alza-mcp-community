/**
 * Alza's native price/stock watchdog ("Hlídací pes", rows B9, B9a, B9b).
 *
 * Route discovery (2026-10-06): no APK decompile was available, so the routes
 * come from the server's own hypermedia plus the www.alza.cz web bundle:
 * - user navigation `watchDogs` → `GET /api/users/{id}/v1/watchDogs` →
 *   `commodities` (the list, B9a);
 * - web bundle `default.js` opens `/api/v1/users/{id}/products/{commodityId}/watchdogDialog`
 *   (`productAvailabilityWatchdogDialog`) — its form is the create target and
 *   its `deleteAction` (`removeProductAvailabilityWatchdog`) the delete target.
 * Create + delete were live-verified back to back on a 19 Kč product with no
 * orphan left (docs/live-evidence/watchdog-b9-2026-10-06.md).
 *
 * The account email is part of the create DTO (Alza pre-fills it in the
 * dialog) but is never surfaced in tool output.
 */

export const WATCHDOG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATCHDOG_ID_IN_PATH = /\/(?:watchdog\/v1|watchDogs)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/i;

export interface WatchdogEntry {
  watchdog_id: string | null;
  commodity_id: number | null;
  name: string | null;
  url: string | null;
  current_price: number | null;
  availability: string | null;
  is_tracking_stock: boolean | null;
  /** Alert threshold ("notify when the price drops below"); null = not tracking price. */
  max_price: number | null;
}

export interface WatchdogDialogState {
  /** Present when a watchdog already exists for this product. */
  existingWatchdogId: string | null;
  /** Login email Alza pre-fills; sent back in the create DTO, never surfaced. */
  email: string | null;
  /** The form's `price.max` (= current price); the threshold must be below it. */
  priceMax: number | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function hrefOf(value: unknown): string | undefined {
  const o = asObject(value);
  if (!o) return undefined;
  if (typeof o.href === "string") return o.href;
  const form = asObject(o.form);
  return typeof form?.href === "string" ? form.href : undefined;
}

export function watchdogIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const m = WATCHDOG_ID_IN_PATH.exec(href);
  const id = m?.[1];
  return id ? id.toLowerCase() : null;
}

function formFields(form: unknown): Map<string, Json> {
  const out = new Map<string, Json>();
  const values = asObject(form)?.value;
  if (Array.isArray(values)) {
    for (const v of values) {
      const field = asObject(v);
      if (field && typeof field.name === "string") out.set(field.name, field);
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Read the watchdog dialog: does a watchdog exist, and what does the create form expect. */
export function parseWatchdogDialog(raw: unknown): WatchdogDialogState {
  const dialog = asObject(raw) ?? {};
  const fields = formFields(dialog.form);
  const deleteHref = hrefOf(dialog.deleteAction);
  return {
    existingWatchdogId: deleteHref ? watchdogIdFromHref(deleteHref) ?? "unknown" : null,
    email: str(fields.get("email")?.value),
    priceMax: num(fields.get("price")?.max),
  };
}

/** Normalise the `watchDogs/commodities` list into typed entries. */
export function parseWatchdogList(raw: unknown): { items: WatchdogEntry[]; hasMore: boolean; emptyMessage: string | null } {
  const body = asObject(raw) ?? {};
  const values = Array.isArray(body.value) ? body.value : [];
  const items = values.map((v): WatchdogEntry => {
    const item = asObject(v) ?? {};
    const update = formFields(item.updateForm);
    const detailHref = hrefOf(item.commodityDetail);
    const url = str(item.commodityUrl);
    const idMatch = (detailHref && /\/product\/(\d+)/.exec(detailHref)) || (url && /-d(\d+)\.htm/.exec(url));
    const priceInfo = asObject(item.priceInfoV2);
    const tracking = update.get("isTrackingStock")?.value;
    return {
      watchdog_id: watchdogIdFromHref(hrefOf(item.updateForm)) ?? watchdogIdFromHref(hrefOf(item.deleteAction)),
      commodity_id: idMatch ? Number(idMatch[1]) : null,
      name: str(item.commodityName),
      url,
      current_price: num(priceInfo?.priceNoCurrency),
      availability: str(item.availabilityText),
      is_tracking_stock: typeof tracking === "boolean" ? tracking : null,
      max_price: num(update.get("price")?.value),
    };
  });
  const paging = asObject(body.paging);
  return { items, hasMore: Boolean(paging?.next), emptyMessage: str(asObject(body.emptyInfo)?.message) };
}
