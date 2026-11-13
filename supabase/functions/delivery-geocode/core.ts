import proj4 from "proj4";

// UUG returns planar X/Y (easting/northing), not WGS84 latitude/longitude.
const PL1992 = "+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs";

export type Hint = { street?: string; zip?: string; city?: string };
export type AddressRequest = {
  query: string;
  city: string;
  street: string;
  number: string;
  zip: string;
};
export type LocationResult = {
  status: "resolved" | "not_found" | "ambiguous";
  lat: number | null;
  lng: number | null;
  precision: "address" | "building" | null;
};

export function addressKey(address: string): string {
  return address.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

function folded(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase()
    .replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

function streetName(value: string): string {
  return folded(value).replace(/^(?:ulica|ul|aleja|aleje|al|plac|pl)\s+/, "").trim();
}

function sameStreet(actual: string, expected: string): boolean {
  const complete = streetName(actual);
  const requested = streetName(expected);
  if (complete === requested) return true;
  // Registers often expand a patron's given names/titles. Only an entire
  // trailing word sequence is accepted, never spelling similarity, a prefix,
  // or a substring inside another name. exactCandidates also requires the
  // same city, postcode and house number, and rejects multiple matches.
  return requested.length >= 4 && complete.endsWith(" " + requested);
}

function houseNumber(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function prepareAddress(address: string, hint: Hint = {}): AddressRequest {
  let street = String(hint.street || "").trim();
  let city = String(hint.city || "").trim();
  let zip = String(hint.zip || "").trim();
  const postal = address.match(/^(.+?),?\s+(\d{2}-\d{3})\s+([^,]+)$/u);
  if (postal) {
    street ||= postal[1].replace(/,\s*$/, "").trim();
    zip ||= postal[2];
    city ||= postal[3].trim();
  }
  if (!street && city) {
    const suffix = address.toLowerCase().lastIndexOf(city.toLowerCase());
    if (suffix > 0 && suffix + city.length === address.length) {
      street = address.slice(0, suffix).replace(/[,\s]+$/, "").replace(/\d{2}-\d{3}$/, "").replace(/[,\s]+$/, "").trim();
    }
  }
  if (!street && address.includes(",")) {
    const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
    // UUG's documented city-first form, or legacy street-first form.
    if (/\d/.test(parts[parts.length - 1]) && !/\d/.test(parts[0])) {
      city ||= parts[0];
      street = parts.slice(1).join(", ");
    } else if (/\d/.test(parts[0]) && !/\d/.test(parts[parts.length - 1])) {
      street = parts.slice(0, -1).join(", ");
      city ||= parts[parts.length - 1];
    }
  }
  street ||= address;
  // Explicit apartment labels do not locate a different building. Keep slash
  // numbers intact because they may be a compound building number.
  street = street.replace(/\s+(?:lok\.?|lokal|m\.?|mieszkanie)\s*\d+[a-z]?\s*$/iu, "").trim();
  const numberMatch = street.match(/(?:^|[\s,])(\d+\s*[a-z]?(?:\s*[/-]\s*\d+\s*[a-z]?)*)$/iu);
  const number = numberMatch ? houseNumber(numberMatch[1]) : "";
  const onlyStreet = numberMatch ? street.slice(0, numberMatch.index).replace(/[,\s]+$/, "") : street;
  const villageAddress = city && number && (!onlyStreet || folded(onlyStreet) === folded(city));
  return {
    query: villageAddress ? city + " " + number : city ? city + ", " + street : street,
    city,
    street: onlyStreet,
    number,
    zip: zip.replace(/\s+/g, ""),
  };
}

export function buildingFallback(expected: AddressRequest): AddressRequest | null {
  // A slash can be part of a real building number: always try the complete
  // number first. Only the final numeric segment can subsequently be treated
  // as an apartment. Thus 46/50/135 becomes 46/50, never an invented 46.
  const separator = expected.number.lastIndexOf("/");
  if (separator < 1 || !expected.city) return null;
  const number = expected.number.slice(0, separator);
  if (!/^\d+[a-z]?(?:[/-]\d+[a-z]?)*$/iu.test(number)) return null;
  const village = !expected.street || folded(expected.street) === folded(expected.city);
  return {
    ...expected,
    number,
    query: village ? expected.city + " " + number : expected.city + ", " + expected.street + " " + number,
  };
}

export function convertPL1992(x: number, y: number): { lat: number; lng: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const [lng, lat] = proj4(PL1992, "EPSG:4326", [x, y]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 48.5 || lat > 55.5 || lng < 13.5 || lng > 25) return null;
  return { lat, lng };
}

function uugCandidates(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") throw new Error("invalid_provider_response");
  const object = payload as Record<string, unknown>;
  if (object.error) throw new Error("invalid_provider_response");
  const raw = object.results;
  if (raw == null && (object["returned objects"] === 0 || object["returned objects"] === "0")) return [];
  if (!raw || typeof raw !== "object") throw new Error("invalid_provider_response");
  return Object.values(raw).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function exactCandidates(candidates: Record<string, unknown>[], expected: AddressRequest): Record<string, unknown>[] {
  // Never present a street/town centroid, fuzzy house number or a homonymous town
  // as an exact delivery address. Missing metadata remains visible as ambiguous.
  return candidates.filter((row) => {
    if (!expected.number || !expected.city || !expected.zip || houseNumber(String(row.number || "")) !== expected.number) return false;
    if (folded(row.city) !== folded(expected.city)) return false;
    if (String(row.code || "").replace(/\s+/g, "") !== expected.zip) return false;
    if (expected.street && !sameStreet(String(row.street || ""), expected.street)) {
      // Villages without street names use "Village 12" as the entire address.
      if (String(row.street || "").trim() || folded(expected.street) !== folded(row.city)) return false;
    }
    // UUG accuracy scores textual similarity, not coordinate quality: an
    // expanded full patron name can score below 0.5 despite exact metadata.
    return convertPL1992(Number(row.x), Number(row.y)) !== null;
  });
}

export function mayTryBuildingFallback(payload: unknown, expected: AddressRequest): boolean {
  // Preserve genuine ambiguity between two complete house-number matches.
  return buildingFallback(expected) !== null && exactCandidates(uugCandidates(payload), expected).length === 0;
}

export function parseUugResult(payload: unknown, expected: AddressRequest, precision: "address" | "building" = "address"): LocationResult {
  const candidates = uugCandidates(payload);
  if (!candidates.length) return { status: "not_found", lat: null, lng: null, precision: null };
  const exact = exactCandidates(candidates, expected);
  if (exact.length !== 1) return { status: "ambiguous", lat: null, lng: null, precision: null };
  const point = convertPL1992(Number(exact[0].x), Number(exact[0].y));
  return { status: "resolved", lat: point!.lat, lng: point!.lng, precision };
}
