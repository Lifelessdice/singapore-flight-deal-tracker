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

console.log("fare notification tests passed");
