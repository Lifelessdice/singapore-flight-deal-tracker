const assert = require("node:assert/strict");
const {
  alertKey,
  buildSplitTicketSearches,
  combineRoundTripOffers,
  formatAlert,
  formatNoDealSummary,
  mapSerpApiOffer,
  selectSearches,
  shouldAlert,
  summarizeCandidate,
  summarizeSplitTicketCandidate,
  verifyRoundTripOffer
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
    confidenceBasis: "local observations only; no external statistical baseline returned",
    typicalMidpoint: null,
    typicalLow: null,
    typicalHigh: null,
    marketBaselineAvailable: false,
    marketPriceHistorySampleCount: 0
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
  splitTicketsChecked: 1,
  splitComparisons: [{
    origin: "SIN",
    destination: "KUL",
    currency: "USD",
    splitPrice: 95,
    roundTripPrice: 110
  }],
  dealCandidates: [],
  checkIntervalHours: 48
});
assert.match(noDeal, /No new relative deals/);
assert.match(noDeal, /SIN -> KUL/);
assert.match(noDeal, /Sat 2026-08-01/);
assert.match(noDeal, /USD 80/);
assert.match(noDeal, /20 options/);
assert.match(noDeal, /two one-ways vs USD 110 return/);
assert.match(noDeal, /separate one-ways save USD 15/);
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
  },
  splitTicketsChecked: 1,
  splitComparisons: [{
    origin: "SIN",
    destination: "KUL",
    currency: "USD",
    splitPrice: 95,
    roundTripPrice: 110
  }]
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
assert.equal(splitCandidate.insights.confidence, "low");
assert.ok(splitCandidate.insights.dealSignals.includes("separate-one-way-pricing"));
assert.match(splitCandidate.links.outboundGoogleFlights, /SIN%20to%20KUL/);
assert.match(splitCandidate.links.inboundGoogleFlights, /KUL%20to%20SIN/);

const combinedRoundTrip = combineRoundTripOffers(
  {
    price: 150,
    totalDurationMinutes: 90,
    maxStops: 0,
    airlines: ["Scoot"],
    maxLayoverMinutes: 0,
    hasOvernight: false,
    baggageNotes: ["Personal item included"]
  },
  {
    price: 155,
    totalDurationMinutes: 100,
    maxStops: 1,
    airlines: ["AirAsia"],
    flights: [{ flightNumber: "AK 701" }],
    layovers: [{ airport: "KUL", durationMinutes: 60 }],
    maxLayoverMinutes: 60,
    hasOvernight: false,
    baggageNotes: ["Cabin bag for a fee"],
    bookingToken: "booking-token"
  }
);
assert.equal(combinedRoundTrip.price, 155);
assert.equal(combinedRoundTrip.verifiedRoundTrip, true);
assert.equal(combinedRoundTrip.outboundDurationMinutes, 90);
assert.equal(combinedRoundTrip.returnDurationMinutes, 100);
assert.deepEqual(combinedRoundTrip.airlines, ["Scoot", "AirAsia"]);

const mappedTransfer = mapSerpApiOffer(
  {
    price: 100,
    total_duration: 500,
    extensions: ["Separate tickets booked together"],
    flights: [
      {
        airline: "Airline A",
        departure_airport: { id: "SIN", time: "2026-08-07 08:00" },
        arrival_airport: { id: "BKK", time: "2026-08-07 10:00", terminal: "1" },
        duration: 120
      },
      {
        airline: "Airline B",
        departure_airport: { id: "DMK", time: "2026-08-07 19:00", terminal: "2" },
        arrival_airport: { id: "HKT", time: "2026-08-07 20:30" },
        duration: 90
      }
    ],
    layovers: [{ id: "BKK", duration: 540 }]
  },
  {
    ...baseSearch,
    destination: "HKT",
    transitAirportCountries: { BKK: "THA" }
  },
  null
);
assert.equal(mappedTransfer.hasSelfTransfer, true);
assert.equal(mappedTransfer.hasAirportChange, true);
assert.equal(mappedTransfer.itineraryProtection, "self-transfer");
assert.equal(mappedTransfer.connections[0].transitCountry, "THA");
assert.equal(mappedTransfer.connections[0].durationMinutes, 540);

const verifiedSelfTransferPromise = verifyRoundTripOffer(
  baseSearch,
  {
    ...mappedTransfer,
    rawId: "departure-token",
    price: 100
  },
  async () => ({
    ok: true,
    offers: [{
      ...mappedTransfer,
      price: 140,
      flights: [],
      layovers: [],
      connections: [{
        ...mappedTransfer.connections[0],
        airport: "KUL",
        transitCountry: "MYS"
      }],
      bookingToken: "booking-token"
    }]
  })
).then((verifiedSelfTransfer) => {
  assert.equal(verifiedSelfTransfer.ok, true);
  assert.equal(verifiedSelfTransfer.offer.itineraryProtection, "self-transfer");
  assert.equal(verifiedSelfTransfer.offer.connections.length, 2);
});

