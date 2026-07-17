const assert = require("node:assert/strict");
const { analyzeFareHistory, average, median } = require("../fare-insights");

assert.equal(median([300, 100, 200]), 200);
assert.equal(median([100, 300]), 200);
assert.equal(average([100, 200, 300]), 200);

const targetHit = analyzeFareHistory([
  { source: "Google Flights", price: 320, loggedAt: 1 },
  { source: "ITA Matrix", price: 280, loggedAt: 2 },
  { source: "Skiplagged", price: 240, loggedAt: 3 }
], 250);
assert.equal(targetHit.level, "good-deal");
assert.equal(targetHit.targetHit, true);
assert.equal(targetHit.confidence, "medium");

const targetOnlyNeedsHistory = analyzeFareHistory([
  { source: "Google Flights", price: 70, loggedAt: 1 }
], 75);
assert.equal(targetOnlyNeedsHistory.level, "watching");
assert.equal(targetOnlyNeedsHistory.latestVsMedianPct, null);

const strongDeal = analyzeFareHistory([
  { source: "Google Flights", price: 500, loggedAt: 1 },
  { source: "ITA Matrix", price: 520, loggedAt: 2 },
  { source: "Skiplagged", price: 390, loggedAt: 3 }
], "");
assert.equal(strongDeal.level, "strong-deal");
assert.equal(strongDeal.latestVsMedianPct, -22);
assert.equal(strongDeal.averagePrice, 470);
assert.equal(strongDeal.latestVsAveragePct, -17);
assert.equal(strongDeal.savingsVsMedian, 110);
assert.equal(strongDeal.savingsVsAverage, 80);

const wait = analyzeFareHistory([
  { source: "Google Flights", price: 300, loggedAt: 1 },
  { source: "ITA Matrix", price: 310, loggedAt: 2 },
  { source: "Google Flights", price: 380, loggedAt: 3 }
], "");
assert.equal(wait.level, "wait");

const empty = analyzeFareHistory([], 200);
assert.equal(empty.level, "watching");
assert.equal(empty.bestPrice, null);
assert.equal(empty.confidence, "low");

console.log("fare insight tests passed");
