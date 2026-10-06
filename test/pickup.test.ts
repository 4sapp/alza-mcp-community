import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Pickup, parseSalesNetworkPlaces } from "../src/domain/pickup.js";
import { resolveLocale } from "../src/infra/locale.js";
import { formatPickupPoints } from "../src/tools/format.js";
import { FIND_PICKUP_POINTS_OUTPUT } from "../src/tools/output-schemas.js";

// Recorded 2026-10-06 from GET https://www.alza.cz/api/salesNetwork/v1/places
// (anonymous, no cart), trimmed to the 3 nearest AlzaBoxes to 500 02.
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/sales-network-places.json", import.meta.url), "utf8"),
) as unknown;

const HK = { lat: 50.2092, lng: 15.8328 };
const cz = resolveLocale("https://www.alza.cz");

function pickupWith(getJson: (url: string) => Promise<unknown>) {
  return new Pickup(cz, { getJson, geocode: async () => HK });
}

describe("parseSalesNetworkPlaces", () => {
  it("maps recorded AlzaBox places to lockers", () => {
    const lockers = parseSalesNetworkPlaces(FIXTURE);
    expect(lockers).toHaveLength(3);
    expect(lockers[0]).toEqual({
      id: "1141354-2680",
      deliveryId: 2680,
      parcelShopId: 1141354,
      name: "Hradec Králové (Podnikatelské centrum)",
      address: "Hradecká 1151/9",
      city: "Hradec Králové",
      postalCode: "500 03",
      latitude: 50.203787,
      longitude: 15.834234,
    });
  });

  it("drops non-AlzaBox entries and entries without GPS", () => {
    const value = (FIXTURE as { pickupPlaces: { value: Array<Record<string, unknown>> } }).pickupPlaces.value;
    const mixed = {
      pickupPlaces: {
        value: [
          { ...value[0], type: 2, typeText: "AlzaBranch" },
          { ...value[1], gpsPosition: null },
          value[2],
        ],
      },
    };
    expect(parseSalesNetworkPlaces(mixed).map((l) => l.parcelShopId)).toEqual([1009136]);
  });

  it("rejects an unexpected shape instead of returning an empty list", () => {
    expect(() => parseSalesNetworkPlaces({ Message: "The request is invalid." })).toThrow(/unexpected response shape/);
  });
});

describe("Pickup.findPickupPoints (AlzaBox)", () => {
  it("returns lockers from the public salesNetwork API without any cart ids", async () => {
    const getJson = vi.fn(async () => FIXTURE);
    const { points, warnings } = await pickupWith(getJson).findPickupPoints({ postalCode: "500 02", types: ["alzabox"] });
    expect(warnings).toEqual([]);
    expect(points.map((p) => p.type)).toEqual(["alzabox", "alzabox", "alzabox"]);
    expect(points[0]).toMatchObject({ name: "AlzaBox Hradec Králové (Podnikatelské centrum)", parcelShopId: 1141354, postalCode: "500 03" });
    const url = getJson.mock.calls[0]?.[0] as unknown as string;
    expect(url).toBe(
      "https://www.alza.cz/api/salesNetwork/v1/places?types%5B0%5D=1&latitude=50.209&longitude=15.833&ordering=0&limit=100&offset=0",
    );
    expect(url).not.toMatch(/orderId|groupId/);
    expect(FIND_PICKUP_POINTS_OUTPUT.safeParse({ points }).success).toBe(true);
  });

  it("merges lockers and showrooms by distance for the default types", async () => {
    const { points } = await pickupWith(async () => FIXTURE).findPickupPoints({ postalCode: "500 02" });
    const types = points.map((p) => p.type);
    expect(types).toContain("alzabox");
    expect(types).toContain("branch");
    const d = points.map((p) => p.distanceKm ?? Infinity);
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });

  it("applies radius and limit locally", async () => {
    const pickup = pickupWith(async () => FIXTURE);
    const near = await pickup.findPickupPoints({ postalCode: "500 02", types: ["alzabox"], radiusKm: 0.8 });
    expect(near.points.every((p) => (p.distanceKm ?? Infinity) <= 0.8)).toBe(true);
    expect(near.points.length).toBeLessThan(3);
    const one = await pickup.findPickupPoints({ postalCode: "500 02", limit: 1 });
    expect(one.points).toHaveLength(1);
  });

  it("caches the locker list per centre", async () => {
    const getJson = vi.fn(async () => FIXTURE);
    const pickup = pickupWith(getJson);
    await pickup.findPickupPoints({ postalCode: "500 02", types: ["alzabox"] });
    await pickup.findPickupPoints({ postalCode: "500 02", limit: 2 });
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to showrooms with a warning when lockers fail", async () => {
    const pickup = pickupWith(async () => {
      throw new Error("HTTP 403");
    });
    const { points, warnings } = await pickup.findPickupPoints({ postalCode: "500 02" });
    expect(points.every((p) => p.type === "branch")).toBe(true);
    expect(warnings[0]).toMatch(/AlzaBox lockers could not be loaded/);
    expect(formatPickupPoints(points, warnings)).toMatch(/^> AlzaBox lockers could not be loaded/);
    await expect(pickup.findPickupPoints({ postalCode: "500 02", types: ["alzabox"] })).rejects.toThrow(/403/);
  });
});
