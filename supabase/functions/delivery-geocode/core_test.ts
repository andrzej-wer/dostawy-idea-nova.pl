import { addressKey, buildingFallback, convertPL1992, mayTryBuildingFallback, parseUugResult, prepareAddress } from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const expected = prepareAddress("ul. Testowa 12, 00-001 Testowo");
// The numeric coordinates below are the public UUG documentation's example,
// paired with a synthetic address. Tests make no geocoding/network requests.
const match = { city: "Testowo", street: "Testowa", number: "12", code: "00-001", x: "644234.2904", y: "499514.0342", accuracy: 0.95 };

Deno.test("cache keys normalize Unicode, case and whitespace without fuzzy matching", () => {
  assert(addressKey("  ŻÓŁĆ\t 12,   Miasto  ") === "żółć 12, miasto", "canonical key");
  assert(addressKey("Z\u0307o\u0301łc\u0301 12") === addressKey("Żółć 12"), "NFC");
  assert(addressKey("Testowa 1") !== addressKey("Testowa 1A"), "house numbers remain distinct");
  assert(addressKey("Testowa 1, Miasto") !== addressKey("Testowa 1 Miasto"), "punctuation not fuzzy-normalized");
});

Deno.test("legacy postal and structured addresses preserve expected match fields", () => {
  assert(expected.query === "Testowo, ul. Testowa 12", "UUG city-first query");
  assert(expected.number === "12" && expected.zip === "00-001", "house and postcode");
  const cityFirst = prepareAddress("Testowo, ul. Testowa 12");
  assert(cityFirst.city === "Testowo" && cityFirst.number === "12", "city-first manual address");
  const noStreet = prepareAddress("Wieś 12, 00-001 Wieś", { city: "Wieś" });
  assert(noStreet.number === "12", "village number");
  assert(noStreet.query === "Wieś 12", "village is not duplicated in provider query");
});

Deno.test("PUWG1992 conversion uses easting/northing and returns Poland WGS84", () => {
  const point = convertPL1992(644234.2904, 499514.0342);
  assert(point && point.lat > 52.2 && point.lat < 52.5 && point.lng > 21.0 && point.lng < 21.3, "public documentation point near Marki");
  assert(convertPL1992(NaN, 1) === null, "non-finite coordinate rejected");
  assert(convertPL1992(0, 0) === null, "coordinate outside Poland rejected");
});

Deno.test("only one exact address resolves; centroids, ambiguity and wrong metadata do not", () => {
  assert(parseUugResult({ results: { 1: match } }, expected).status === "resolved", "one exact result");
  assert(parseUugResult({ results: { 1: match, 2: { ...match, x: "644240" } } }, expected).status === "ambiguous", "two candidates");
  assert(parseUugResult({ results: [{ ...match, number: "13" }] }, expected).status === "ambiguous", "wrong number");
  assert(parseUugResult({ results: [{ ...match, city: "Inne miasto" }] }, expected).status === "ambiguous", "wrong city");
  assert(parseUugResult({ results: [{ ...match, code: "00-002" }] }, expected).status === "ambiguous", "wrong postcode");
  assert(parseUugResult({ results: [{ ...match, accuracy: 0.4 }] }, expected).status === "resolved", "text score cannot overrule exact metadata");
  assert(parseUugResult({ results: [{ ...match, number: "" }] }, expected).status === "ambiguous", "street centroid");
  assert(parseUugResult({ results: [match] }, prepareAddress("Testowo")).status === "ambiguous", "city-only query");
  assert(parseUugResult({ results: [] }, expected).status === "not_found", "empty results");
  assert(parseUugResult({ "returned objects": 0 }, expected).status === "not_found", "explicit empty response");
});

Deno.test("full patron names expand only by a whole-word suffix with exact city, postcode and house", () => {
  const request = prepareAddress("Andersa 1, 05-270 Marki");
  const publicExample = { city: "Marki", street: "Generała Władysława Andersa", number: "1", code: "05-270", x: "644234.29", y: "499514.03", accuracy: "0.444444" };
  assert(parseUugResult({ results: [publicExample] }, request).status === "resolved", "documented low-score full-name expansion");
  assert(parseUugResult({ results: [publicExample, { ...publicExample, street: "Innego Patrona Andersa" }] }, request).status === "ambiguous", "multiple matching suffixes stay ambiguous");
  assert(parseUugResult({ results: [{ ...publicExample, code: "05-271" }] }, request).status === "ambiguous", "wrong postcode rejected");
  assert(parseUugResult({ results: [{ ...publicExample, street: "Andersa Północna" }] }, request).status === "ambiguous", "prefix is not a full-name expansion");
  assert(parseUugResult({ results: [{ ...publicExample, street: "Zandersa" }] }, request).status === "ambiguous", "substring does not match");
  assert(parseUugResult({ results: [publicExample] }, prepareAddress("Marki, Andersa 1")).status === "ambiguous", "missing postcode requires address completion");
});

Deno.test("malformed/error responses are not persisted as missing addresses", () => {
  for (const value of [null, "gateway error", {}, { error: "unavailable", results: [] }]) {
    let threw = false;
    try { parseUugResult(value, expected); } catch { threw = true; }
    assert(threw, "provider error must not become not_found");
  }
});

Deno.test("apartment fallback removes only the last slash segment and preserves exact compound ambiguity", () => {
  for (const [raw, complete, building] of [["22/2", "22/2", "22"], ["11 / 49", "11/49", "11"], ["46 /50/135", "46/50/135", "46/50"], ["46-50 / 135", "46-50/135", "46-50"]]) {
    const request = prepareAddress("ul. Testowa " + raw + ", 00-001 Testowo");
    const fallback = buildingFallback(request);
    assert(request.number === complete && request.street === "ul. Testowa", "compound number parsed completely");
    assert(fallback?.number === building, "only apartment segment removed");
    assert(fallback.query === "Testowo, ul. Testowa " + building, "explicit building query");
    assert(mayTryBuildingFallback({ results: [] }, request), "empty exact lookup allows one fallback");
    const full = { ...match, number: complete };
    assert(!mayTryBuildingFallback({ results: [full] }, request), "exact compound must win");
    assert(!mayTryBuildingFallback({ results: [full, { ...full, x: "644240" }] }, request), "full-number ambiguity cannot be hidden");
    const result = parseUugResult({ results: [{ ...match, number: building }] }, fallback, "building");
    assert(result.status === "resolved" && result.precision === "building", "unique exact building result");
    assert(parseUugResult({ results: [{ ...match, number: building, code: "00-002" }] }, fallback, "building").status === "ambiguous", "fallback postcode still exact");
  }
  assert(buildingFallback(expected) === null, "plain numbers have no fallback");
  assert(buildingFallback(prepareAddress("Testowa 12/2")) === null, "no city means no guessed fallback");
});
