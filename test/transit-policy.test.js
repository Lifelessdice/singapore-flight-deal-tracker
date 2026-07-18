const assert = require("node:assert/strict");
const {
  ManualTransitPolicyProvider,
  assessTransferRisk,
  isPolicyStale,
  lookupTransitPolicy,
  normalizePassportCountry,
  policyCacheKey,
  qualifiesTransferSavings
} = require("../transit-policy");

const NOW = Date.parse("2026-07-18T00:00:00Z");
const traveler = {
  passportNationality: "Switzerland",
  passportCountryCode: "CHE",
  passportExpiresOn: "2027-12-31",
  checkedBags: 0,
  carryOnBags: 0,
  baggageProfile: "personal item"
};
const basePolicy = {
  passportCountryCode: "CHE",
  transitCountry: "MYS",
  airport: "KUL",
  transferType: "self-transfer",
  baggageProfile: "*",
  entryPermitted: true,
  visaRequired: false,
  paidVisaRequired: false,
  authorizationRequired: false,
  authorizationName: null,
  authorizationCost: 0,
  authorizationCostCurrency: "USD",
  passportValidityRule: "Passport valid for the maintained official minimum.",
  passportValidityMinimumMonthsAfterTravel: 6,
  onwardTravelRequirement: "Confirmed onward ticket required.",
  terminalTransferFeasible: true,
  source: "Test official authority",
  sourceUrl: "https://authority.test/rule",
  lastVerifiedAt: "2026-07-10T00:00:00Z"
};
const connection = {
  airport: "KUL",
  arrivalAirport: "KUL",
  departureAirport: "KUL",
  transitCountry: "MYS",
  durationMinutes: 400,
  airportChange: false,
  terminalChange: false,
  immigrationLikely: true,
  baggageRecheckLikely: false,
  onwardIsLastPracticalDeparture: false
};
const transferOffer = {
  hasSelfTransfer: true,
  hasAirportChange: false,
  hasOvernight: false,
  connections: [connection]
};
const config = {
  allowSelfTransfers: true,
  allowAirportChanges: true,
  sameAirportSelfTransferMinMinutes: 240,
  immigrationOrRecheckMinMinutes: 360,
  airportChangeMinMinutes: 480,
  transitPolicyMaxAgeDays: 30,
  requireKnownOnwardFallback: true
};

async function assess(offer, policies, overrides = {}, travelerOverrides = {}) {
  return assessTransferRisk({
    offer,
    traveler: { ...traveler, ...travelerOverrides },
    config: { ...config, ...overrides },
    provider: new ManualTransitPolicyProvider(policies),
    cache: {},
    travelEndDate: "2026-08-10",
    currency: "USD",
    now: NOW
  });
}