const protectedHistory = [15, 16, 17].map((day, index) => ({
  routeId: "student",
  origin: "SIN",
  destination: "KUL",
  departureDate: "2026-08-07",
  returnDate: "2026-08-10",
  tripType: "round-trip",
  searchStrategy: "protected",
  price: 150 + index,
  loggedAt: Date.parse(`2026-07-${day}T00:00:00Z`),
  leadTimeBucket: "15-30d",
  tripLengthDays: 3,
  weekendDeparture: true,
  carryOnBags: 0,
  checkedBags: 0
}));
const selfHistoryCandidate = summarizeCandidate(
  baseSearch,
  {
    ...mappedTransfer,
    price: 100,
    currency: "USD",
    resolvedOrigin: "SIN",
    resolvedDestination: "KUL",
    airlines: ["Airline A"],
    totalDurationMinutes: 400,
    maxStops: 1,
    baggageNotes: []
  },
  protectedHistory
);
assert.equal(selfHistoryCandidate.entry.searchStrategy, "airport-change");
assert.equal(selfHistoryCandidate.insights.baselineSampleCount, 0);
const protectedHistoryCandidate = summarizeCandidate(
  baseSearch,
  {
    ...selfHistoryCandidate.offer,
    hasSelfTransfer: false,
    hasAirportChange: false,
    itineraryProtection: "protected",
    transferAssessment: { status: "protected", extraEstimatedCost: 0 },
    price: 140
  },
  protectedHistory
);
assert.equal(protectedHistoryCandidate.entry.searchStrategy, "protected");
assert.equal(protectedHistoryCandidate.insights.baselineSampleCount, 3);

const manualCandidate = {
  ...candidate,
  entry: {
    ...candidate.entry,
    itineraryProtection: "self-transfer",
    searchStrategy: "self-transfer",
    transferAssessment: {
      status: "self-transfer-manual-review",
      reasons: ["Transit policy is unknown."],
      warnings: []
    }
  },
  insights: {
    ...candidate.insights,
    level: "good-deal"
  }
};
const manualHeartbeat = formatNoDealSummary([manualCandidate], {
  dealCandidates: []
});
assert.match(manualHeartbeat, /Self-transfers requiring manual review/);
assert.match(manualHeartbeat, /Transit policy is unknown/);
assert.equal(shouldAlert(manualCandidate), false);

const acceptableTransferCandidate = {
  ...manualCandidate,
  entry: {
    ...manualCandidate.entry,
    transferSavingsQualifies: true,
    transferAssessment: {
      status: "self-transfer-acceptable",
      reasons: [],
      warnings: ["Separate tickets are unprotected."]
    }
  }
};
assert.equal(shouldAlert(acceptableTransferCandidate), true);
assert.equal(
  shouldAlert({
    ...acceptableTransferCandidate,
    entry: {
      ...acceptableTransferCandidate.entry,
      transferSavingsQualifies: false
    }
  }),
  false
);
const acceptableAlert = formatAlert([{
  ...acceptableTransferCandidate,
  insights: {
    ...acceptableTransferCandidate.insights,
    latestVsMedianPct: -20,
    latestVsAveragePct: -18,
    latestVsMarketPct: -15,
    baselineScope: "matching strategy",
    baselineSampleCount: 3,
    dealSignals: ["local-history"],
    savingsVsMedian: 20,
    savingsVsAverage: 18
  },
  value: {
    action: "VERIFY",
    score: 70,
    reasons: ["strong relative price anomaly"],
    risks: ["separate tickets"]
  },
  entry: {
    ...acceptableTransferCandidate.entry,
    baseFare: 80,
    transferSavings: 50,
    transferSavingsPercent: 38,
    returnVerified: true,
    passportNationality: "Switzerland",
    baggageProfile: "personal item",
    checkedBags: 0,
    transferAssessment: {
      status: "self-transfer-acceptable",
      reasons: [],
      warnings: ["Separate tickets are unprotected."],
      shortestConnectionMinutes: 400,
      minimumRecommendedConnectionMinutes: 360,
      transitAirports: ["KUL"],
      immigrationLikely: true,
      baggageRecheckLikely: false,
      authorizationRequired: false,
      policySource: "https://authority.test/rule",
      policyLastVerifiedAt: "2026-07-10T00:00:00Z"
    }
  }
}]);
assert.match(acceptableAlert, /ACCEPTABLE SELF-TRANSFER/);
assert.match(acceptableAlert, /Separate tickets are unprotected/);

const rejectedCandidate = {
  ...manualCandidate,
  entry: {
    ...manualCandidate.entry,
    transferAssessment: {
      status: "self-transfer-rejected",
      reasons: ["A paid visa is required."],
      warnings: []
    },
    transferRejectionReason: "A paid visa is required."
  }
};
const rejectedHeartbeat = formatNoDealSummary([rejectedCandidate], {});
assert.match(rejectedHeartbeat, /Rejected self-transfers: 1/);

assert.notEqual(
  alertKey({ entry: { ...candidate.entry, departureDate: "2026-08-01" } }),
  alertKey({ entry: { ...candidate.entry, departureDate: "2026-08-08" } })
);
assert.notEqual(
  alertKey({ entry: { ...candidate.entry } }),
  alertKey({ entry: { ...candidate.entry, searchStrategy: "split-one-ways" } })
);

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

verifiedSelfTransferPromise
  .then(() => console.log("fare notification tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
