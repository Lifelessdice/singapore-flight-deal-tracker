const crypto = require("node:crypto");
const {
  analyzeFareHistory,
  getLeadTimeBucket,
  hasSameBaggageProfile,
  median
} = require("./fare-insights");

const ABSOLUTE_MAX_CALLS = 14;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function configuredDatePairs(route, now = Date.now()) {
  const departureDates = route?.departureDates || [route?.departureDate];
  const returnDates = route?.returnDates || [route?.returnDate];
  const minimumDays = Number(route?.minTripDays || 2);
  const maximumDays = Number(route?.maxTripDays || 4);
  const pairs = [];

  for (const departureDate of departureDates.filter(Boolean)) {
    const departure = Date.parse(`${departureDate}T00:00:00Z`);
    if (!Number.isFinite(departure) || departure <= now) continue;
    for (const returnDate of returnDates.filter(Boolean)) {
      const returning = Date.parse(`${returnDate}T00:00:00Z`);
      const tripDays = Math.round((returning - departure) / (24 * 60 * 60 * 1000));
      if (tripDays < minimumDays || tripDays > maximumDays) continue;
      pairs.push({ departureDate, returnDate, tripDays });
    }
  }

  return pairs;
}

function cycleItems(items, cursor, count) {
  if (!items.length || count <= 0) return [];
  const start = Math.max(0, Number(cursor || 0)) % items.length;
  const selected = [];
  for (let index = 0; index < Math.min(count, items.length); index += 1) {
    selected.push(items[(start + index) % items.length]);
  }
  return selected;
}

function buildDateFirstExploreLanes(routes, discovery = {}, state = {}, now = Date.now()) {
  const roundTrips = [];
  const oneWays = [];
  const seenRoundTrips = new Set();
  const seenOneWays = new Set();

  for (const route of routes || []) {
    const origins = route.originLocationCodes || [
      route.originLocationCode || route.origin || discovery.origin
    ];
    const common = {
      adults: Number(route.adults || discovery.adults || 1),
      currencyCode: route.currencyCode || discovery.currencyCode || "USD",
      travelClass: route.travelClass || discovery.travelClass || "ECONOMY",
      maxPrice: Number(
        route.maxRoundTripPrice ||
        route.maxPrice ||
        discovery.targetRoundTripPrice
      ) || null,
      maxDiscoveryPrice: Number(discovery.maxDiscoveryPrice) || null,
      maxTotalDurationMinutes: Number(
        route.maxTotalDurationMinutes || discovery.maxTotalDurationMinutes
      ) || null,
      maxStops: Number.isFinite(Number(route.maxStops))
        ? Number(route.maxStops)
        : Number(discovery.maxStops || 0),
      carryOnBags: Math.max(0, Number(route.carryOnBags ?? discovery.carryOnBags ?? 0)),
      checkedBags: Math.max(0, Number(route.checkedBags ?? discovery.checkedBags ?? 0)),
      baggageProfile: route.baggageProfile || discovery.baggageProfile || "",
      passportNationality: route.passportNationality ||
        discovery.passportNationality ||
        "Switzerland",
      passportCountryCode: route.passportCountryCode ||
        discovery.passportCountryCode ||
        "CHE",
      transitAirportCountries: route.transitAirportCountries ||
        discovery.transitAirportCountries ||
        {}
    };

    for (const origin of origins.filter(Boolean)) {
      for (const pair of configuredDatePairs(route, now)) {
        const key = `${origin}|${pair.departureDate}|${pair.returnDate}`;
        if (seenRoundTrips.has(key)) continue;
        seenRoundTrips.add(key);
        roundTrips.push({
          ...common,
          id: `date-first-return|${key}`,
          routeId: route.id,
          label: `${route.label || origin} date-first discovery`,
          laneType: "date-first-return",
          origin,
          departureDate: pair.departureDate,
          returnDate: pair.returnDate,
          tripType: "round-trip",
          tripLengthDays: pair.tripDays
        });
      }

      if (route.includeOneWay) {
        for (const departureDate of (route.departureDates || [route.departureDate]).filter(Boolean)) {
          const departure = Date.parse(`${departureDate}T00:00:00Z`);
          const key = `${origin}|${departureDate}`;
          if (!Number.isFinite(departure) || departure <= now || seenOneWays.has(key)) continue;
          seenOneWays.add(key);
          oneWays.push({
            ...common,
            id: `date-first-one-way|${key}`,
            routeId: route.id,
            label: `${route.label || origin} one-way discovery`,
            laneType: "date-first-one-way",
            origin,
            departureDate,
            returnDate: "",
            tripType: "one-way",
            maxPrice: Number(
              route.maxOneWayPrice || route.maxPrice || discovery.targetOneWayPrice
            ) || null,
            tripLengthDays: null
          });
        }
      }
    }
  }

  const returnCount = Math.max(0, Number(discovery.fixedDateReturnLanesPerRun ?? 1));
  const oneWayCount = Math.max(0, Number(discovery.fixedDateOneWayLanesPerRun ?? 1));
  const returnCursor = Number(state.dateFirstReturnCursor || 0);
  const oneWayCursor = Number(state.dateFirstOneWayCursor || 0);
  const selectedReturns = cycleItems(roundTrips, returnCursor, returnCount);
  const selectedOneWays = cycleItems(oneWays, oneWayCursor, oneWayCount);

  return {
    lanes: [...selectedReturns, ...selectedOneWays],
    returnLaneCount: roundTrips.length,
    oneWayLaneCount: oneWays.length,
    nextReturnCursor: roundTrips.length
      ? (returnCursor + selectedReturns.length) % roundTrips.length
      : 0,
    nextOneWayCursor: oneWays.length
      ? (oneWayCursor + selectedOneWays.length) % oneWays.length
      : 0
  };
}

