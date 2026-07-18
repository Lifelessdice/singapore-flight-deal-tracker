const assert = require("node:assert/strict");
const {
  analyzeFareHistory,
  average,
  dedupeDailyFareObservations,
  getLeadTimeBucket,
  hasSameBaggageProfile,
  median,
  medianAbsoluteDeviation
} = require("../fare-insights");

const DAY = 24 * 60 * 60 * 1000;

assert.equal(median([300, 100, 200]), 200);
assert.equal(median([100, 300]), 200);
assert.equal(average([100, 200, 300]), 200);
assert.equal(medianAbsoluteDeviation([90, 100, 110]), 10);
assert.equal(getLeadTimeBucket("2026-08-07", Date.parse("2026-07-17T00:00:00Z")), "15-30d");
assert.equal(hasSameBaggageProfile({}, { carryOnBags: 0, checkedBags: 0 }), true);
assert.equal(hasSameBaggageProfile(
  { carryOnBags: 1, checkedBags: 0 },
  { carryOnBags: 0, checkedBags: 0 }
), false);
assert.equal(hasSameBaggageProfile(
  { carryOnBags: 0, checkedBags: 1 },
  { carryOnBags: 0, checkedBags: 0 }
), false);

const targetHit = analyzeFareHistory([
  { source: "Google Flights", price: 320, loggedAt: DAY },
  { source: "ITA Matrix", price: 280, loggedAt: DAY * 2 },
  { source: "Skiplagged", price: 300, loggedAt: DAY * 3 },
  { source: "Google Flights", price: 240, loggedAt: DAY * 4 }
], 250);
assert.equal(targetHit.level, "strong-deal");
assert.equal(targetHit.targetHit, true);
assert.equal(targetHit.confidence, "low");
assert.match(targetHit.confidenceBasis, /local observations only/);

const targetOnlyNeedsHistory = analyzeFareHistory([
  { source: "Google Flights", price: 70, loggedAt: 1 }
], 75);
assert.equal(targetOnlyNeedsHistory.level, "watching");
assert.equal(targetOnlyNeedsHistory.latestVsMedianPct, null);

const strongDeal = analyzeFareHistory([
  { source: "Google Flights", price: 500, loggedAt: DAY },
  { source: "Google Flights", price: 510, loggedAt: DAY * 2 },
  { source: "ITA Matrix", price: 520, loggedAt: DAY * 3 },
  { source: "Skiplagged", price: 390, loggedAt: DAY * 4 }
], "");
assert.equal(strongDeal.level, "strong-deal");
assert.equal(strongDeal.latestVsMedianPct, -24);
assert.equal(strongDeal.averagePrice, 510);
assert.equal(strongDeal.latestVsAveragePct, -24);
assert.equal(strongDeal.savingsVsMedian, 120);
assert.equal(strongDeal.savingsVsAverage, 120);
assert.equal(strongDeal.robustZScore, -3.17);
assert.deepEqual(strongDeal.dealSignals, ["local-history", "robust-outlier"]);

const wait = analyzeFareHistory([
  { source: "Google Flights", price: 300, loggedAt: DAY },
  { source: "ITA Matrix", price: 310, loggedAt: DAY * 2 },
  { source: "Google Flights", price: 320, loggedAt: DAY * 3 },
  { source: "Google Flights", price: 380, loggedAt: DAY * 4 }
], "");
assert.equal(wait.level, "wait");

const noisyHistory = analyzeFareHistory([
  { source: "Google Flights", price: 100, loggedAt: DAY },
  { source: "Google Flights", price: 150, loggedAt: DAY * 2 },
  { source: "Google Flights", price: 200, loggedAt: DAY * 3 },
  { source: "Google Flights", price: 130, loggedAt: DAY * 4 }
], "");
assert.equal(noisyHistory.latestVsMedianPct, -13);
assert.equal(noisyHistory.level, "watching");

const googleMarketDeal = analyzeFareHistory([
  {
    source: "Google Flight Deals",
    price: 80,
    loggedAt: 1,
    googlePriceInsights: {
      price_level: "low",
      typical_price_range: [110, 130],
      price_history: [
        [1, 115],
        [2, 120],
        [3, 118],
        [4, 125],
        [5, 122],
        [6, 119],
        [7, 124]
      ]
    }
  }
], "");
assert.equal(googleMarketDeal.level, "strong-deal");
assert.equal(googleMarketDeal.latestVsMarketPct, -33);
assert.deepEqual(
  googleMarketDeal.dealSignals,
  ["google-typical-range", "google-online-price-history"]
);
assert.equal(googleMarketDeal.confidence, "high");
assert.equal(googleMarketDeal.marketPriceHistorySampleCount, 7);

const repeatedSameDay = dedupeDailyFareObservations([
  { price: 111, loggedAt: DAY + 1 },
  { price: 111, loggedAt: DAY + 2 },
  { price: 95, loggedAt: DAY + 3 }
]);
assert.equal(repeatedSameDay.length, 1);

const roundedThreshold = analyzeFareHistory([
  { price: 100, loggedAt: DAY },
  { price: 100, loggedAt: DAY * 2 },
  { price: 100, loggedAt: DAY * 3 },
  { price: 90.4, loggedAt: DAY * 4 }
], "");
assert.equal(roundedThreshold.latestVsMedianPct, -10);
assert.equal(roundedThreshold.level, "watching");

const empty = analyzeFareHistory([], 200);
assert.equal(empty.level, "watching");
assert.equal(empty.bestPrice, null);
assert.equal(empty.confidence, "low");

console.log("fare insight tests passed");
