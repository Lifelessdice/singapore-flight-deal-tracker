const fs = require("node:fs");
const path = require("node:path");
const {
  analyzeFareHistory,
  getLeadTimeBucket,
  hasSameBaggageProfile
} = require("../fare-insights");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "automation", "routes.json");
const EXAMPLE_CONFIG_PATH = path.join(ROOT, "automation", "routes.example.json");
const HISTORY_PATH = path.join(ROOT, "data", "fare-history.json");
const STATE_PATH = path.join(ROOT, "data", "worker-state.json");
const SERPAPI_BASE_URL = "https://serpapi.com/search";

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name}. Add it as a local environment variable or GitHub Actions secret.`);
  }
}

function cartesian(...groups) {
  return groups.reduce((sets, group) => sets.flatMap((set) => group.map((item) => [...set, item])), [[]]);
}

function getGoogleFlightsUrl(search) {
  if (search.googleFlightsUrl) return search.googleFlightsUrl;
  const query = `${search.origin} to ${search.destination} ${search.departureDate}${search.returnDate ? ` return ${search.returnDate}` : ""}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function getTravelClassCode(travelClass) {
  const classes = {
    ECONOMY: "1",
    PREMIUM_ECONOMY: "2",
    PREMIUM: "2",
    BUSINESS: "3",
    FIRST: "4"
  };
  return classes[String(travelClass || "ECONOMY").toUpperCase()] || "1";
}

function getSkiplaggedUrl(search) {
  const url = new URL(`https://skiplagged.com/flights/${search.origin}/${search.destination}/${search.departureDate}`);
  if (search.returnDate) url.searchParams.set("return", search.returnDate);
  url.searchParams.set("trip", search.returnDate ? "roundtrip" : "oneway");
  return url.toString();
}

function getItaMatrixUrl() {
  return "https://matrix.itasoftware.com/search";
}

function buildSearches(route) {
  const origins = route.originLocationCodes || [route.originLocationCode || route.origin];
  const destinations = route.destinationLocationCodes || [route.destinationLocationCode || route.destination];
  const departureDates = route.departureDates || [route.departureDate];
  const returnDates = route.includeOneWay
    ? [...new Set([...(route.returnDates || [route.returnDate]).filter(Boolean), ""])]
    : route.returnDates || [route.returnDate || ""];

  // Date-first ordering distributes each small API batch across destinations.
  return cartesian(origins, departureDates, destinations, returnDates)
    .filter(([origin, departureDate, destination]) => origin && destination && departureDate)
    .filter(([origin, , destination]) => origin !== destination)
    .filter(([, departureDate]) => Date.parse(`${departureDate}T23:59:59Z`) > Date.now())
    .filter(([, departureDate, , returnDate]) => {
      if (!returnDate) return true;
      const depart = new Date(`${departureDate}T00:00:00Z`);
      const ret = new Date(`${returnDate}T00:00:00Z`);
      const tripDays = Math.round((ret - depart) / (24 * 60 * 60 * 1000));
      const maxTripDays = Number(route.maxTripDays) || 5;
      const minTripDays = Number(route.minTripDays) || 2;
      return tripDays >= minTripDays && tripDays <= maxTripDays;
    })
    .map(([origin, departureDate, destination, returnDate]) => ({
      routeId: route.id,
      label: route.label || `${origin}-${destination}`,
      origin,
      destination,
      departureDate,
      returnDate: returnDate || "",
      adults: route.adults || 1,
      currencyCode: route.currencyCode || "USD",
      travelClass: route.travelClass || "ECONOMY",
      maxPrice: returnDate
        ? Number(route.maxRoundTripPrice || route.maxPrice) || null
        : Number(route.maxOneWayPrice || route.maxPrice) || null,
      tripType: returnDate ? "round-trip" : "one-way",
      maxTotalDurationMinutes: Number(route.maxTotalDurationMinutes) || null,
      maxStops: Number.isFinite(Number(route.maxStops)) ? Number(route.maxStops) : null,
      nonStop: route.nonStop,
      passportNationality: route.passportNationality || "",
      passportCountryCode: route.passportCountryCode || "",
      carryOnBags: Math.max(0, Number(route.carryOnBags) || 0),
      checkedBags: Math.max(0, Number(route.checkedBags) || 0),
      baggageProfile: route.baggageProfile || "",
      maxResults: route.maxResultsPerSearch || 5
    }));
}