function comparableDiscoveryHistory(history, candidate) {
  const departureMonth = String(candidate.departureDate || "").slice(0, 7);
  const departureDay = new Date(`${candidate.departureDate}T00:00:00Z`).getUTCDay();
  const weekendDeparture = departureDay === 5 || departureDay === 6;
  const leadTimeBucket = getLeadTimeBucket(
    candidate.departureDate,
    candidate.observedAt || Date.now()
  );

  return (history || []).filter((item) => {
    const strategy = item.searchStrategy || "protected";
    const itemDepartureDay = new Date(`${item.departureDate}T00:00:00Z`).getUTCDay();
    const itemTripLength = item.returnDate
      ? Math.round((
        Date.parse(`${item.returnDate}T00:00:00Z`) -
        Date.parse(`${item.departureDate}T00:00:00Z`)
      ) / (24 * 60 * 60 * 1000))
      : null;
    const sameTripLength = candidate.tripLengthDays === null
      ? !item.returnDate
      : Math.abs(Number(item.tripLengthDays ?? itemTripLength) - candidate.tripLengthDays) <= 1;
    return (
      item.origin === candidate.origin &&
      item.destination === candidate.destination &&
      (item.tripType || (item.returnDate ? "round-trip" : "one-way")) ===
        candidate.tripType &&
      ["standard", "protected"].includes(strategy) &&
      hasSameBaggageProfile(item, candidate) &&
      String(item.currency || candidate.currencyCode || "") ===
        String(candidate.currencyCode || item.currency || "") &&
      String(item.travelClass || candidate.travelClass || "ECONOMY") ===
        String(candidate.travelClass || item.travelClass || "ECONOMY") &&
      Number(item.adults ?? candidate.adults ?? 1) ===
        Number(candidate.adults ?? item.adults ?? 1) &&
      String(item.departureDate || "").slice(0, 7) === departureMonth &&
      (item.weekendDeparture ?? (itemDepartureDay === 5 || itemDepartureDay === 6)) ===
        weekendDeparture &&
      (item.leadTimeBucket || getLeadTimeBucket(item.departureDate, item.loggedAt)) ===
        leadTimeBucket &&
      sameTripLength
    );
  });
}

