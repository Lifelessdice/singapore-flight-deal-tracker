const assert = require("node:assert/strict");
const {
  buildDateFirstExploreLanes,
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  createCallBudget,
  exactSearchKey,
  rankExploreCandidates,
  resolveCallLimit,
  scoreTravelerValue,
  selectExploreCandidates,
  summarizeCoverage,
  updateDateFirstExploreState,
  updateCoverage
} = require("../tracker-product");

const search = {
  routeId: "sin-budget",
  origin: "SIN",
  destination: "BKK",
  departureDate: "2026-09-04",
  returnDate: "2026-09-07",
  tripType: "round-trip",
  travelClass: "ECONOMY",
  adults: 1,
  carryOnBags: 0,
  checkedBags: 0,
  currencyCode: "USD",
  maxPrice: 160
};
const constructionEvidenceProfile = {
  adults: 1,
  carryOnBags: 0,
  checkedBags: 0,
  currency: "USD",
  itineraryProtection: "protected",
  travelClass: "ECONOMY"
};

const strongValue = scoreTravelerValue({
  entry: {
    price: 100,
    tripType: "round-trip",
    searchStrategy: "standard",
    returnVerified: true,
    weekendDeparture: true,
    maxStops: 0
  },
  insights: {
    level: "strong-deal",
    confidence: "high",
    targetHit: true
  },
  offer: {
    outboundDurationMinutes: 150,
    returnDurationMinutes: 150,
    baggageNotes: ["Personal item included"]
  },
  search
});
assert.equal(strongValue.action, "BOOK");
assert.ok(strongValue.score >= 90);

const openJawValue = scoreTravelerValue({
  entry: {
    price: 100,
    tripType: "round-trip",
    searchStrategy: "open-jaw",
    returnVerified: true,
    weekendDeparture: true,
    maxStops: 0
  },
  insights: {
    level: "strong-deal",
    confidence: "high",
    targetHit: true
  },
  offer: {
    outboundDurationMinutes: 150,
    returnDurationMinutes: 150,
    baggageNotes: ["Personal item included"]
  },
  search
});
assert.equal(openJawValue.action, "VERIFY");

const riskyValue = scoreTravelerValue({
  entry: {
    price: 70,
    tripType: "one-way",
    searchStrategy: "split-one-ways",
    weekendDeparture: false,
    maxStops: 1
  },
  insights: {
    level: "watching",
    confidence: "low",
    targetHit: true
  },
  offer: {
    totalDurationMinutes: 700,
    hasOvernight: true,
    hasSelfTransfer: true
  },
  search: { ...search, maxPrice: 75 }
});
assert.notEqual(riskyValue.action, "BOOK");
assert.ok(riskyValue.score < strongValue.score);

const planningNow = Date.parse("2026-07-18T00:00:00Z");
const dateFirstPlan = buildDateFirstExploreLanes(
  [{
    id: "sin-budget",
    label: "Singapore budget trips",
    originLocationCodes: ["SIN"],
    departureDates: ["2026-09-04", "2026-09-08"],
    returnDates: ["2026-09-07", "2026-09-10"],
    includeOneWay: true,
    minTripDays: 2,
    maxTripDays: 4,
    adults: 1,
    currencyCode: "USD",
    travelClass: "ECONOMY",
    maxRoundTripPrice: 160,
    maxOneWayPrice: 75,
    maxStops: 1,
    maxTotalDurationMinutes: 900
  }],
  {
    fixedDateReturnLanesPerRun: 1,
    fixedDateOneWayLanesPerRun: 1
  },
  {
    dateFirstReturnCursor: 0,
    dateFirstOneWayCursor: 1
  },
  planningNow
);
assert.equal(dateFirstPlan.lanes.length, 2);
assert.deepEqual(
  dateFirstPlan.lanes.map((lane) => lane.laneType),
  ["date-first-return", "date-first-one-way"]
);
assert.equal(dateFirstPlan.lanes[0].departureDate, "2026-09-04");
assert.equal(dateFirstPlan.lanes[0].returnDate, "2026-09-07");
assert.equal(dateFirstPlan.lanes[1].departureDate, "2026-09-08");
assert.equal(dateFirstPlan.lanes[1].returnDate, "");

