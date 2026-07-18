const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TRANSFER_CONFIG = {
  allowSelfTransfers: false,
  allowAirportChanges: false,
  selfTransferMinimumSavingPercent: 15,
  selfTransferMinimumSavingAmount: 40,
  sameAirportSelfTransferMinMinutes: 240,
  immigrationOrRecheckMinMinutes: 360,
  airportChangeMinMinutes: 480,
  transitPolicyMaxAgeDays: 30,
  requireKnownOnwardFallback: true,
  carryOnBagFee: null,
  checkedBagFee: null,
  checkedBagRecheckCost: null,
  overnightAccommodationCost: null,
  airportTransfers: {}
};

function normalizePassportCountry(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (normalized === "CH") return "CHE";
  return normalized;
}

function policyCacheKey(query) {
  return [
    normalizePassportCountry(query.passportCountryCode),
    String(query.transitCountry || "unknown").toUpperCase(),
    String(query.airport || "unknown").toUpperCase(),
    query.transferType || "self-transfer",
    `${query.baggageProfile || "unspecified"};carryOn=${Number(query.carryOnBags || 0)};checked=${Number(query.checkedBags || 0)}`
  ].join("|");
}

function isPolicyStale(policy, maxAgeDays, now = Date.now()) {
  const verifiedAt = Date.parse(policy?.lastVerifiedAt || "");
  if (!Number.isFinite(verifiedAt)) return true;
  return Number(now) - verifiedAt > Number(maxAgeDays || 30) * DAY_MS;
}

function matchesRule(rule, query) {
  const fields = [
    ["passportCountryCode", normalizePassportCountry],
    ["transitCountry", (value) => String(value || "").toUpperCase()],
    ["airport", (value) => String(value || "").toUpperCase()],
    ["transferType", (value) => String(value || "")],
    ["baggageProfile", (value) => String(value || "")]
  ];
  return fields.every(([field, normalize]) => (
    rule[field] === undefined ||
    rule[field] === null ||
    rule[field] === "*" ||
    normalize(rule[field]) === normalize(query[field])
  ));
}

class ManualTransitPolicyProvider {
  constructor(policies = []) {
    this.name = "manual-static";
    this.policies = policies;
  }

  async lookup(query) {
    const matches = this.policies
      .filter((rule) => matchesRule(rule, query))
      .sort((left, right) => {
        const specificity = (rule) => [
          "passportCountryCode",
          "transitCountry",
          "airport",
          "transferType",
          "baggageProfile"
        ].filter((field) => rule[field] && rule[field] !== "*").length;
        return specificity(right) - specificity(left);
      });
    if (!matches.length) {
      return {
        status: "unknown",
        source: this.name,
        sourceUrl: null,
        lastVerifiedAt: null
      };
    }
    return {
      status: "known",
      provider: this.name,
      ...matches[0]
    };
  }
}

async function lookupTransitPolicy({
  provider,
  cache = {},
  query,
  maxAgeDays = 30,
  now = Date.now()
}) {
  const key = policyCacheKey(query);
  const cached = cache[key];
  if (cached && !isPolicyStale(cached.policy, maxAgeDays, now)) {
    return {
      key,
      policy: cached.policy,
      stale: false,
      fromCache: true,
      cache
    };
  }

  const policy = provider
    ? await provider.lookup(query)
    : {
        status: "unknown",
        source: null,
        sourceUrl: null,
        lastVerifiedAt: null
      };
  const nextCache = {
    ...cache,
    [key]: {
      query,
      policy,
      cachedAt: new Date(now).toISOString()
    }
  };
  return {
    key,
    policy,
    stale: policy.status === "known" && isPolicyStale(policy, maxAgeDays, now),
    fromCache: false,
    cache: nextCache
  };
}

function aggregateBoolean(values) {
  if (values.some((value) => value === true)) return true;
  if (values.length && values.every((value) => value === false)) return false;
  return null;
}

function isKnownNumber(value) {
  return value !== null && value !== undefined && value !== "" &&
    Number.isFinite(Number(value));
}

function transferSavings(basePrice, protectedPrice) {
  const transfer = Number(basePrice);
  const protected = Number(protectedPrice);
  if (!Number.isFinite(transfer) || !Number.isFinite(protected) || protected <= 0) {
    return {
      amount: null,
      percent: null
    };
  }
  const amount = Math.round((protected - transfer) * 100) / 100;
  return {
    amount,
    percent: Math.round((amount / protected) * 100)
  };
}

function qualifiesTransferSavings(basePrice, protectedPrice, config = {}) {
  const settings = { ...DEFAULT_TRANSFER_CONFIG, ...config };
  const savings = transferSavings(basePrice, protectedPrice);
  return {
    ...savings,
    qualifies: savings.amount !== null &&
      savings.amount >= Number(settings.selfTransferMinimumSavingAmount) &&
      savings.percent >= Number(settings.selfTransferMinimumSavingPercent)
  };
}