function rankExploreCandidates(
  candidates,
  history,
  knownDestinations = new Set(),
  options = {}
) {
  return (candidates || []).map((candidate) => {
    const observedAt = Number(candidate.observedAt || Date.now());
    const routeHistory = comparableDiscoveryHistory(history, {
      ...candidate,
      observedAt
    });
    const marketEvidenceMaximumAgeDays = Math.max(
      1,
      Number(options.marketEvidenceMaxAgeDays || 30)
    );
    const marketEvidenceCutoff = observedAt -
      marketEvidenceMaximumAgeDays * 24 * 60 * 60 * 1000;
    const historicalMarketEntry = [...routeHistory]
      .filter((item) => Number(item.loggedAt || 0) >= marketEvidenceCutoff)
      .sort((left, right) => Number(right.loggedAt || 0) - Number(left.loggedAt || 0))
      .find((item) => (
        Array.isArray(item.googlePriceInsights?.typical_price_range) ||
        Array.isArray(item.googlePriceInsights?.price_history)
      ));
    const marketInsights = candidate.googlePriceInsights ||
      historicalMarketEntry?.googlePriceInsights ||
      null;
    const entry = {
      price: Number(candidate.price),
      loggedAt: observedAt,
      googlePriceInsights: marketInsights
    };
    const insights = analyzeFareHistory(
      [...routeHistory, entry],
      candidate.maxPrice,
      { marketInsights }
    );
    const providerDiscount = candidate.discountPercentage === null ||
      candidate.discountPercentage === undefined ||
      candidate.discountPercentage === ""
      ? null
      : Number(candidate.discountPercentage);
    const averagePrice = Number(candidate.averagePrice);
    const averageDiscount = Number.isFinite(averagePrice) && averagePrice > 0
      ? ((averagePrice - Number(candidate.price)) / averagePrice) * 100
      : null;
    const historyDiscount = insights.latestVsMedianPct === null
      ? null
      : -insights.latestVsMedianPct;
    const typicalDiscount = insights.latestVsMarketPct === null
      ? null
      : -insights.latestVsMarketPct;
    const externalDiscount = Math.max(
      0,
      Number.isFinite(providerDiscount) ? providerDiscount : 0,
      Number.isFinite(averageDiscount) ? averageDiscount : 0,
      Number.isFinite(typicalDiscount) ? typicalDiscount : 0
    );
    const rankingLevel = externalDiscount >= 20
      ? "strong-deal"
      : externalDiscount >= 10
        ? "good-deal"
        : insights.level;
    const rankingConfidence = (
      insights.marketBaselineAvailable ||
      Number.isFinite(providerDiscount) ||
      Number.isFinite(averageDiscount)
    )
      ? "medium"
      : insights.confidence;
    const value = scoreTravelerValue({
      entry: {
        price: Number(candidate.price),
        tripType: candidate.tripType,
        searchStrategy: "protected",
        returnVerified: candidate.tripType === "one-way",
        weekendDeparture: [5, 6].includes(new Date(
          `${candidate.departureDate}T00:00:00Z`
        ).getUTCDay()),
        maxStops: Number(candidate.stops || 0)
      },
      insights: {
        ...insights,
        level: rankingLevel,
        confidence: rankingConfidence
      },
      offer: {
        totalDurationMinutes: Number(candidate.totalDurationMinutes || 0),
        maxStops: Number(candidate.stops || 0),
        hasOvernight: Boolean(candidate.hasOvernight),
        baggageNotes: candidate.baggageNotes || []
      },
      search: { maxPrice: candidate.maxPrice }
    });
    const localRelativeDiscount = Math.max(
      0,
      Number.isFinite(historyDiscount) ? historyDiscount : 0
    );
    const relativeEvidenceAvailable = (
      insights.baselineSampleCount >= 3 ||
      insights.marketBaselineAvailable ||
      Number.isFinite(providerDiscount) ||
      Number.isFinite(averageDiscount)
    );
    const relativeEvidenceScore = Math.min(45, externalDiscount * 1.5) +
      Math.min(20, localRelativeDiscount);
    const score = Number((
      relativeEvidenceScore +
      value.score * 0.55 -
      Number(candidate.stops || 0) * 4 -
      Math.max(0, Number(candidate.totalDurationMinutes || 0) - 360) / 60 -
      (relativeEvidenceAvailable ? 0 : 10)
    ).toFixed(2));

    return {
      ...candidate,
      unfamiliar: !knownDestinations.has(candidate.destination),
      ranking: {
        score,
        relativeEvidenceAvailable,
        explorationOnly: !relativeEvidenceAvailable,
        marketEvidenceSource: candidate.googlePriceInsights
          ? "current-candidate"
          : historicalMarketEntry
            ? "matched-exact-history"
            : null,
        providerDiscount: Number.isFinite(providerDiscount) ? providerDiscount : null,
        averageDiscount: Number.isFinite(averageDiscount)
          ? Math.round(averageDiscount)
          : null,
        historyDiscount: Number.isFinite(historyDiscount) ? historyDiscount : null,
        typicalDiscount: Number.isFinite(typicalDiscount) ? typicalDiscount : null,
        baselineSampleCount: insights.baselineSampleCount,
        travelerValueScore: value.score,
        reasons: [
          externalDiscount > 0 ? `${Math.round(externalDiscount)}% external discount evidence` : null,
          localRelativeDiscount > 0
            ? `${Math.round(localRelativeDiscount)}% below matched history`
            : null,
          !relativeEvidenceAvailable
            ? "exploration-only; relative evidence requires exact verification"
            : null,
          `${Number(candidate.stops || 0)} stops`,
          `${Number(candidate.totalDurationMinutes || 0)} minutes`
        ].filter(Boolean)
      }
    };
  }).sort((a, b) => (
    b.ranking.score - a.ranking.score ||
    Number(a.price) - Number(b.price) ||
    a.destination.localeCompare(b.destination)
  ));
}

function selectExploreCandidates(ranked, limit = 3) {
  const maximum = Math.max(0, Number(limit || 0));
  if (!maximum) return [];
  const selected = [];
  const keys = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const key = [
      candidate.origin,
      candidate.destination,
      candidate.departureDate,
      candidate.returnDate || "",
      candidate.tripType
    ].join("|");
    if (keys.has(key) || selected.length >= maximum) return;
    keys.add(key);
    selected.push(candidate);
  };

  if (maximum >= 2) {
    add(ranked.find((candidate) => candidate.tripType === "round-trip"));
    add(ranked.find((candidate) => candidate.tripType === "one-way"));
  }
  add(ranked.find((candidate) => candidate.unfamiliar));
  ranked.forEach(add);
  return selected.sort((a, b) => b.ranking.score - a.ranking.score);
}