const matchedHistory = ["BKK", "UTP", "XSP", "HKG"].flatMap((destination) => (
  [15, 16, 17].map((day) => ({
    origin: "SIN",
    destination,
    departureDate: "2026-09-04",
    returnDate: "2026-09-07",
    tripType: "round-trip",
    searchStrategy: "protected",
    price: destination === "BKK" ? 150 : 130,
    loggedAt: Date.parse(`2026-07-${day}T00:00:00Z`),
    leadTimeBucket: "31-60d",
    tripLengthDays: 3,
    weekendDeparture: true,
    carryOnBags: 0,
    checkedBags: 0,
    googlePriceInsights: destination === "HKG" && day === 17
      ? {
          typical_price_range: [120, 160],
          price_level: "low"
        }
      : null
  }))
));
const rankedExplore = rankExploreCandidates(
  [
    {
      origin: "SIN",
      destination: "KUL",
      departureDate: "2026-09-04",
      returnDate: "2026-09-07",
      tripType: "round-trip",
      tripLengthDays: 3,
      price: 70,
      totalDurationMinutes: 60,
      stops: 0,
      maxPrice: 160,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    },
    {
      origin: "SIN",
      destination: "BKK",
      departureDate: "2026-09-04",
      returnDate: "2026-09-07",
      tripType: "round-trip",
      tripLengthDays: 3,
      price: 100,
      totalDurationMinutes: 150,
      stops: 0,
      maxPrice: 160,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    },
    {
      origin: "SIN",
      destination: "UTP",
      departureDate: "2026-09-04",
      returnDate: "2026-09-07",
      tripType: "round-trip",
      tripLengthDays: 3,
      price: 90,
      totalDurationMinutes: 100,
      stops: 0,
      maxPrice: 160,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    },
    {
      origin: "SIN",
      destination: "PEN",
      departureDate: "2026-09-08",
      returnDate: "",
      tripType: "one-way",
      tripLengthDays: null,
      price: 45,
      totalDurationMinutes: 80,
      stops: 0,
      maxPrice: 75,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    },
    {
      origin: "SIN",
      destination: "XSP",
      departureDate: "2026-09-04",
      returnDate: "2026-09-07",
      tripType: "round-trip",
      tripLengthDays: 3,
      price: 90,
      totalDurationMinutes: 800,
      stops: 1,
      maxPrice: 160,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    },
    {
      origin: "SIN",
      destination: "HKG",
      departureDate: "2026-09-04",
      returnDate: "2026-09-07",
      tripType: "round-trip",
      tripLengthDays: 3,
      price: 100,
      totalDurationMinutes: 240,
      stops: 0,
      maxPrice: 160,
      carryOnBags: 0,
      checkedBags: 0,
      observedAt: planningNow
    }
  ],
  matchedHistory,
  new Set(["KUL", "BKK", "PEN", "XSP", "HKG"])
);
assert.ok(
  rankedExplore.findIndex((candidate) => candidate.destination === "BKK") <
  rankedExplore.findIndex((candidate) => candidate.destination === "KUL")
);
assert.ok(
  rankedExplore.findIndex((candidate) => candidate.destination === "UTP") <
  rankedExplore.findIndex((candidate) => candidate.destination === "XSP")
);
assert.ok(
  rankedExplore.find((candidate) => candidate.destination === "HKG")
    .ranking.typicalDiscount > 0
);
assert.equal(
  rankedExplore.find((candidate) => candidate.destination === "HKG")
    .ranking.marketEvidenceSource,
  "matched-exact-history"
);
assert.equal(
  rankedExplore.find((candidate) => candidate.destination === "PEN")
    .ranking.explorationOnly,
  true
);
const staleMarketRanking = rankExploreCandidates(
  [{
    origin: "SIN",
    destination: "HKT",
    departureDate: "2026-09-04",
    returnDate: "2026-09-07",
    tripType: "round-trip",
    tripLengthDays: 3,
    price: 80,
    totalDurationMinutes: 120,
    stops: 0,
    maxPrice: 160,
    carryOnBags: 0,
    checkedBags: 0,
    observedAt: planningNow
  }],
  [{
    origin: "SIN",
    destination: "HKT",
    departureDate: "2026-09-04",
    returnDate: "2026-09-07",
    tripType: "round-trip",
    searchStrategy: "protected",
    price: 130,
    loggedAt: Date.parse("2026-03-01T00:00:00Z"),
    leadTimeBucket: "31-60d",
    tripLengthDays: 3,
    weekendDeparture: true,
    carryOnBags: 0,
    checkedBags: 0,
    googlePriceInsights: {
      typical_price_range: [120, 160],
      price_level: "low"
    }
  }],
  new Set(),
  { marketEvidenceMaxAgeDays: 30 }
);
assert.equal(staleMarketRanking[0].ranking.marketEvidenceSource, null);
assert.equal(staleMarketRanking[0].ranking.explorationOnly, true);
const selectedExplore = selectExploreCandidates(rankedExplore, 3);
assert.equal(selectedExplore.length, 3);
assert.ok(selectedExplore.some((candidate) => candidate.tripType === "one-way"));
assert.ok(selectedExplore.some((candidate) => candidate.destination === "UTP"));

