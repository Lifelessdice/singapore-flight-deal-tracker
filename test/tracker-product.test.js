const assert = require("node:assert/strict");
const {
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  exactSearchKey,
  scoreTravelerValue,
  summarizeCoverage,
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
  maxPrice: 160
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

const nearby = buildConstructionLane(
  {
    enabled: true,
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }],
    openJaws: [{ id: "malaysia", label: "Malaysia", outboundDestination: "KUL", inboundOrigin: "PEN" }]
  },
  { constructionCursor: 0 },
  search
);
assert.equal(nearby.definition.type, "nearby-airports");
assert.equal(nearby.searches.length, 1);
assert.equal(nearby.searches[0].destination, "BKK,DMK");

const openJaw = buildConstructionLane(
  {
    enabled: true,
    airportGroups: [{ id: "bangkok", label: "Bangkok", airports: ["BKK", "DMK"] }],
    openJaws: [{ id: "malaysia", label: "Malaysia", outboundDestination: "KUL", inboundOrigin: "PEN" }]
  },
  { constructionCursor: 1 },
  search
);
assert.equal(openJaw.definition.type, "open-jaw");
assert.equal(openJaw.searches.length, 2);
assert.deepEqual(
  [openJaw.searches[1].origin, openJaw.searches[1].destination],
  ["PEN", "SIN"]
);

const quota = buildQuotaSnapshot({
  plan_name: "Free",
  searches_per_month: 250,
  this_month_usage: 100,
  total_searches_left: 150
}, 10);
assert.equal(quota.spendableThisRun, 140);
assert.equal(quota.remaining, 150);

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