function scoreTravelerValue(candidate) {
  const entry = candidate.entry || {};
  const insights = candidate.insights || {};
  const offer = candidate.offer || {};
  const target = Number(candidate.search?.maxPrice);
  const price = Number(entry.price);
  const reasons = [];
  const risks = [];
  let score = 45;

  if (insights.level === "strong-deal") {
    score += 25;
    reasons.push("strong relative price anomaly");
  } else if (insights.level === "good-deal") {
    score += 18;
    reasons.push("good relative price anomaly");
  } else if (insights.level === "wait") {
    score -= 15;
    risks.push("price is high versus its baseline");
  }

  if (insights.confidence === "high") {
    score += 10;
    reasons.push("two external Google market baselines");
  } else if (insights.confidence === "medium") {
    score += 5;
    reasons.push("one external Google market baseline");
  } else {
    risks.push("external market baseline unavailable");
  }

  if (Number.isFinite(target) && target > 0 && Number.isFinite(price)) {
    if (price <= target) {
      score += 10;
      reasons.push("inside the student price target");
    } else if (price > target * 1.5) {
      score -= 12;
      risks.push("well above the student price target");
    } else if (price > target * 1.2) {
      score -= 5;
    }
  }

  if (entry.weekendDeparture) {
    score += 5;
    reasons.push("weekend departure");
  } else {
    risks.push("weekday departure");
  }

  const longestDirection = Math.max(
    Number(offer.outboundDurationMinutes || offer.totalDurationMinutes) || 0,
    Number(offer.returnDurationMinutes) || 0
  );
  if (longestDirection > 8 * 60) {
    score -= 12;
    risks.push("long travel time for a short trip");
  } else if (longestDirection > 5 * 60) {
    score -= 5;
  }

  const stops = Number(entry.maxStops ?? offer.maxStops) || 0;
  score -= stops * 4;
  if (stops > 0) risks.push(`${stops} stop${stops === 1 ? "" : "s"} per direction`);

  if (offer.hasOvernight) {
    score -= 8;
    risks.push("overnight travel");
  }
  if (offer.hasSelfTransfer || offer.hasAirportChange) {
    score -= 25;
    risks.push("self-transfer or airport change");
  }
  if (!offer.baggageNotes?.length) {
    score -= 4;
    risks.push("personal-item allowance unconfirmed");
  }
  if (entry.searchStrategy === "split-one-ways") {
    score -= 6;
    risks.push("two independent bookings");
  }
  if (entry.searchStrategy === "open-jaw") {
    score -= 4;
    risks.push("ground transfer between destination airports/cities");
  }
  if (entry.tripType === "one-way") {
    score -= 5;
    risks.push("return cost not included");
  }

  score = Math.round(clamp(score, 0, 100));
  const qualifies = ["good-deal", "strong-deal"].includes(insights.level);
  const completeRoundTrip = entry.tripType !== "round-trip" ||
    entry.returnVerified ||
    ["split-one-ways", "open-jaw"].includes(entry.searchStrategy);
  let action = "SKIP";
  if (qualifies && completeRoundTrip && score >= 70) {
    action = "BOOK";
  } else if (qualifies) {
    action = "VERIFY";
  } else if (insights.targetHit || score >= 48) {
    action = "WATCH";
  }
  if (entry.searchStrategy === "open-jaw" && action === "BOOK") {
    action = "VERIFY";
  }

  return {
    score,
    action,
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)]
  };
}

function latestEvidencePrice(history, predicate, now, maximumAgeDays = 45) {
  const cutoff = Number(now || Date.now()) -
    Number(maximumAgeDays || 45) * 24 * 60 * 60 * 1000;
  const matches = (history || [])
    .filter((item) => Number(item.loggedAt || 0) >= cutoff)
    .filter(predicate)
    .sort((left, right) => Number(right.loggedAt || 0) - Number(left.loggedAt || 0));
  if (!matches.length) return null;
  const newestDay = new Date(Number(matches[0].loggedAt)).toISOString().slice(0, 10);
  const newestPrices = matches
    .filter((item) => new Date(Number(item.loggedAt)).toISOString().slice(0, 10) === newestDay)
    .map((item) => Number(item.price))
    .filter((price) => Number.isFinite(price) && price > 0);
  return newestPrices.length
    ? {
        price: median(newestPrices),
        observedAt: Number(matches[0].loggedAt),
        samples: newestPrices.length
      }
    : null;
}

function sameConstructionProfile(item, criteria) {
  return (
    String(item.currency || "") === String(criteria.currencyCode || "") &&
    String(item.travelClass || "") === String(criteria.travelClass || "") &&
    Number(item.adults) === Number(criteria.adults || 1) &&
    hasSameBaggageProfile(item, criteria)
  );
}

function isProtectedConstructionEvidence(item) {
  const strategy = item.searchStrategy || "standard";
  return (
    (item.itineraryProtection || "protected") === "protected" &&
    !["self-transfer", "airport-change"].includes(strategy)
  );
}