const nearby = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: true },
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }],
    openJaws: [{ id: "malaysia", label: "Malaysia", outboundDestination: "KUL", inboundOrigin: "PEN" }]
  },
  {},
  search,
  { history: [], referencePrice: 150, now: planningNow }
);
assert.equal(nearby.definition.type, "nearby-airports");
assert.equal(nearby.searches.length, 1);
assert.equal(nearby.searches[0].destination, "BKK,DMK");
const dateMismatchedNearby = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: false },
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }]
  },
  {},
  search,
  {
    history: [{
      ...constructionEvidenceProfile,
      routeId: "construction-bangkok",
      origin: "SIN",
      destination: "BKK",
      searchedDestination: "BKK,DMK",
      departureDate: "2026-10-02",
      returnDate: "2026-10-05",
      tripType: "round-trip",
      searchStrategy: "nearby-airports",
      price: 60,
      loggedAt: Date.parse("2026-07-17T00:00:00Z")
    }],
    referencePrice: 150,
    now: planningNow
  }
);
assert.equal(dateMismatchedNearby.evidence.expectedPrice, null);

const splitHistory = [
  {
    ...constructionEvidenceProfile,
    origin: "SIN",
    destination: "BKK",
    departureDate: "2026-09-04",
    returnDate: "",
    tripType: "one-way",
    searchStrategy: "protected",
    price: 40,
    loggedAt: Date.parse("2026-07-17T00:00:00Z")
  },
  {
    ...constructionEvidenceProfile,
    origin: "BKK",
    destination: "SIN",
    departureDate: "2026-09-07",
    returnDate: "",
    tripType: "one-way",
    searchStrategy: "split-inbound",
    price: 45,
    loggedAt: Date.parse("2026-07-17T00:00:00Z")
  }
];
const splitPlan = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: true },
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }],
    openJaws: [{ id: "malaysia", label: "Malaysia", outboundDestination: "KUL", inboundOrigin: "PEN" }]
  },
  {},
  search,
  {
    history: splitHistory,
    referencePrice: 150,
    now: planningNow
  }
);
assert.equal(splitPlan.definition.type, "split-one-ways");
assert.equal(splitPlan.searches.length, 2);
assert.deepEqual(
  [splitPlan.searches[1].origin, splitPlan.searches[1].destination],
  ["BKK", "SIN"]
);
const incompatibleConstructionEvidence = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: true },
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }]
  },
  {},
  search,
  {
    history: splitHistory.map((item, index) => ({
      ...item,
      currency: index ? "JPY" : "SGD",
      checkedBags: index
    })),
    referencePrice: 150,
    now: planningNow
  }
);
assert.equal(incompatibleConstructionEvidence.definition.type, "nearby-airports");
assert.equal(
  incompatibleConstructionEvidence.ranking.find(
    (item) => item.definition.type === "split-one-ways"
  ).expectedPrice,
  null
);

