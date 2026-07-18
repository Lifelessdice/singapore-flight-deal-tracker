const assert = require("node:assert/strict");
const { formatNoDealSummary } = require("../scripts/check-fares");

const candidate = {
  entry: {
    origin: "SIN",
    destination: "KUL",
    departureDate: "2026-08-01",
    returnDate: "2026-08-03",
    currency: "USD",
    price: 80,
    tripType: "round-trip"
  },
  insights: {
    baselineSampleCount: 2,
    level: "watching"
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

const cooldown = formatNoDealSummary([candidate], {
  dealCandidates: [candidate]
});
assert.match(cooldown, /alert cooldown prevented a duplicate/);

const empty = formatNoDealSummary([], {});
assert.match(empty, /No live candidates were returned/);

console.log("fare notification tests passed");