async function searchSerpApi(search) {
  assertEnv("SERPAPI_API_KEY");

  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);
  url.searchParams.set("departure_id", search.origin);
  url.searchParams.set("arrival_id", search.destination);
  url.searchParams.set("outbound_date", search.departureDate);
  url.searchParams.set("type", search.returnDate ? "1" : "2");
  if (search.returnDate) url.searchParams.set("return_date", search.returnDate);
  url.searchParams.set("adults", String(search.adults));
  url.searchParams.set("currency", search.currencyCode);
  url.searchParams.set("travel_class", getTravelClassCode(search.travelClass));
  url.searchParams.set("sort_by", "2");
  url.searchParams.set("gl", "sg");
  url.searchParams.set("hl", "en");
  url.searchParams.set("show_hidden", "true");
  if (search.carryOnBags) url.searchParams.set("bags", String(search.carryOnBags));
  if (search.maxStops === 0 || search.nonStop === true) url.searchParams.set("stops", "1");
  if (search.maxStops === 1) url.searchParams.set("stops", "2");
  if (search.maxStops === 2) url.searchParams.set("stops", "3");
  if (search.maxTotalDurationMinutes) url.searchParams.set("max_duration", String(search.maxTotalDurationMinutes));

  const response = await fetch(url);

  if (!response.ok) {
    return {
      ok: false,
      error: `SerpApi search failed for ${search.origin}-${search.destination}: ${response.status} ${await response.text()}`
    };
  }

  const data = await response.json();
  if (data.error) {
    return { ok: false, error: `SerpApi error for ${search.origin}-${search.destination}: ${data.error}` };
  }

  const rawFlights = [...(data.best_flights || []), ...(data.other_flights || [])];
  const offers = rawFlights.map((offer) => {
    const maxStops = (offer.layovers || []).length;
    const totalDurationMinutes = Number(offer.total_duration) || 0;
    const airlines = [...new Set((offer.flights || []).map((flight) => flight.airline).filter(Boolean))];

    return {
      source: "Google Flights via SerpApi",
      price: Number(offer.price),
      currency: search.currencyCode,
      itineraries: offer.type || search.tripType,
      totalDurationMinutes,
      maxStops,
      airlines,
      rawId: offer.departure_token || "",
      googlePriceInsights: data.price_insights || null
    };
  }).filter((offer) => Number.isFinite(offer.price))
    .filter((offer) => !search.maxTotalDurationMinutes || offer.totalDurationMinutes <= search.maxTotalDurationMinutes)
    .filter((offer) => search.maxStops === null || offer.maxStops <= search.maxStops);

  return { ok: true, offers };
}

