const assert = require("node:assert/strict");
const {
  buildSplitTicketSearches,
  formatNoDealSummary,
  selectSearches,
  summarizeSplitTicketCandidate
} = require("../scripts/check-fares");

const candidate = {
  entry: {
    origin: "SIN",
    destination: "KUL",
    departureDate: "2026-08-01",
    returnDate: "2026-08-03",
    currency: "USD",
    price: 80,
    tripType: "round-trip",
    notes: "AirAsia, 1h total, 0 stops, personal item only"
  },
  insights: {
    baselineSampleCount: 2,
    level: "watching",
    confidence: "low",
    typicalMidpoint: null,
    typicalLow: null,
    typicalHigh: null
  },
  links: {
    googleFlights: "https://www.google.com/travel/flights?q=SIN%20KUL"
  }
};

const noDeal = formatNoDealSummary([candidate], {
  discoveryResult: {
    exploredCandidates: 20,
    exploredMonth: 8
  },
  dealCandidates: [],
  checkIntervalHours: 48
});
assert.match(noDeal, /No new relative deals/);
assert.match(noDeal, /SIN -> KUL/);
assert.match(noDeal, /USD 80/);
assert.match(noDeal, /20 options/);
assert.match(noDeal, /about 48 hours/);
assert.match(noDeal, /AirAsia/);
assert.match(noDeal, /2\/3 prior comparable samples/);
assert.match(noDeal, /needs 1 more comparable sample/);
assert.match(noDeal, /Open flight search: https:\/\/www\.google\.com/);

const cooldown = formatNoDealSummary([candidate], {
  dealCandidates: [candidate]
});
assert.match(cooldown, /alert cooldown prevented a duplicate/);

const empty = formatNoDealSummary([], {});
assert.match(empty, /No live candidates were returned/);

const discordSized = formatNoDealSummary([candidate, candidate, candidate], {
  discoveryResult: {
    exploredCandidates: 20,
    exploredMonth: 8
  }
});
assert.ok(discordSized.length <= 1900);

const baseSearch = {
  routeId: "student",
  label: "Student trip",
  origin: "SIN",
  destination: "KUL",
  departureDate: "2026-08-07",
  returnDate: "2026-08-10",
  adults: 1,
  currencyCode: "USD",
  travelClass: "ECONOMY",
  maxPrice: 160,
  tripType: "round-trip",
  maxTotalDurationMinutes: 900,
  maxStops: 1,
  carryOnBags: 0,
  checkedBags: 0
};

const splitSearches = buildSplitTicketSearches(baseSearch);
assert.equal(splitSearches.length, 2);
assert.deepEqual(
  [splitSearches[0].origin, splitSearches[0].destination, splitSearches[0].departureDate],
  ["SIN", "KUL", "2026-08-07"]
);
assert.deepEqual(
  [splitSearches[1].origin, splitSearches[1].destination, splitSearches[1].departureDate],
  ["KUL", "SIN", "2026-08-10"]
);

const splitCandidate = summarizeSplitTicketCandidate(
  baseSearch,
  {
    price: 50,
    currency: "USD",
    totalDurationMinutes: 60,
    maxStops: 0,
    airlines: ["AirAsia"]
  },
  {
    price: 70,
    currency: "USD",
    totalDurationMinutes: 70,
    maxStops: 0,
    airlines: ["Scoot"]
  },
  {
    entry: {
      price: 150
    }
  },
  [],
  {
    minimumSavingsUsd: 15,
    minimumSavingsPercent: 10,
    strongSavingsUsd: 30,
    strongSavingsPercent: 20
  }
);
assert.equal(splitCandidate.entry.price, 120);
assert.equal(splitCandidate.entry.strategySavings, 30);
assert.equal(splitCandidate.entry.strategySavingsPercent, 20);
assert.equal(splitCandidate.insights.level, "strong-deal");
assert.ok(splitCandidate.insights.dealSignals.includes("separate-one-way-pricing"));
assert.match(splitCandidate.links.outboundGoogleFlights, /SIN%20to%20KUL/);
assert.match(splitCandidate.links.inboundGoogleFlights, /KUL%20to%20SIN/);

const rankedSearches = [
  baseSearch,
  { ...baseSearch, destination: "PEN" },
  { ...baseSearch, destination: "BKK" },
  { ...baseSearch, destination: "SGN" },
  { ...baseSearch, destination: "DPS" },
  { ...baseSearch, destination: "KUL", returnDate: "", tripType: "one-way" },
  { ...baseSearch, destination: "PEN", returnDate: "", tripType: "one-way" },
  { ...baseSearch, destination: "BKK", returnDate: "", tripType: "one-way" },
  {
    ...baseSearch,
    destination: "HKG",
    departureDate: "2026-12-11",
    returnDate: "2026-12-14"
  }
];
const selectedSearches = selectSearches(rankedSearches, [], {
  maxSearches: 4,
  horizonDays: 90,
  oneWayShare: 0.25,
  now: Date.parse("2026-07-18T00:00:00Z")
});
assert.equal(selectedSearches.length, 4);
assert.equal(selectedSearches.filter((search) => search.tripType === "round-trip").length, 3);
assert.equal(selectedSearches.filter((search) => search.tripType === "one-way").length, 1);
assert.equal(selectedSearches.some((search) => search.destination === "HKG"), false);

console.log("fare notification tests passed");