function sameObservedTrip(
  item,
  origin,
  destination,
  departureDate,
  tripType,
  criteria
) {
  return item.origin === origin &&
    item.destination === destination &&
    (item.tripType || (item.returnDate ? "round-trip" : "one-way")) === tripType &&
    item.departureDate === departureDate &&
    String(item.returnDate || "") === String(criteria.returnDate || "") &&
    sameConstructionProfile(item, criteria) &&
    isProtectedConstructionEvidence(item);
}

function scoreConstructionDefinition(definition, context) {
  const {
    history,
    referenceSearch,
    referencePrice,
    now,
    state
  } = context;
  const maximumAgeDays = Number(context.maximumEvidenceAgeDays || 45);
  const relevantReferenceDestination = definition.type === "split-one-ways"
    ? referenceSearch.destination
    : definition.type === "nearby-airports"
      ? definition.airports.includes(referenceSearch.destination)
        ? referenceSearch.destination
        : definition.airports[0]
      : [definition.outboundDestination, definition.inboundOrigin]
          .includes(referenceSearch.destination)
        ? referenceSearch.destination
        : definition.outboundDestination;
  const referencePriceMatchesDefinition = definition.type === "split-one-ways" ||
    referenceSearch.destination === relevantReferenceDestination;
  const protectedReference = referencePriceMatchesDefinition &&
    Number.isFinite(Number(referencePrice))
    ? {
        price: Number(referencePrice),
        observedAt: Number(now || Date.now()),
        samples: 1
      }
    : latestEvidencePrice(
      history,
      (item) => (
        sameObservedTrip(
          item,
          referenceSearch.origin,
          relevantReferenceDestination,
          referenceSearch.departureDate,
          "round-trip",
          referenceSearch
        ) &&
        ["standard", "protected"].includes(item.searchStrategy || "standard")
      ),
      now,
      maximumAgeDays
    );
  let expectedPrice = null;
  let evidenceCount = protectedReference ? 1 : 0;
  const evidence = [];

  if (definition.type === "split-one-ways") {
    const outbound = latestEvidencePrice(
      history,
      (item) => sameObservedTrip(
        item,
        referenceSearch.origin,
        referenceSearch.destination,
        referenceSearch.departureDate,
        "one-way",
        { ...referenceSearch, returnDate: "" }
      ),
      now,
      maximumAgeDays
    );
    const reverse = latestEvidencePrice(
      history,
      (item) => sameObservedTrip(
        item,
        referenceSearch.destination,
        referenceSearch.origin,
        referenceSearch.returnDate,
        "one-way",
        { ...referenceSearch, returnDate: "" }
      ),
      now,
      maximumAgeDays
    );
    if (outbound) {
      evidenceCount += 1;
      evidence.push(`recent outbound one-way ${outbound.price}`);
    }
    if (reverse) {
      evidenceCount += 1;
      evidence.push(`recent reverse one-way ${reverse.price}`);
    }
    if (outbound && reverse) expectedPrice = outbound.price + reverse.price;
  } else if (definition.type === "nearby-airports") {
    const priorGroup = latestEvidencePrice(
      history,
      (item) => (
        item.routeId === `construction-${definition.id}` &&
        item.searchStrategy === "nearby-airports" &&
        item.tripType === "round-trip" &&
        item.origin === referenceSearch.origin &&
        item.departureDate === referenceSearch.departureDate &&
        String(item.returnDate || "") === String(referenceSearch.returnDate || "") &&
        String(item.searchedDestination || definition.airports.join(",")) ===
          definition.airports.join(",") &&
        sameConstructionProfile(item, referenceSearch)
      ),
      now,
      maximumAgeDays
    );
    const airportPrices = definition.airports
      .map((airport) => latestEvidencePrice(
        history,
        (item) => (
          sameObservedTrip(
            item,
            referenceSearch.origin,
            airport,
            referenceSearch.departureDate,
            "round-trip",
            referenceSearch
          ) &&
          ["standard", "protected"].includes(item.searchStrategy || "standard")
        ),
        now,
        maximumAgeDays
      ))
      .filter(Boolean);
    if (priorGroup) {
      expectedPrice = priorGroup.price;
      evidenceCount += 1;
      evidence.push(`recent grouped fare ${priorGroup.price}`);
    } else if (airportPrices.length) {
      expectedPrice = Math.min(...airportPrices.map((item) => item.price));
      evidenceCount += airportPrices.length;
      evidence.push(`recent component-airport floor ${expectedPrice}`);
    }
  } else if (definition.type === "open-jaw") {
    const outbound = latestEvidencePrice(
      history,
      (item) => sameObservedTrip(
        item,
        referenceSearch.origin,
        definition.outboundDestination,
        referenceSearch.departureDate,
        "one-way",
        { ...referenceSearch, returnDate: "" }
      ),
      now,
      maximumAgeDays
    );
    const reverse = latestEvidencePrice(
      history,
      (item) => sameObservedTrip(
        item,
        definition.inboundOrigin,
        referenceSearch.origin,
        referenceSearch.returnDate,
        "one-way",
        { ...referenceSearch, returnDate: "" }
      ),
      now,
      maximumAgeDays
    );
    if (outbound) {
      evidenceCount += 1;
      evidence.push(`recent open-jaw outbound ${outbound.price}`);
    }
    if (reverse) {
      evidenceCount += 1;
      evidence.push(`recent open-jaw reverse ${reverse.price}`);
    }
    const surfaceTransferCost = Number(definition.surfaceTransferCost);
    const hasKnownSurfaceTransferCost = (
      definition.surfaceTransferCost !== null &&
      definition.surfaceTransferCost !== undefined &&
      definition.surfaceTransferCost !== "" &&
      Number.isFinite(surfaceTransferCost) &&
      surfaceTransferCost >= 0
    );
    if (outbound && reverse && hasKnownSurfaceTransferCost) {
      expectedPrice = outbound.price + reverse.price +
        surfaceTransferCost;
    } else if (outbound && reverse) {
      evidence.push("surface-transfer cost unknown");
    }
  }

  const expectedSavings = protectedReference && Number.isFinite(expectedPrice)
    ? Math.round((protectedReference.price - expectedPrice) * 100) / 100
    : null;
  const expectedSavingsPercent = expectedSavings !== null && protectedReference.price > 0
    ? Math.round((expectedSavings / protectedReference.price) * 100)
    : null;
  const lastSelectedAt = Date.parse(
    state?.constructionEvidence?.[definition.id]?.lastSelectedAt || ""
  );
  const daysSinceSelected = Number.isFinite(lastSelectedAt)
    ? Math.max(0, (Number(now || Date.now()) - lastSelectedAt) / (24 * 60 * 60 * 1000))
    : 60;
  const explorationValue = Math.min(12, daysSinceSelected / 5);
  const callEfficiency = definition.type === "nearby-airports" ? 5 : 0;
  const configuredSurfaceTransferCost = Number(definition.surfaceTransferCost);
  const hasConfiguredSurfaceTransferCost = (
    definition.surfaceTransferCost !== null &&
    definition.surfaceTransferCost !== undefined &&
    definition.surfaceTransferCost !== "" &&
    Number.isFinite(configuredSurfaceTransferCost) &&
    configuredSurfaceTransferCost >= 0
  );
  const incompleteOpenJawPenalty = definition.type === "open-jaw" &&
    !hasConfiguredSurfaceTransferCost
    ? 8
    : 0;
  const score = (
    evidenceCount * 8 +
    (expectedSavings === null ? 0 : expectedSavings / 4) +
    (expectedSavingsPercent === null ? 0 : expectedSavingsPercent * 1.5) +
    explorationValue +
    callEfficiency -
    incompleteOpenJawPenalty
  );

  return {
    definition,
    score: Number(score.toFixed(2)),
    expectedPrice,
    expectedSavings,
    expectedSavingsPercent,
    evidenceCount,
    evidence,
    protectedReferencePrice: protectedReference?.price ?? null
  };
}