async function searchGoogleTravelExplore(discovery, state, knownDestinations) {
  if (!discovery?.enabled) return { ok: true, searches: [], nextMonthCursor: 0 };
  assertEnv("SERPAPI_API_KEY");

  const months = discovery.months || [];
  const monthCursor = months.length ? Number(state.discoveryMonthCursor || 0) % months.length : 0;
  const month = months[monthCursor];
  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set("engine", "google_travel_explore");
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);
  url.searchParams.set("departure_id", discovery.origin || "SIN");
  url.searchParams.set("type", "1");
  if (month) url.searchParams.set("month", String(month));
  url.searchParams.set("travel_duration", "1");
  url.searchParams.set("adults", String(discovery.adults || 1));
  url.searchParams.set("currency", discovery.currencyCode || "USD");
  url.searchParams.set("travel_class", getTravelClassCode(discovery.travelClass));
  url.searchParams.set("gl", "sg");
  url.searchParams.set("hl", "en");
  url.searchParams.set("travel_mode", "1");
  url.searchParams.set("stops", String((Number(discovery.maxStops) || 0) + 1));
  if (discovery.maxDiscoveryPrice) {
    url.searchParams.set("max_price", String(discovery.maxDiscoveryPrice));
  }
  if (discovery.maxTotalDurationMinutes) {
    url.searchParams.set("max_duration", String(discovery.maxTotalDurationMinutes));
  }

  const response = await fetch(url);
  if (!response.ok) {
    return {
      ok: false,
      error: `Google Travel Explore search failed: ${response.status} ${await response.text()}`,
      searches: [],
      nextMonthCursor: monthCursor
    };
  }

  const data = await response.json();
  if (data.error) {
    return {
      ok: false,
      error: `Google Travel Explore error: ${data.error}`,
      searches: [],
      nextMonthCursor: monthCursor
    };
  }

  const candidates = (data.destinations || [])
    .map((destination) => {
      const airportCode = destination.destination_airport?.code;
      const depart = Date.parse(`${destination.start_date}T00:00:00Z`);
      const ret = Date.parse(`${destination.end_date}T00:00:00Z`);
      const tripDays = Math.round((ret - depart) / (24 * 60 * 60 * 1000));
      return { destination, airportCode, depart, tripDays };
    })
    .filter(({ airportCode, depart }) => airportCode && Number.isFinite(depart) && depart > Date.now())
    .filter(({ destination }) => Number.isFinite(Number(destination.flight_price)))
    .filter(({ tripDays }) => (
      tripDays >= Number(discovery.minTripDays || 2) &&
      tripDays <= Number(discovery.maxTripDays || 4)
    ))
    .filter(({ destination }) => (
      !discovery.maxTotalDurationMinutes ||
      Number(destination.flight_duration) <= Number(discovery.maxTotalDurationMinutes)
    ))
    .filter(({ destination }) => Number(destination.number_of_stops) <= Number(discovery.maxStops))
    .sort((a, b) => Number(a.destination.flight_price) - Number(b.destination.flight_price));

  const known = candidates.filter(({ airportCode }) => knownDestinations.has(airportCode));
  const newDestinations = candidates.filter(({ airportCode }) => !knownDestinations.has(airportCode));
  const verifyCount = Number(discovery.verifyCount || 3);
  const selected = [
    ...known.slice(0, Math.max(1, verifyCount - 1)),
    ...newDestinations.slice(0, 1)
  ].slice(0, verifyCount);

  const searches = selected.map(({ destination, airportCode }) => ({
    routeId: `explore-${discovery.origin || "SIN"}-${airportCode}`,
    label: `${destination.name || airportCode} flexible discovery`,
    origin: discovery.origin || "SIN",
    destination: airportCode,
    destinationName: destination.name || airportCode,
    departureDate: destination.start_date,
    returnDate: destination.end_date,
    adults: discovery.adults || 1,
    currencyCode: discovery.currencyCode || "USD",
    travelClass: discovery.travelClass || "ECONOMY",
    maxPrice: Number(discovery.targetRoundTripPrice) || null,
    tripType: "round-trip",
    maxTotalDurationMinutes: Number(discovery.maxTotalDurationMinutes) || null,
    maxStops: Number(discovery.maxStops),
    passportNationality: discovery.passportNationality || "",
    passportCountryCode: discovery.passportCountryCode || "",
    carryOnBags: Math.max(0, Number(discovery.carryOnBags) || 0),
    checkedBags: Math.max(0, Number(discovery.checkedBags) || 0),
    baggageProfile: discovery.baggageProfile || "",
    discoveryPrice: Number(destination.flight_price)
  }));

  return {
    ok: true,
    searches,
    exploredMonth: month,
    exploredCandidates: candidates.length,
    nextMonthCursor: months.length ? (monthCursor + 1) % months.length : 0
  };
}