const openJawPlan = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: true },
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }],
    openJaws: [{
      id: "malaysia",
      label: "Malaysia",
      outboundDestination: "KUL",
      inboundOrigin: "PEN",
      surfaceTransferCost: 10
    }]
  },
  {},
  search,
  {
    history: [
      {
        ...constructionEvidenceProfile,
        origin: "SIN",
        destination: "KUL",
        departureDate: "2026-09-04",
        returnDate: "2026-09-07",
        tripType: "round-trip",
        searchStrategy: "protected",
        price: 150,
        loggedAt: Date.parse("2026-07-17T00:00:00Z")
      },
      {
        ...constructionEvidenceProfile,
        origin: "SIN",
        destination: "KUL",
        departureDate: "2026-09-04",
        returnDate: "",
        tripType: "one-way",
        searchStrategy: "open-jaw-outbound",
        price: 35,
        loggedAt: Date.parse("2026-07-17T00:00:00Z")
      },
      {
        ...constructionEvidenceProfile,
        origin: "PEN",
        destination: "SIN",
        departureDate: "2026-09-07",
        returnDate: "",
        tripType: "one-way",
        searchStrategy: "open-jaw-inbound",
        price: 35,
        loggedAt: Date.parse("2026-07-17T00:00:00Z")
      }
    ],
    referencePrice: 150,
    now: planningNow
  }
);
assert.equal(openJawPlan.definition.type, "open-jaw");
assert.equal(openJawPlan.searches.length, 2);
assert.deepEqual(
  [openJawPlan.searches[1].origin, openJawPlan.searches[1].destination],
  ["PEN", "SIN"]
);
const unknownSurfaceCostPlan = buildConstructionLane(
  {
    enabled: true,
    splitTickets: { enabled: false },
    openJaws: [{
      id: "malaysia",
      label: "Malaysia",
      outboundDestination: "KUL",
      inboundOrigin: "PEN"
    }]
  },
  {},
  search,
  {
    history: [
      {
        ...constructionEvidenceProfile,
        origin: "SIN",
        destination: "KUL",
        departureDate: "2026-09-04",
        returnDate: "",
        tripType: "one-way",
        searchStrategy: "open-jaw-outbound",
        price: 35,
        loggedAt: Date.parse("2026-07-17T00:00:00Z")
      },
      {
        ...constructionEvidenceProfile,
        origin: "PEN",
        destination: "SIN",
        departureDate: "2026-09-07",
        returnDate: "",
        tripType: "one-way",
        searchStrategy: "open-jaw-inbound",
        price: 35,
        loggedAt: Date.parse("2026-07-17T00:00:00Z")
      }
    ],
    referencePrice: 150,
    now: planningNow
  }
);
assert.equal(unknownSurfaceCostPlan.evidence.expectedPrice, null);
assert.ok(unknownSurfaceCostPlan.evidence.evidence.includes("surface-transfer cost unknown"));

const quota = buildQuotaSnapshot({
  plan_name: "Free",
  searches_per_month: 250,
  this_month_usage: 100,
  total_searches_left: 150
}, 10);
assert.equal(quota.spendableThisRun, 140);
assert.equal(quota.remaining, 150);