function defaultAssessment(status = "protected") {
  return {
    status,
    reasons: [],
    warnings: [],
    transitCountries: [],
    transitAirports: [],
    visaRequired: false,
    paidVisaRequired: false,
    authorizationRequired: false,
    authorizationName: null,
    authorizationCost: 0,
    immigrationLikely: false,
    baggageRecheckLikely: false,
    airportChange: false,
    terminalChange: false,
    minimumRecommendedConnectionMinutes: null,
    shortestConnectionMinutes: null,
    extraEstimatedCost: 0,
    policySource: null,
    policyLastVerifiedAt: null
  };
}

async function assessTransferRisk({
  offer,
  traveler = {},
  travelEndDate,
  currency,
  config = {},
  provider,
  cache = {},
  now = Date.now()
}) {
  const settings = { ...DEFAULT_TRANSFER_CONFIG, ...config };
  const isTransfer = Boolean(offer?.hasSelfTransfer || offer?.hasAirportChange);
  if (!isTransfer) {
    return {
      assessment: defaultAssessment("protected"),
      cache
    };
  }

  const reasons = [];
  const warnings = [
    "Separate tickets are not protected if an earlier flight is delayed or cancelled."
  ];
  let rejected = false;
  let manualReview = false;
  let nextCache = cache;
  const airportChange = Boolean(offer.hasAirportChange);

  if (offer.hasSelfTransfer && !settings.allowSelfTransfers) {
    rejected = true;
    reasons.push("Self-transfers are disabled by configuration.");
  }
  if (airportChange && !settings.allowAirportChanges) {
    rejected = true;
    reasons.push("Airport changes are disabled by configuration.");
  }

  const connections = offer.connections || [];
  if (!connections.length) {
    manualReview = true;
    reasons.push("The provider did not identify the individual transfer connection.");
  }

  const policyValues = [];
  const sources = new Set();
  const verifiedDates = [];
  const authorizationNames = new Set();
  let knownExtraCost = 0;
  let unknownExtraCost = false;
  let minimumRecommended = 0;
  let shortestConnection = null;

  for (const connection of connections) {
    const connectionAirportChange = Boolean(connection.airportChange);
    const immigrationLikely = connection.immigrationLikely !== false;
    const baggageRecheckLikely = Number(traveler.checkedBags || 0) > 0 ||
      connection.baggageRecheckLikely === true;
    const terminalUncertain = connection.terminalChange !== false;
    const minimum = connectionAirportChange
      ? Number(settings.airportChangeMinMinutes)
      : immigrationLikely || baggageRecheckLikely || terminalUncertain
        ? Number(settings.immigrationOrRecheckMinMinutes)
        : Number(settings.sameAirportSelfTransferMinMinutes);
    minimumRecommended = Math.max(minimumRecommended, minimum);

    const duration = Number(connection.durationMinutes);
    if (Number.isFinite(duration) && duration > 0) {
      shortestConnection = shortestConnection === null
        ? duration
        : Math.min(shortestConnection, duration);
      if (duration < minimum) {
        rejected = true;
        reasons.push(
          `${connection.arrivalAirport || connection.airport} connection is ${duration} minutes; at least ${minimum} minutes is required.`
        );
      }
    } else {
      manualReview = true;
      reasons.push(`Connection time at ${connection.airport || "an unknown airport"} is unavailable.`);
    }

    const transitCountry = connection.transitCountry || null;
    const airport = connection.airport || connection.arrivalAirport || null;
    if (!transitCountry || !airport) {
      manualReview = true;
      reasons.push("Transit country or airport metadata is incomplete.");
      continue;
    }

    const lookup = await lookupTransitPolicy({
      provider,
      cache: nextCache,
      query: {
        passportCountryCode: traveler.passportCountryCode,
        transitCountry,
        airport,
        transferType: connectionAirportChange ? "airport-change" : "self-transfer",
        baggageProfile: traveler.baggageProfile,
        carryOnBags: Number(traveler.carryOnBags || 0),
        checkedBags: Number(traveler.checkedBags || 0)
      },
      maxAgeDays: settings.transitPolicyMaxAgeDays,
      now
    });
    nextCache = lookup.cache;
    const policy = lookup.policy;
    policyValues.push(policy);

    if (policy.status !== "known") {
      manualReview = true;
      reasons.push(`No maintained transit policy is available for ${airport}, ${transitCountry}.`);
      continue;
    }
    if (lookup.stale) {
      manualReview = true;
      reasons.push(`The maintained transit policy for ${airport} is stale.`);
      continue;
    }

    if (policy.source || policy.sourceUrl) {
      sources.add(policy.sourceUrl || policy.source);
    } else {
      manualReview = true;
      reasons.push(`Policy evidence for ${airport} has no source metadata.`);
    }
    if (policy.lastVerifiedAt) verifiedDates.push(policy.lastVerifiedAt);
    if (policy.paidVisaRequired === true) {
      rejected = true;
      reasons.push(`A paid transit or entry visa is required at ${airport}.`);
    }
    if (immigrationLikely && policy.entryPermitted !== true) {
      if (policy.entryPermitted === false) {
        rejected = true;
        reasons.push(`The maintained policy does not permit immigration at ${airport}.`);
      } else {
        manualReview = true;
        reasons.push(`Immigration eligibility at ${airport} is not confirmed.`);
      }
    }
    const requiredFields = [
      "visaRequired",
      "paidVisaRequired",
      "authorizationRequired",
      "passportValidityRule",
      "passportValidityMinimumMonthsAfterTravel",
      "onwardTravelRequirement",
      "terminalTransferFeasible"
    ];
    const missing = requiredFields.filter((field) => (
      policy[field] === undefined || policy[field] === null || policy[field] === ""
    ));
    if (missing.length) {
      manualReview = true;
      reasons.push(`Policy evidence for ${airport} is incomplete: ${missing.join(", ")}.`);
    }
    if (policy.authorizationRequired === true) {
      if (
        !policy.authorizationName ||
        !isKnownNumber(policy.authorizationCost) ||
        !policy.authorizationCostCurrency
      ) {
        manualReview = true;
        reasons.push(`Authorization details for ${airport} are incomplete.`);
      } else if (
        currency &&
        String(policy.authorizationCostCurrency).toUpperCase() !==
          String(currency).toUpperCase()
      ) {
        manualReview = true;
        unknownExtraCost = true;
        reasons.push(
          `${policy.authorizationName} is priced in ${policy.authorizationCostCurrency}; no verified conversion to ${currency} is configured.`
        );
      } else {
        authorizationNames.add(policy.authorizationName);
        knownExtraCost += Number(policy.authorizationCost);
        warnings.push(
          `${policy.authorizationName} is required and costs ${Number(policy.authorizationCost).toFixed(2)} in the itinerary currency.`
        );
      }
    }
    if (policy.visaRequired === true && policy.paidVisaRequired === false) {
      warnings.push(`A no-fee visa or transit permit is required at ${airport}.`);
    }
    if (policy.passportValidityRule) {
      warnings.push(`Passport validity: ${policy.passportValidityRule}`);
    }
    const passportExpiry = Date.parse(`${traveler.passportExpiresOn || ""}T00:00:00Z`);
    const tripEnd = Date.parse(`${travelEndDate || ""}T00:00:00Z`);
    const validityMonths = Number(policy.passportValidityMinimumMonthsAfterTravel);
    if (
      !Number.isFinite(passportExpiry) ||
      !Number.isFinite(tripEnd) ||
      !Number.isFinite(validityMonths)
    ) {
      manualReview = true;
      reasons.push("Passport expiry could not be checked against the maintained validity rule.");
    } else {
      const requiredExpiry = new Date(tripEnd);
      requiredExpiry.setUTCMonth(requiredExpiry.getUTCMonth() + validityMonths);
      if (passportExpiry < requiredExpiry.getTime()) {
        rejected = true;
        reasons.push(
          `Passport expires before the required ${validityMonths}-month post-travel validity date.`
        );
      }
    }
    if (policy.onwardTravelRequirement) {
      warnings.push(`Onward travel: ${policy.onwardTravelRequirement}`);
    }
    if (policy.terminalTransferFeasible !== true) {
      manualReview = true;
      reasons.push(`Terminal movement feasibility at ${airport} is not confirmed.`);
    }

    if (connectionAirportChange) {
      const transferKey = `${connection.arrivalAirport}-${connection.departureAirport}`;
      const groundTransfer = settings.airportTransfers?.[transferKey];
      if (
        !groundTransfer ||
        !isKnownNumber(groundTransfer.cost) ||
        !isKnownNumber(groundTransfer.minutes)
      ) {
        manualReview = true;
        unknownExtraCost = true;
        reasons.push(`Ground-transfer time and cost for ${transferKey} are not configured.`);
      } else {
        const groundRequired = Number(groundTransfer.minutes) +
          Number(settings.sameAirportSelfTransferMinMinutes);
        minimumRecommended = Math.max(minimumRecommended, groundRequired);
        if (Number.isFinite(duration) && duration < groundRequired) {
          rejected = true;
          reasons.push(
            `${transferKey} leaves too little time after the estimated ground transfer; at least ${groundRequired} minutes is required.`
          );
        }
        knownExtraCost += Number(groundTransfer.cost);
        warnings.push(
          `${transferKey} ground transfer is estimated at ${groundTransfer.minutes} minutes and ${Number(groundTransfer.cost).toFixed(2)} in the itinerary currency.`
        );
      }
    }
  }

  const baggageRecheckLikely = Number(traveler.checkedBags || 0) > 0 ||
    connections.some((connection) => connection.baggageRecheckLikely === true);
  if (Number(traveler.carryOnBags || 0) > 0) {
    if (!isKnownNumber(settings.carryOnBagFee)) {
      manualReview = true;
      unknownExtraCost = true;
      reasons.push("Carry-on baggage cost is not configured.");
    } else {
      knownExtraCost += Number(traveler.carryOnBags) * Number(settings.carryOnBagFee);
    }
  }
  if (Number(traveler.checkedBags || 0) > 0) {
    if (!isKnownNumber(settings.checkedBagFee)) {
      manualReview = true;
      unknownExtraCost = true;
      reasons.push("Checked-baggage fee is not configured.");
    } else {
      knownExtraCost += Number(traveler.checkedBags) * Number(settings.checkedBagFee);
    }
  }
  if (baggageRecheckLikely) {
    if (!isKnownNumber(settings.checkedBagRecheckCost)) {
      manualReview = true;
      unknownExtraCost = true;
      reasons.push("Checked-bag recheck cost is not configured.");
    } else {
      knownExtraCost += Number(settings.checkedBagRecheckCost);
    }
  }

  if (connections.some((connection) => connection.overnight)) {
    if (!isKnownNumber(settings.overnightAccommodationCost)) {
      manualReview = true;
      unknownExtraCost = true;
      reasons.push("Overnight accommodation cost is not configured.");
    } else {
      knownExtraCost += Number(settings.overnightAccommodationCost);
    }
  }

  if (
    settings.requireKnownOnwardFallback &&
    connections.some((connection) => connection.onwardIsLastPracticalDeparture === null ||
      connection.onwardIsLastPracticalDeparture === undefined)
  ) {
    manualReview = true;
    reasons.push("The availability of a later practical onward flight is not confirmed.");
  } else if (connections.some((connection) => connection.onwardIsLastPracticalDeparture === true)) {
    warnings.push("The onward flight may be the last practical departure of the day.");
  }

  const status = rejected
    ? "self-transfer-rejected"
    : manualReview
      ? "self-transfer-manual-review"
      : "self-transfer-acceptable";
  const authorizationRequired = aggregateBoolean(
    policyValues.map((policy) => policy.authorizationRequired)
  );
  const visaRequired = aggregateBoolean(policyValues.map((policy) => policy.visaRequired));
  const paidVisaRequired = aggregateBoolean(
    policyValues.map((policy) => policy.paidVisaRequired)
  );
  const policyLastVerifiedAt = verifiedDates.length
    ? [...verifiedDates].sort()[0]
    : null;

  return {
    assessment: {
      status,
      reasons: [...new Set(reasons)],
      warnings: [...new Set(warnings)],
      transitCountries: [...new Set(connections.map((item) => item.transitCountry).filter(Boolean))],
      transitAirports: [...new Set(connections.map((item) => item.airport).filter(Boolean))],
      visaRequired,
      paidVisaRequired,
      authorizationRequired,
      authorizationName: authorizationNames.size
        ? [...authorizationNames].join(", ")
        : null,
      authorizationCost: authorizationRequired === true
        ? policyValues.reduce((sum, policy) => (
          sum + (Number(policy.authorizationCost) || 0)
        ), 0)
        : authorizationRequired === false
          ? 0
          : null,
      immigrationLikely: connections.length
        ? connections.some((item) => item.immigrationLikely !== false)
        : null,
      baggageRecheckLikely,
      airportChange,
      terminalChange: connections.length
        ? aggregateBoolean(connections.map((item) => item.terminalChange))
        : null,
      minimumRecommendedConnectionMinutes: minimumRecommended || null,
      shortestConnectionMinutes: shortestConnection,
      extraEstimatedCost: unknownExtraCost
        ? null
        : Math.round(knownExtraCost * 100) / 100,
      policySource: sources.size ? [...sources].join(", ") : null,
      policyLastVerifiedAt
    },
    cache: nextCache
  };
}

module.exports = {
  DEFAULT_TRANSFER_CONFIG,
  ManualTransitPolicyProvider,
  assessTransferRisk,
  isPolicyStale,
  isKnownNumber,
  lookupTransitPolicy,
  normalizePassportCountry,
  policyCacheKey,
  qualifiesTransferSavings,
  transferSavings
};