function summarizeCandidate(search, offer, history) {
  const loggedAt = Date.now();
  const leadTimeBucket = getLeadTimeBucket(search.departureDate, loggedAt);
  const entry = {
    routeId: search.routeId,
    source: offer.source,
    price: offer.price,
    currency: offer.currency,
    origin: search.origin,
    destination: search.destination,
    departureDate: search.departureDate,
    returnDate: search.returnDate,
    tripType: search.tripType,
    loggedAt,
    leadTimeBucket,
    destinationName: search.destinationName || null,
    averagePrice: offer.averagePrice || null,
    discountPercentage: offer.discountPercentage || null,
    passportNationality: search.passportNationality || null,
    passportCountryCode: search.passportCountryCode || null,
    carryOnBags: search.carryOnBags || 0,
    checkedBags: search.checkedBags || 0,
    baggageProfile: search.baggageProfile || null,
    notes: `${offer.airlines.join(", ") || "carrier unknown"} via ${offer.source}, ${Math.round(offer.totalDurationMinutes / 60)}h total, ${offer.maxStops} stop${offer.maxStops === 1 ? "" : "s"}${search.carryOnBags ? `, price filtered for ${search.carryOnBags} carry-on bag` : ""}`,
    googlePriceInsights: offer.googlePriceInsights
  };
  const routeHistory = history.filter((item) => (
    item.origin === search.origin &&
    item.destination === search.destination &&
    (item.tripType || (item.returnDate ? "round-trip" : "one-way")) === search.tripType &&
    hasSameBaggageProfile(item, search)
  ));
  const sameLeadTimeHistory = routeHistory.filter((item) => (
    (item.leadTimeBucket || getLeadTimeBucket(item.departureDate, item.loggedAt)) === leadTimeBucket
  ));
  const comparisonHistory = sameLeadTimeHistory.length >= 3 ? sameLeadTimeHistory : routeHistory;
  const insights = analyzeFareHistory([...comparisonHistory, entry], search.maxPrice, {
    marketInsights: offer.googlePriceInsights
  });

  return {
    entry,
    insights: {
      ...insights,
      baselineScope: sameLeadTimeHistory.length >= 3 ? `lead time ${leadTimeBucket}` : "route and trip type"
    },
    links: {
      googleFlights: getGoogleFlightsUrl(search),
      itaMatrix: getItaMatrixUrl(search),
      skiplagged: getSkiplaggedUrl(search)
    }
  };
}

function shouldAlert(candidate) {
  return ["strong-deal", "good-deal"].includes(candidate.insights.level);
}

function alertKey(candidate) {
  const entry = candidate.entry;
  return [entry.origin, entry.destination, entry.tripType].join(":");
}

function isFreshAlert(candidate, alerts, cooldownHours) {
  const previous = alerts[alertKey(candidate)];
  if (!previous) return true;
  if (candidate.entry.price < Number(previous.price)) return true;
  return Date.now() - Number(previous.sentAt) >= cooldownHours * 60 * 60 * 1000;
}