const callBudget = createCallBudget(14, 2);
assert.equal(callBudget.canSpend(), true);
assert.equal(callBudget.recordAttempt(), true);
assert.equal(callBudget.recordAttempt(), true);
assert.equal(callBudget.canSpend(), false);
assert.equal(callBudget.recordAttempt(), false);
assert.deepEqual(callBudget.snapshot(), {
  attempted: 2,
  remaining: 0,
  exhausted: true
});
const fullCycleBudget = createCallBudget(14, 100);
for (let attempt = 0; attempt < 14; attempt += 1) {
  assert.equal(fullCycleBudget.recordAttempt(), true);
}
assert.equal(fullCycleBudget.canSpend(), false);
assert.equal(fullCycleBudget.recordAttempt(), false);
assert.equal(fullCycleBudget.snapshot().attempted, 14);
const overConfiguredBudget = createCallBudget(20, 100);
for (let attempt = 0; attempt < 14; attempt += 1) {
  assert.equal(overConfiguredBudget.recordAttempt(), true);
}
assert.equal(overConfiguredBudget.recordAttempt(), false);
assert.equal(resolveCallLimit(20, ""), 14);
assert.equal(resolveCallLimit(14, "1"), 1);
assert.equal(resolveCallLimit(14, "0"), 0);
assert.equal(resolveCallLimit(14, "-2"), 0);
assert.equal(resolveCallLimit(14, "invalid"), 0);

const advancedDateState = updateDateFirstExploreState(
  { dateFirstReturnCursor: 1, dateFirstOneWayCursor: 2 },
  {
    nextReturnCursor: 3,
    nextOneWayCursor: 4,
    laneDates: ["2026-09-04/2026-09-07", "2026-09-08 one-way"]
  },
  false
);
assert.equal(advancedDateState.dateFirstReturnCursor, 3);
assert.equal(advancedDateState.dateFirstOneWayCursor, 4);
assert.equal(advancedDateState.dateFirstLaneDates.length, 2);
const forcedDateState = updateDateFirstExploreState(
  { dateFirstReturnCursor: 1, dateFirstOneWayCursor: 2 },
  { nextReturnCursor: 3, nextOneWayCursor: 4, laneDates: [] },
  true
);
assert.equal(forcedDateState.dateFirstReturnCursor, 1);
assert.equal(forcedDateState.dateFirstOneWayCursor, 2);

const now = Date.parse("2026-07-18T00:00:00Z");
const result = { ok: true, offers: [] };
const ledger = updateCoverage({}, search, "exact", result, "run-1", now);
const coverage = summarizeCoverage([search], ledger, {
  now,
  horizonDays: 90,
  recentDays: 14
});
assert.equal(coverage.recentlyCoveredSearches, 1);
assert.equal(coverage.recentlySuccessfulSearches, 1);
assert.equal(coverage.coveragePercent, 100);
assert.notEqual(exactSearchKey(search), exactSearchKey({ ...search, searchStrategy: "open-jaw" }));

async function testPromotions() {
  const promotionConfig = {
    enabled: true,
    keywords: ["sale"],
    sources: [{ id: "airline", label: "Airline", url: "https://example.test/deals" }]
  };
  const initial = await checkPromotionSources(
    promotionConfig,
    {},
    async () => ({ ok: true, text: async () => "<h1>Summer sale 20% off Singapore</h1>" })
  );
  assert.equal(initial.changed.length, 0);
  const unchanged = await checkPromotionSources(
    promotionConfig,
    initial.state,
    async () => ({ ok: true, text: async () => "<h1>Summer sale 20% off Singapore</h1>" })
  );
  assert.equal(unchanged.changed.length, 0);
  const changed = await checkPromotionSources(
    promotionConfig,
    initial.state,
    async () => ({ ok: true, text: async () => "<h1>Weekend sale 40% off Singapore</h1>" })
  );
  assert.equal(changed.changed.length, 0);
  assert.equal(changed.state.airline.candidateSeenCount, 1);
  const confirmed = await checkPromotionSources(
    promotionConfig,
    changed.state,
    async () => ({ ok: true, text: async () => "<h1>Weekend sale 40% off Singapore</h1>" })
  );
  assert.equal(confirmed.changed.length, 1);
  assert.equal(confirmed.state.airline.candidateSeenCount, 0);
}

testPromotions()
  .then(() => console.log("tracker product tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
