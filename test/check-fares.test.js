const assert = require("node:assert/strict");
const {
  alertKey,
  buildSplitTicketSearches,
  combineRoundTripOffers,
  evaluateRunCompletion,
  finalizeWorkerState,
  formatAlert,
  formatNoDealSummary,
  mapSerpApiOffer,
  searchGoogleTravelExploreLane,
  selectCandidateOffers,
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
    laneCount: 2,
    successfulLaneCount: 2
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
  constructionSummary: "evidence selected nearby Bangkok airports",
  checkIntervalHours: 48
});
assert.match(noDeal, /No new relative deals/);
assert.match(noDeal, /SIN -> KUL/);
assert.match(noDeal, /Sat 2026-08-01/);
assert.match(noDeal, /USD 80/);
assert.match(noDeal, /Date-first discovery reviewed 20 options across 2\/2 configured date lanes/);
assert.match(noDeal, /two one-ways vs USD 110 return/);
assert.match(noDeal, /separate one-ways save USD 15/);
assert.match(noDeal, /evidence selected nearby Bangkok airports/);
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
const emptyDiscoveryLane = formatNoDealSummary([], {
  discoveryResult: {
    exploredCandidates: 0,
    laneCount: 1,
    successfulLaneCount: 1
  }
});
assert.match(emptyDiscoveryLane, /reviewed 0 options across 1\/1 configured date lane/);

const discordSized = formatNoDealSummary([candidate, candidate, candidate], {
  discoveryResult: {
    exploredCandidates: 20,
    laneCount: 2,
    successfulLaneCount: 2
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

process.env.SERPAPI_API_KEY = "test-key";
const oneWayExplorePromise = searchGoogleTravelExploreLane(
  {
    id: "date-first-one-way|SIN|2026-09-08",
    laneType: "date-first-one-way",
    routeId: "student",
    origin: "SIN",
    departureDate: "2026-09-08",
    returnDate: "",
    tripType: "one-way",
    adults: 1,
    currencyCode: "USD",
    travelClass: "ECONOMY",
    maxPrice: 75,
    maxTotalDurationMinutes: 900,
    maxStops: 1,
    carryOnBags: 0,
    checkedBags: 0
  },
  async (url) => {
    assert.equal(url.searchParams.get("engine"), "google_travel_explore");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("outbound_date"), "2026-09-08");
    assert.equal(url.searchParams.has("return_date"), false);
    assert.equal(url.searchParams.get("bags"), "0");
    return {
      ok: true,
      json: async () => ({
        destinations: [{
          name: "Penang",
          destination_airport: { code: "PEN" },
          start_date: "2026-09-08",
          flight_price: 45,
          flight_duration: 80,
          number_of_stops: 0
        }]
      })
    };
  },
  Date.parse("2026-07-18T00:00:00Z")
).then((result) => {
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].tripType, "one-way");
  assert.equal(result.candidates[0].destination, "PEN");
  assert.equal(
    result.candidates[0].observedAt,
    Date.parse("2026-07-18T00:00:00Z")
  );
});

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

const protectedAndTransfer = selectCandidateOffers([
  {
    price: 90,
    itineraryProtection: "protected",
    hasSelfTransfer: false,
    hasAirportChange: false
  },
  {
    price: 100,
    itineraryProtection: "self-transfer",
    hasSelfTransfer: true,
    hasAirportChange: false
  }
]);
assert.equal(protectedAndTransfer.length, 2);
assert.equal(protectedAndTransfer[1].protectedComparablePrice, 90);

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
      itineraryProtection: "protected",
      searchStrategy: "open-jaw",
      constructionCostComplete: false
    }
  }),
  false
);
assert.equal(
  shouldAlert({
    ...acceptableTransferCandidate,
    entry: {
      ...acceptableTransferCandidate.entry,
      transferSavingsQualifies: false
    }
  }),
  true
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
    extraEstimatedCost: 12,
    price: 92,
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
assert.match(
  acceptableAlert,
  /USD 80 base fare \+ USD 12 estimated transfer requirements = USD 92/
);
assert.match(acceptableAlert, /informational, not an eligibility threshold/);
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

const originalWorkerState = {
  cursor: 2,
  dateFirstReturnCursor: 3,
  dateFirstOneWayCursor: 4,
  constructionEvidence: { prior: { score: 10 } },
  lastCompletedAt: "2026-07-17T00:00:00.000Z"
};
const proposedWorkerState = {
  ...originalWorkerState,
  cursor: 8,
  dateFirstReturnCursor: 9,
  dateFirstOneWayCursor: 10,
  constructionEvidence: { current: { score: 20 } },
  lastCompletedAt: "2026-07-19T00:00:00.000Z"
};
const accountUnavailable = evaluateRunCompletion({
  accountAvailable: false,
  forceRun: false,
  providerStats: {
    attempted: 0,
    successful: 0,
    skipped: 1,
    byKind: {}
  }
});
assert.equal(accountUnavailable.complete, false);
const preservedUnavailableState = finalizeWorkerState(
  originalWorkerState,
  proposedWorkerState,
  { completion: accountUnavailable, forceRun: false }
);
assert.equal(preservedUnavailableState.cursor, 2);
assert.equal(preservedUnavailableState.dateFirstReturnCursor, 3);
assert.deepEqual(
  preservedUnavailableState.constructionEvidence,
  originalWorkerState.constructionEvidence
);
assert.equal(
  preservedUnavailableState.lastCompletedAt,
  originalWorkerState.lastCompletedAt
);

const quotaTruncated = evaluateRunCompletion({
  accountAvailable: true,
  forceRun: false,
  providerStats: {
    attempted: 1,
    successful: 1,
    skipped: 4,
    byKind: {
      "date-first-return": { successful: 1 }
    }
  }
});
assert.equal(quotaTruncated.complete, false);
assert.equal(quotaTruncated.successfulFareRequests, 0);

const healthyScheduledRun = evaluateRunCompletion({
  accountAvailable: true,
  forceRun: false,
  providerStats: {
    attempted: 2,
    successful: 2,
    skipped: 0,
    byKind: {
      "date-first-return": { successful: 1 },
      exact: { successful: 1 }
    }
  }
});
assert.equal(healthyScheduledRun.complete, true);
assert.deepEqual(
  finalizeWorkerState(
    originalWorkerState,
    proposedWorkerState,
    { completion: healthyScheduledRun, forceRun: false }
  ),
  proposedWorkerState
);

const healthyForcedProbe = evaluateRunCompletion({
  accountAvailable: true,
  forceRun: true,
  providerStats: {
    attempted: 1,
    successful: 1,
    skipped: 3,
    byKind: {
      "date-first-one-way": { successful: 1 }
    }
  }
});
assert.equal(healthyForcedProbe.complete, true);
assert.equal(
  finalizeWorkerState(
    originalWorkerState,
    proposedWorkerState,
    { completion: healthyForcedProbe, forceRun: true }
  ).lastCompletedAt,
  originalWorkerState.lastCompletedAt
);

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

Promise.all([verifiedSelfTransferPromise, oneWayExplorePromise])
  .then(() => console.log("fare notification tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