function formatAlert(candidates) {
  const lines = ["Flight deal candidates found:", ""];

  candidates.forEach((candidate) => {
    const entry = candidate.entry;
    const insights = candidate.insights;
    const medianDelta = insights.latestVsMedianPct === null
      ? "median still building"
      : `${Math.abs(insights.latestVsMedianPct)}% ${insights.latestVsMedianPct <= 0 ? "below" : "above"} median`;
    const averageDelta = insights.latestVsAveragePct === null
      ? "average still building"
      : `${Math.abs(insights.latestVsAveragePct)}% ${insights.latestVsAveragePct <= 0 ? "below" : "above"} average`;
    const marketDelta = insights.latestVsMarketPct === null
      ? "Google typical range unavailable"
      : `${Math.abs(insights.latestVsMarketPct)}% ${insights.latestVsMarketPct <= 0 ? "below" : "above"} Google's typical midpoint`;

    lines.push(`${entry.origin} -> ${entry.destination} ${entry.departureDate}${entry.returnDate ? ` to ${entry.returnDate}` : ""}`);
    lines.push(`${entry.currency} ${entry.price} | ${entry.tripType} | ${insights.level} | confidence ${insights.confidence}`);
    lines.push(`Analysis: ${medianDelta}; ${averageDelta}; ${marketDelta}; baseline ${insights.baselineScope}; ${insights.baselineSampleCount} prior samples.`);
    if (entry.discountPercentage) {
      lines.push(`Google deal context: ${entry.discountPercentage}% below its average fare of ${entry.currency} ${entry.averagePrice}.`);
    }
    if (insights.dealSignals.length) {
      lines.push(`Deal signals: ${insights.dealSignals.join(", ")}.`);
    }
    if (insights.savingsVsMedian || insights.savingsVsAverage) {
      lines.push(`Estimated savings: ${entry.currency} ${insights.savingsVsMedian || 0} vs median; ${entry.currency} ${insights.savingsVsAverage || 0} vs average.`);
    }
    if (entry.passportNationality || entry.baggageProfile) {
      const travelerDetails = [
        entry.passportNationality ? `${entry.passportNationality} passport` : "",
        entry.baggageProfile || "",
        entry.checkedBags ? `${entry.checkedBags} checked bag${entry.checkedBags === 1 ? "" : "s"}` : "no checked bag"
      ].filter(Boolean).join("; ");
      lines.push(`Traveler fit: ${travelerDetails}. Verify current entry and transit rules before booking.`);
    }
    lines.push(`Trip details: ${entry.notes}.`);
    lines.push(`Google Flights: ${candidate.links.googleFlights}`);
    lines.push(`ITA Matrix: ${candidate.links.itaMatrix}`);
    lines.push(`Skiplagged: ${candidate.links.skiplagged}`);
    lines.push("");
  });

  return lines.join("\n");
}

async function sendDiscord(message) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;

  const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message.slice(0, 1900) })
  });

  if (!response.ok) {
    throw new Error(`Discord alert failed: ${response.status} ${await response.text()}`);
  }
}