async function main() {
  assert.equal(normalizePassportCountry("CH"), "CHE");
  assert.equal(
    policyCacheKey({
      passportCountryCode: "CH",
      transitCountry: "MYS",
      airport: "KUL",
      transferType: "self-transfer",
      baggageProfile: "personal item"
    }),
    "CHE|MYS|KUL|self-transfer|personal item;carryOn=0;checked=0"
  );
  let providerCalls = 0;
  const cacheProvider = {
    lookup: async () => {
      providerCalls += 1;
      return { status: "known", ...basePolicy };
    }
  };
  const firstLookup = await lookupTransitPolicy({
    provider: cacheProvider,
    cache: {},
    query: {
      passportCountryCode: "CHE",
      transitCountry: "MYS",
      airport: "KUL",
      transferType: "self-transfer",
      baggageProfile: "personal item",
      carryOnBags: 0,
      checkedBags: 0
    },
    maxAgeDays: 30,
    now: NOW
  });
  const cachedLookup = await lookupTransitPolicy({
    provider: cacheProvider,
    cache: firstLookup.cache,
    query: firstLookup.cache[firstLookup.key].query,
    maxAgeDays: 30,
    now: NOW
  });
  assert.equal(providerCalls, 1);
  assert.equal(cachedLookup.fromCache, true);

  const protectedResult = await assessTransferRisk({
    offer: { hasSelfTransfer: false, hasAirportChange: false },
    traveler,
    config,
    cache: {},
    now: NOW
  });
  assert.equal(protectedResult.assessment.status, "protected");

  const visaFree = await assess(transferOffer, [basePolicy]);
  assert.equal(visaFree.assessment.status, "self-transfer-acceptable");
  assert.equal(visaFree.assessment.visaRequired, false);
  assert.equal(visaFree.assessment.shortestConnectionMinutes, 400);

  const missingPassportExpiry = await assess(
    transferOffer,
    [basePolicy],
    {},
    { passportExpiresOn: null }
  );
  assert.equal(
    missingPassportExpiry.assessment.status,
    "self-transfer-manual-review"
  );

  const travelerConfirmedPassportValidity = await assess(
    transferOffer,
    [basePolicy],
    {},
    {
      passportExpiresOn: null,
      passportValidityConfirmedAgainstPublishedRules: true
    }
  );
  assert.equal(
    travelerConfirmedPassportValidity.assessment.status,
    "self-transfer-acceptable"
  );
  assert.match(
    travelerConfirmedPassportValidity.assessment.warnings.join(" "),
    /Traveler confirmed/
  );

  const insufficientPassportValidity = await assess(
    transferOffer,
    [basePolicy],
    {},
    { passportExpiresOn: "2026-09-01" }
  );
  assert.equal(
    insufficientPassportValidity.assessment.status,
    "self-transfer-rejected"
  );
  assert.match(
    insufficientPassportValidity.assessment.reasons.join(" "),
    /Passport expires before/
  );

  const paidVisa = await assess(transferOffer, [{
    ...basePolicy,
    visaRequired: true,
    paidVisaRequired: true
  }]);
  assert.equal(paidVisa.assessment.status, "self-transfer-rejected");
  assert.match(paidVisa.assessment.reasons.join(" "), /paid transit or entry visa/);

  const authorization = await assess(transferOffer, [{
    ...basePolicy,
    authorizationRequired: true,
    authorizationName: "Electronic travel authorization",
    authorizationCost: 12
  }]);
  assert.equal(authorization.assessment.status, "self-transfer-acceptable");
  assert.equal(authorization.assessment.authorizationRequired, true);
  assert.equal(authorization.assessment.authorizationCost, 12);
  assert.equal(authorization.assessment.extraEstimatedCost, 12);

  const unconvertedAuthorization = await assess(transferOffer, [{
    ...basePolicy,
    authorizationRequired: true,
    authorizationName: "Electronic travel authorization",
    authorizationCost: 12,
    authorizationCostCurrency: "EUR"
  }]);
  assert.equal(
    unconvertedAuthorization.assessment.status,
    "self-transfer-manual-review"
  );
  assert.equal(unconvertedAuthorization.assessment.extraEstimatedCost, null);

  const unknown = await assess(transferOffer, []);
  assert.equal(unknown.assessment.status, "self-transfer-manual-review");
  assert.match(unknown.assessment.reasons.join(" "), /No maintained transit policy/);

  const stale = await assess(transferOffer, [{
    ...basePolicy,
    lastVerifiedAt: "2026-05-01T00:00:00Z"
  }]);
  assert.equal(stale.assessment.status, "self-transfer-manual-review");
  assert.equal(
    isPolicyStale({ lastVerifiedAt: "2026-05-01T00:00:00Z" }, 30, NOW),
    true
  );

  const checkedBag = await assess(
    {
      ...transferOffer,
      connections: [{ ...connection, baggageRecheckLikely: true }]
    },
    [basePolicy],
    { checkedBagFee: 0, checkedBagRecheckCost: 25 },
    { checkedBags: 1, baggageProfile: "one checked bag" }
  );
  assert.equal(checkedBag.assessment.status, "self-transfer-acceptable");
  assert.equal(checkedBag.assessment.baggageRecheckLikely, true);
  assert.equal(checkedBag.assessment.extraEstimatedCost, 25);

  const checkedBagUnknownCost = await assess(
    {
      ...transferOffer,
      connections: [{ ...connection, baggageRecheckLikely: true }]
    },
    [basePolicy],
    { checkedBagRecheckCost: null },
    { checkedBags: 1, baggageProfile: "one checked bag" }
  );
  assert.equal(
    checkedBagUnknownCost.assessment.status,
    "self-transfer-manual-review"
  );
  assert.equal(checkedBagUnknownCost.assessment.extraEstimatedCost, null);

  const insufficient = await assess({
    ...transferOffer,
    connections: [{ ...connection, durationMinutes: 300 }]
  }, [basePolicy]);
  assert.equal(insufficient.assessment.status, "self-transfer-rejected");
  assert.match(insufficient.assessment.reasons.join(" "), /at least 360 minutes/);

  const sameAirportAirside = await assess({
    ...transferOffer,
    connections: [{
      ...connection,
      immigrationLikely: false,
      terminalChange: false,
      durationMinutes: 250
    }]
  }, [basePolicy]);
  assert.equal(sameAirportAirside.assessment.status, "self-transfer-acceptable");
  assert.equal(sameAirportAirside.assessment.minimumRecommendedConnectionMinutes, 240);

  const airportChangePolicy = {
    ...basePolicy,
    transitCountry: "THA",
    airport: "BKK",
    transferType: "airport-change"
  };
  const airportChangeOffer = {
    hasSelfTransfer: true,
    hasAirportChange: true,
    hasOvernight: false,
    connections: [{
      ...connection,
      airport: "BKK",
      arrivalAirport: "BKK",
      departureAirport: "DMK",
      transitCountry: "THA",
      airportChange: true,
      terminalChange: true,
      durationMinutes: 540
    }]
  };
  const airportChange = await assess(
    airportChangeOffer,
    [airportChangePolicy],
    {
      airportTransfers: {
        "BKK-DMK": { cost: 14, minutes: 90 }
      }
    }
  );
  assert.equal(airportChange.assessment.status, "self-transfer-acceptable");
  assert.equal(airportChange.assessment.minimumRecommendedConnectionMinutes, 480);
  assert.equal(airportChange.assessment.extraEstimatedCost, 14);

  const airportChangeTooShort = await assess(
    {
      ...airportChangeOffer,
      connections: [{
        ...airportChangeOffer.connections[0],
        durationMinutes: 420
      }]
    },
    [airportChangePolicy],
    {
      airportTransfers: {
        "BKK-DMK": { cost: 14, minutes: 90 }
      }
    }
  );
  assert.equal(airportChangeTooShort.assessment.status, "self-transfer-rejected");

  const saving = qualifiesTransferSavings(100, 160, {
    selfTransferMinimumSavingAmount: 40,
    selfTransferMinimumSavingPercent: 15
  });
  assert.deepEqual(saving, { amount: 60, percent: 38, qualifies: true });
  assert.equal(
    qualifiesTransferSavings(130, 160, {
      selfTransferMinimumSavingAmount: 40,
      selfTransferMinimumSavingPercent: 15
    }).qualifies,
    false
  );

  console.log("transit policy tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
