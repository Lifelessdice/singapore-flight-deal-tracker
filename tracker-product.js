const crypto = require("node:crypto");

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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

function buildConstructionLane(config, state, referenceSearch) {
  const groups = (config?.airportGroups || []).map((item) => ({
    ...item,
    type: "nearby-airports"
  }));
  const openJaws = (config?.openJaws || []).map((item) => ({
    ...item,
    type: "open-jaw"
  }));
  const definitions = [...groups, ...openJaws].filter((item) => item.enabled !== false);
  const cursor = definitions.length
    ? Number(state?.constructionCursor || 0) % definitions.length
    : 0;
  const definition = definitions[cursor];
  if (!config?.enabled || !definition || !referenceSearch?.returnDate) {
    return {
      definition: null,
      searches: [],
      nextCursor: cursor
    };
  }

  const common = {
    ...referenceSearch,
    routeId: `construction-${definition.id}`,
    label: definition.label,
    maxPrice: Number(config.targetRoundTripPrice || referenceSearch.maxPrice) || null
  };
  let searches;
  if (definition.type === "nearby-airports") {
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
    nextCursor: (cursor + 1) % definitions.length
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
      nextState[source.id] = {
        fingerprint,
        checkedAt: new Date().toISOString(),
        url: source.url
      };
      if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
        changed.push({
          id: source.id,
          label: source.label,
          url: source.url,
          snippet: extractPromotionSnippet(text, source.keywords || config.keywords)
        });
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
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  exactSearchKey,
  extractPromotionSnippet,
  normalizePromotionText,
  promotionFingerprint,
  scoreTravelerValue,
  summarizeCoverage,
  updateCoverage
};