async function sendResend(message) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL_TO || !process.env.ALERT_EMAIL_FROM) return;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM,
      to: [process.env.ALERT_EMAIL_TO],
      subject: "Flight deal candidates found",
      text: message
    })
  });

  if (!response.ok) {
    throw new Error(`Resend alert failed: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  const config = readJson(configPath, { routes: [] });
  const history = readJson(HISTORY_PATH, []);
  const state = readJson(STATE_PATH, { cursor: 0, alerts: {} });
  const checkIntervalHours = Number(config.checkIntervalHours || 48);
  const minimumElapsedMs = Math.max(1, checkIntervalHours - 1) * 60 * 60 * 1000;
  const lastCompletedAt = Date.parse(state.lastCompletedAt || "");
  const forceRun = String(process.env.FORCE_RUN || "").toLowerCase() === "true";

  if (!forceRun && Number.isFinite(lastCompletedAt) && Date.now() - lastCompletedAt < minimumElapsedMs) {
    console.log(`Skipping fare check: the previous run completed less than ${checkIntervalHours} hours ago.`);
    return;
  }

  const allSearches = config.routes.flatMap((route) => buildSearches({
    ...(config.traveler || {}),
    ...route
  }));
  const maxSearchesPerRun = Number(process.env.MAX_SEARCHES_PER_RUN || config.maxSearchesPerRun || 80);
  const discoveryEnabled = Boolean(config.discovery?.enabled)
    && String(process.env.DISCOVERY_ENABLED ?? "true").toLowerCase() !== "false";
  const normalizedCursor = allSearches.length ? Number(state.cursor || 0) % allSearches.length : 0;
  const searches = Array.from(
    { length: Math.min(maxSearchesPerRun, allSearches.length) },
    (_, offset) => allSearches[(normalizedCursor + offset) % allSearches.length]
  );
  const nextCursor = allSearches.length ? (normalizedCursor + searches.length) % allSearches.length : 0;

  if (!searches.length && !discoveryEnabled) {
    console.log("No searches configured.");
    return;
  }

  if (configPath === EXAMPLE_CONFIG_PATH) {
    console.log("Using automation/routes.example.json. Copy it to automation/routes.json and edit it for real alerts.");
  }

  const candidates = [];
  const newEntries = [];

  const knownDestinations = new Set(config.routes.flatMap((route) => (
    route.destinationLocationCodes || [route.destinationLocationCode || route.destination]
  )).filter(Boolean));
  const discoveryResult = await searchGoogleTravelExplore(
    {
      ...(config.traveler || {}),
      ...config.discovery,
      enabled: discoveryEnabled
    },
    state,
    knownDestinations
  );
  if (!discoveryResult.ok) {
    console.warn(discoveryResult.error);
  } else {
    for (const search of discoveryResult.searches) {
      const result = await searchSerpApi(search);
      if (!result.ok) {
        console.warn(result.error);
        continue;
      }
      const cheapest = result.offers.sort((a, b) => a.price - b.price)[0];
      if (!cheapest) continue;
      cheapest.source = "Google Travel Explore, verified via Google Flights";
      const candidate = summarizeCandidate(search, cheapest, history);
      candidates.push(candidate);
      newEntries.push(candidate.entry);
    }
  }

  for (const search of searches) {
    const result = await searchSerpApi(search);
    if (!result.ok) {
      console.warn(result.error);
      continue;
    }

    const cheapest = result.offers.sort((a, b) => a.price - b.price)[0];
    if (!cheapest) continue;

    const candidate = summarizeCandidate(search, cheapest, history);
    candidates.push(candidate);
    newEntries.push(candidate.entry);
  }

  const nextHistory = [...history, ...newEntries].slice(-2000);
  writeJson(HISTORY_PATH, nextHistory);
  const cooldownHours = Number(config.alertCooldownHours || 168);
  const alerts = state.alerts || {};
  const alertCandidates = candidates
    .filter(shouldAlert)
    .filter((candidate) => isFreshAlert(candidate, alerts, cooldownHours));

  if (alertCandidates.length) {
    const message = formatAlert(alertCandidates);
    console.log(message);
    const deliveries = await Promise.allSettled([
      sendDiscord(message),
      sendResend(message)
    ]);
    const deliveryFailures = deliveries
      .filter((delivery) => delivery.status === "rejected")
      .map((delivery) => delivery.reason?.message || String(delivery.reason));
    if (deliveryFailures.length) {
      throw new Error(`Alert delivery failed: ${deliveryFailures.join("; ")}`);
    }
    alertCandidates.forEach((candidate) => {
      alerts[alertKey(candidate)] = {
        price: candidate.entry.price,
        sentAt: Date.now()
      };
    });
  } else {
    const discoveryNote = discoveryResult.searches.length
      ? ", including flexible discovery"
      : "";
    console.log(`Checked ${candidates.length} live fare candidates${discoveryNote}. No new relative deals found.`);
  }

  writeJson(STATE_PATH, {
    cursor: nextCursor,
    totalSearches: allSearches.length,
    checkedThisRun: searches.length,
    discoveryMonthCursor: discoveryResult.nextMonthCursor,
    exploredMonth: discoveryResult.exploredMonth || null,
    exploredCandidates: discoveryResult.exploredCandidates || 0,
    flexibleDealsChecked: discoveryResult.ok ? discoveryResult.searches.length : 0,
    lastCompletedAt: new Date().toISOString(),
    alerts
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