function buildConstructionLane(config, state, referenceSearch, context = {}) {
  const groups = (config?.airportGroups || []).map((item) => ({
    ...item,
    type: "nearby-airports"
  }));
  const openJaws = (config?.openJaws || []).map((item) => ({
    ...item,
    type: "open-jaw"
  }));
  const split = config?.splitTickets?.enabled === true && referenceSearch
    ? [{
        id: `split-${referenceSearch.origin}-${referenceSearch.destination}`,
        label: `${referenceSearch.origin}-${referenceSearch.destination} as separate one ways`,
        type: "split-one-ways"
      }]
    : [];
  const definitions = [...split, ...groups, ...openJaws]
    .filter((item) => item.enabled !== false);
  if (!config?.enabled || !definitions.length || !referenceSearch?.returnDate) {
    return {
      definition: null,
      searches: [],
      nextCursor: Number(state?.constructionCursor || 0),
      ranking: []
    };
  }
  const ranking = definitions
    .map((definition) => scoreConstructionDefinition(definition, {
      ...context,
      state,
      referenceSearch
    }))
    .sort((left, right) => (
      right.score - left.score ||
      left.definition.id.localeCompare(right.definition.id)
    ));
  const selected = ranking[0];
  const definition = selected.definition;

  const common = {
    ...referenceSearch,
    routeId: `construction-${definition.id}`,
    label: definition.label,
    maxPrice: Number(config.targetRoundTripPrice || referenceSearch.maxPrice) || null
  };
  let searches;
  if (definition.type === "split-one-ways") {
    searches = [
      {
        ...common,
        routeId: `${definition.id}-outbound`,
        returnDate: "",
        tripType: "one-way",
        maxPrice: null,
        searchStrategy: "split-outbound",
        constructionId: definition.id
      },
      {
        ...common,
        routeId: `${definition.id}-inbound`,
        origin: referenceSearch.destination,
        destination: referenceSearch.origin,
        departureDate: referenceSearch.returnDate,
        returnDate: "",
        tripType: "one-way",
        maxPrice: null,
        searchStrategy: "split-inbound",
        constructionId: definition.id
      }
    ];
  } else if (definition.type === "nearby-airports") {
    searches = [{
      ...common,
      destination: definition.airports.join(","),
      destinationName: definition.label,
      searchStrategy: "nearby-airports",
      constructionId: definition.id
    }];
  } else {
    searches = [
      {
        ...common,
        routeId: `construction-${definition.id}-outbound`,
        destination: definition.outboundDestination,
        destinationName: definition.label,
        returnDate: "",
        tripType: "one-way",
        maxPrice: null,
        searchStrategy: "open-jaw-outbound",
        constructionId: definition.id
      },
      {
        ...common,
        routeId: `construction-${definition.id}-inbound`,
        origin: definition.inboundOrigin,
        destination: referenceSearch.origin,
        destinationName: definition.label,
        departureDate: referenceSearch.returnDate,
        returnDate: "",
        tripType: "one-way",
        maxPrice: null,
        searchStrategy: "open-jaw-inbound",
        constructionId: definition.id
      }
    ];
  }

  return {
    definition,
    searches,
    nextCursor: Number(state?.constructionCursor || 0),
    ranking,
    evidence: selected
  };
}

function exactSearchKey(search, kind = "exact") {
  return [
    kind,
    search.routeId || "",
    search.origin,
    search.destination,
    search.departureDate,
    search.returnDate || "",
    search.tripType,
    search.searchStrategy || "standard",
    search.travelClass || "ECONOMY",
    Number(search.adults || 1),
    Number(search.carryOnBags || 0),
    Number(search.checkedBags || 0)
  ].join("|");
}

function updateCoverage(coverage, search, kind, result, runId, now = Date.now()) {
  const next = { ...(coverage || {}) };
  const key = exactSearchKey(search, kind);
  const previous = next[key] || {};
  next[key] = {
    ...previous,
    routeId: search.routeId || null,
    origin: search.origin,
    destination: search.destination,
    departureDate: search.departureDate,
    returnDate: search.returnDate || "",
    tripType: search.tripType,
    searchStrategy: search.searchStrategy || "standard",
    kind,
    lastAttemptAt: new Date(now).toISOString(),
    lastSuccessAt: result.ok ? new Date(now).toISOString() : previous.lastSuccessAt || null,
    lastOfferAt: result.ok && result.offers?.length
      ? new Date(now).toISOString()
      : previous.lastOfferAt || null,
    lastError: result.ok ? null : result.error || "unknown provider error",
    runId
  };
  return next;
}

function summarizeCoverage(allSearches, coverage, options = {}) {
  const now = Number(options.now || Date.now());
  const horizonDays = Number(options.horizonDays || 90);
  const recentDays = Number(options.recentDays || 14);
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  const recentCutoff = now - recentDays * 24 * 60 * 60 * 1000;
  const eligible = (allSearches || []).filter((search) => {
    const departure = Date.parse(`${search.departureDate}T00:00:00Z`);
    return departure > now && departure <= horizon;
  });
  const events = Object.values(coverage || {});
  const recentlyAttempted = new Set(
    events
      .filter((item) => Date.parse(item.lastAttemptAt || "") >= recentCutoff)
      .map((item) => exactSearchKey(item, item.kind))
  );
  const recentlySuccessful = new Set(
    events
      .filter((item) => Date.parse(item.lastSuccessAt || "") >= recentCutoff)
      .map((item) => exactSearchKey(item, item.kind))
  );
  const covered = eligible.filter((search) => recentlyAttempted.has(exactSearchKey(search)));
  const successful = eligible.filter((search) => recentlySuccessful.has(exactSearchKey(search)));
  const destinations = [...new Set(eligible.map((search) => search.destination))];
  const staleDestinations = destinations.filter((destination) => (
    !eligible.some((search) => (
      search.destination === destination &&
      recentlyAttempted.has(exactSearchKey(search))
    ))
  ));

  return {
    eligibleSearches: eligible.length,
    recentlyCoveredSearches: covered.length,
    recentlySuccessfulSearches: successful.length,
    coveragePercent: eligible.length
      ? Math.round((covered.length / eligible.length) * 100)
      : 100,
    destinationCount: destinations.length,
    staleDestinations,
    recentDays,
    horizonDays
  };
}

function buildQuotaSnapshot(account, reserveSearches = 10) {
  const remaining = Number(account?.total_searches_left ?? account?.plan_searches_left);
  const limit = Number(account?.searches_per_month);
  const used = Number(account?.this_month_usage);
  const safeRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : null;
  return {
    planName: account?.plan_name || "unknown",
    monthlyLimit: Number.isFinite(limit) ? limit : null,
    usedThisMonth: Number.isFinite(used) ? used : null,
    remaining: safeRemaining,
    reserveSearches: Number(reserveSearches) || 0,
    spendableThisRun: safeRemaining === null
      ? null
      : Math.max(0, safeRemaining - (Number(reserveSearches) || 0)),
    renewalDate: account?.plan_renewal_date || null
  };
}

function createCallBudget(maximumCalls, spendableSearches = null) {
  const configuredMaximum = Math.min(
    ABSOLUTE_MAX_CALLS,
    Math.max(0, Number(maximumCalls || 0))
  );
  const safeSpendable = spendableSearches !== null &&
    spendableSearches !== undefined &&
    Number.isFinite(Number(spendableSearches))
    ? Math.max(0, Number(spendableSearches))
    : configuredMaximum;
  const limit = Math.min(configuredMaximum, safeSpendable);
  let attempted = 0;
  return {
    limit,
    canSpend() {
      return attempted < limit;
    },
    recordAttempt() {
      if (attempted >= limit) return false;
      attempted += 1;
      return true;
    },
    snapshot() {
      return {
        attempted,
        remaining: Math.max(0, limit - attempted),
        exhausted: attempted >= limit
      };
    }
  };
}

function resolveCallLimit(configuredMaximum, manualMaximum) {
  const parseLimit = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(ABSOLUTE_MAX_CALLS, Math.max(0, Math.floor(numeric)));
  };
  const configured = parseLimit(configuredMaximum, ABSOLUTE_MAX_CALLS);
  const manual = parseLimit(manualMaximum, configured);
  return Math.min(configured, manual);
}

function updateDateFirstExploreState(state, discoveryResult, forceRun = false) {
  return {
    dateFirstReturnCursor: forceRun
      ? Number(state?.dateFirstReturnCursor || 0)
      : Number(discoveryResult?.nextReturnCursor || 0),
    dateFirstOneWayCursor: forceRun
      ? Number(state?.dateFirstOneWayCursor || 0)
      : Number(discoveryResult?.nextOneWayCursor || 0),
    dateFirstLaneDates: discoveryResult?.laneDates || []
  };
}

function normalizePromotionText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function promotionFingerprint(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function extractPromotionSnippet(text, keywords) {
  const normalized = String(text || "");
  const lower = normalized.toLowerCase();
  const keyword = (keywords || []).find((item) => lower.includes(String(item).toLowerCase()));
  if (!keyword) return normalized.slice(0, 220);
  const position = lower.indexOf(String(keyword).toLowerCase());
  return normalized.slice(Math.max(0, position - 60), position + 220).trim();
}

async function checkPromotionSources(config, previousState = {}, fetchImpl = fetch) {
  if (!config?.enabled) return { checked: 0, changed: [], state: previousState, errors: [] };
  const nextState = { ...previousState };
  const changed = [];
  const errors = [];

  for (const source of config.sources || []) {
    try {
      const response = await fetchImpl(source.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 flight-deal-tracker/1.0"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = normalizePromotionText(await response.text());
      const keywords = source.keywords || config.keywords || [];
      const relevantText = keywords
        .map((keyword) => {
          const lower = text.toLowerCase();
          const position = lower.indexOf(String(keyword).toLowerCase());
          return position < 0
            ? ""
            : text.slice(Math.max(0, position - 80), position + 240);
        })
        .filter(Boolean)
        .join("|");
      const fingerprint = promotionFingerprint(relevantText || text.slice(0, 2000));
      const previous = previousState[source.id];
      const checkedAt = new Date().toISOString();
      if (!previous?.fingerprint || previous.fingerprint === fingerprint) {
        nextState[source.id] = {
          fingerprint,
          checkedAt,
          url: source.url,
          candidateFingerprint: null,
          candidateSeenCount: 0
        };
      } else {
        const candidateSeenCount = previous.candidateFingerprint === fingerprint
          ? Number(previous.candidateSeenCount || 0) + 1
          : 1;
        const confirmed = candidateSeenCount >= 2;
        nextState[source.id] = {
          fingerprint: confirmed ? fingerprint : previous.fingerprint,
          checkedAt,
          url: source.url,
          candidateFingerprint: confirmed ? null : fingerprint,
          candidateSeenCount: confirmed ? 0 : candidateSeenCount
        };
        if (confirmed) {
          changed.push({
            id: source.id,
            label: source.label,
            url: source.url,
            snippet: extractPromotionSnippet(text, source.keywords || config.keywords)
          });
        }
      }
    } catch (error) {
      errors.push(`${source.label}: ${error.message}`);
    }
  }

  return {
    checked: (config.sources || []).length,
    changed,
    state: nextState,
    errors
  };
}

module.exports = {
  ABSOLUTE_MAX_CALLS,
  buildDateFirstExploreLanes,
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  createCallBudget,
  exactSearchKey,
  extractPromotionSnippet,
  normalizePromotionText,
  promotionFingerprint,
  rankExploreCandidates,
  resolveCallLimit,
  scoreTravelerValue,
  selectExploreCandidates,
  summarizeCoverage,
  updateDateFirstExploreState,
  updateCoverage
};
