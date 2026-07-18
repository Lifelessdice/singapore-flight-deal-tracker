const fs = require("node:fs");
const path = require("node:path");
const {
  analyzeFareHistory,
  getLeadTimeBucket,
  hasSameBaggageProfile
} = require("../fare-insights");
const {
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  scoreTravelerValue,
  summarizeCoverage,
  updateCoverage
} = require("../tracker-product");
const {
  ManualTransitPolicyProvider,
  assessTransferRisk,
  isKnownNumber,
  normalizePassportCountry,
  qualifiesTransferSavings
} = require("../transit-policy");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "automation", "routes.json");
const EXAMPLE_CONFIG_PATH = path.join(ROOT, "automation", "routes.example.json");
const HISTORY_PATH = path.join(ROOT, "data", "fare-history.json");
const STATE_PATH = path.join(ROOT, "data", "worker-state.json");
const TRANSIT_POLICY_PATH = path.join(ROOT, "automation", "transit-policies.json");
const TRANSIT_POLICY_CACHE_PATH = path.join(ROOT, "data", "transit-policy-cache.json");
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

function formatTravelDate(date) {
  if (!date) return "";
  const weekday = new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC"
  }).format(new Date(`${date}T00:00:00Z`));
  return `${weekday} ${date}`;
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
      passportNationality: route.passportNationality || "Switzerland",
      passportCountryCode: normalizePassportCountry(route.passportCountryCode || "CHE"),
      carryOnBags: Math.max(0, Number(route.carryOnBags) || 0),
      checkedBags: Math.max(0, Number(route.checkedBags) || 0),
      baggageProfile: route.baggageProfile || "",
      transitAirportCountries: route.transitAirportCountries || {},
      maxResults: route.maxResultsPerSearch || 5
    }));
}

function searchMatchesHistory(search, item, exactDates = false) {
  if (
    item.origin !== search.origin ||
    item.destination !== search.destination ||
    (item.tripType || (item.returnDate ? "round-trip" : "one-way")) !== search.tripType ||
    !hasSameBaggageProfile(item, search)
  ) {
    return false;
  }
  return !exactDates || (
    item.departureDate === search.departureDate &&
    (item.returnDate || "") === (search.returnDate || "")
  );
}

function lastObservedAt(history, search, exactDates = false) {
  return (history || [])
    .filter((item) => searchMatchesHistory(search, item, exactDates))
    .reduce((latest, item) => Math.max(latest, Number(item.loggedAt) || 0), 0);
}

function selectSearches(allSearches, history, options = {}) {
  const now = Number(options.now || Date.now());
  const maxSearches = Math.max(0, Number(options.maxSearches) || 0);
  const horizonDays = Math.max(1, Number(options.horizonDays) || 90);
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  const future = allSearches.filter((search) => (
    Date.parse(`${search.departureDate}T23:59:59Z`) > now
  ));
  const withinHorizon = future.filter((search) => (
    Date.parse(`${search.departureDate}T00:00:00Z`) <= horizon
  ));
  const eligible = withinHorizon.length ? withinHorizon : future;
  const ranked = [...eligible].sort((a, b) => (
    lastObservedAt(history, a) - lastObservedAt(history, b) ||
    lastObservedAt(history, a, true) - lastObservedAt(history, b, true) ||
    Date.parse(a.departureDate) - Date.parse(b.departureDate) ||
    a.destination.localeCompare(b.destination)
  ));

  if (maxSearches < 4) return ranked.slice(0, maxSearches);

  const oneWayShare = Math.min(0.5, Math.max(0, Number(options.oneWayShare) || 0.25));
  const oneWayQuota = Math.max(1, Math.floor(maxSearches * oneWayShare));
  const roundTripQuota = maxSearches - oneWayQuota;
  const selected = [
    ...ranked.filter((search) => search.tripType === "round-trip").slice(0, roundTripQuota),
    ...ranked.filter((search) => search.tripType === "one-way").slice(0, oneWayQuota)
  ];
  const selectedKeys = new Set(selected.map((search) => [
    search.origin,
    search.destination,
    search.departureDate,
    search.returnDate,
    search.tripType
  ].join("|")));
  const remainder = ranked.filter((search) => !selectedKeys.has([
    search.origin,
    search.destination,
    search.departureDate,
    search.returnDate,
    search.tripType
  ].join("|")));
  return [...selected, ...remainder].slice(0, maxSearches);
}

function buildSplitTicketSearches(roundTripSearch) {
  if (!roundTripSearch?.returnDate) return [];
  return [
    {
      ...roundTripSearch,
      routeId: `${roundTripSearch.routeId}-split-outbound`,
      returnDate: "",
      tripType: "one-way",
      maxPrice: null
    },
    {
      ...roundTripSearch,
      routeId: `${roundTripSearch.routeId}-split-inbound`,
      origin: roundTripSearch.destination,
      destination: roundTripSearch.origin,
      departureDate: roundTripSearch.returnDate,
      returnDate: "",
      tripType: "one-way",
      maxPrice: null
    }
  ];
}

function mapSerpApiOffer(offer, search, priceInsights) {
  const flights = (offer.flights || []).map((flight) => ({
    airline: flight.airline || "",
    flightNumber: flight.flight_number || "",
    departureAirport: flight.departure_airport?.id || "",
    departureTerminal: flight.departure_airport?.terminal || null,
    departureTime: flight.departure_airport?.time || "",
    arrivalAirport: flight.arrival_airport?.id || "",
    arrivalTerminal: flight.arrival_airport?.terminal || null,
    arrivalTime: flight.arrival_airport?.time || "",
    durationMinutes: Number(flight.duration) || 0,
    overnight: Boolean(flight.overnight),
    oftenDelayed: Boolean(flight.often_delayed_by_over_30_min)
  }));
  const layovers = (offer.layovers || []).map((layover) => ({
    airport: layover.id || "",
    durationMinutes: Number(layover.duration) || 0,
    overnight: Boolean(layover.overnight)
  }));
  const extensions = [
    ...(offer.extensions || []),
    ...(offer.flights || []).flatMap((flight) => flight.extensions || [])
  ].map(String);
  const hasAirportChange = flights.some((flight, index) => (
    index > 0 && flights[index - 1].arrivalAirport !== flight.departureAirport
  ));
  const hasSelfTransfer = Boolean(
    offer.separate_tickets ||
    offer.booking_options?.some((option) => option.separate_tickets) ||
    extensions.some((extension) => (
      /separate tickets|self[- ]transfer/i.test(extension)
    ))
  );
  const connections = flights.slice(0, -1).map((flight, index) => {
    const onward = flights[index + 1];
    const airportChange = flight.arrivalAirport !== onward.departureAirport;
    const terminalChange = airportChange
      ? true
      : flight.arrivalTerminal && onward.departureTerminal
        ? flight.arrivalTerminal !== onward.departureTerminal
        : null;
    return {
      airport: flight.arrivalAirport,
      arrivalAirport: flight.arrivalAirport,
      departureAirport: onward.departureAirport,
      transitCountry: search.transitAirportCountries?.[flight.arrivalAirport] || null,
      durationMinutes: Number(layovers[index]?.durationMinutes) || null,
      airportChange,
      terminalChange,
      immigrationLikely: hasSelfTransfer || airportChange ? true : null,
      baggageRecheckLikely: hasSelfTransfer && Number(search.checkedBags || 0) > 0,
      onwardIsLastPracticalDeparture: null,
      overnight: Boolean(layovers[index]?.overnight)
    };
  });
  const itineraryProtection = hasSelfTransfer || hasAirportChange
    ? "self-transfer"
    : "protected";

  return {
    source: "Google Flights via SerpApi",
    price: Number(offer.price),
    currency: search.currencyCode,
    itineraries: offer.type || search.tripType,
    totalDurationMinutes: Number(offer.total_duration) || 0,
    maxStops: layovers.length,
    airlines: [...new Set(flights.map((flight) => flight.airline).filter(Boolean))],
    resolvedOrigin: flights[0]?.departureAirport || search.origin,
    resolvedDestination: flights.at(-1)?.arrivalAirport || search.destination,
    flights,
    layovers,
    maxLayoverMinutes: layovers.reduce(
      (longest, layover) => Math.max(longest, layover.durationMinutes),
      0
    ),
    hasAirportChange,
    hasSelfTransfer,
    itineraryProtection,
    transferAssessment: itineraryProtection === "protected"
      ? {
          status: "protected",
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
        }
      : {
          status: "self-transfer-manual-review",
          reasons: ["Transit policy has not yet been assessed."],
          warnings: [],
          transitCountries: [...new Set(connections.map((item) => item.transitCountry).filter(Boolean))],
          transitAirports: [...new Set(connections.map((item) => item.airport).filter(Boolean))],
          visaRequired: null,
          paidVisaRequired: null,
          authorizationRequired: null,
          authorizationName: null,
          authorizationCost: null,
          immigrationLikely: true,
          baggageRecheckLikely: Number(search.checkedBags || 0) > 0,
          airportChange: hasAirportChange,
          terminalChange: connections.length
            ? connections.some((item) => item.terminalChange === true) || null
            : null,
          minimumRecommendedConnectionMinutes: null,
          shortestConnectionMinutes: null,
          extraEstimatedCost: null,
          policySource: null,
          policyLastVerifiedAt: null
        },
    connections,
    hasOvernight: flights.some((flight) => flight.overnight) ||
      layovers.some((layover) => layover.overnight),
    baggageNotes: extensions.filter((extension) => /bag|carry-on|personal item/i.test(extension)),
    rawId: offer.departure_token || "",
    bookingToken: offer.booking_token || "",
    googlePriceInsights: priceInsights || null
  };
}

async function searchSerpApi(search, options = {}) {
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
  url.searchParams.set("deep_search", "true");
  if (options.departureToken) {
    url.searchParams.set("departure_token", options.departureToken);
  }
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
  const offers = rawFlights
    .map((offer) => mapSerpApiOffer(offer, search, data.price_insights))
    .filter((offer) => Number.isFinite(offer.price))
    .filter((offer) => !search.maxTotalDurationMinutes || offer.totalDurationMinutes <= search.maxTotalDurationMinutes)
    .filter((offer) => search.maxStops === null || offer.maxStops <= search.maxStops);

  return { ok: true, offers };
}

async function verifyRoundTripOffer(search, outboundOffer, searchFunction = searchSerpApi) {
  if (!search.returnDate || !outboundOffer.rawId) {
    return { ok: false, error: "Round-trip return verification token was unavailable." };
  }
  const result = await searchFunction(search, { departureToken: outboundOffer.rawId });
  if (!result.ok) return result;
  const sortedReturns = [...result.offers].sort((a, b) => a.price - b.price);
  const returnOffer = outboundOffer.itineraryProtection === "protected"
    ? sortedReturns.find((offer) => offer.itineraryProtection === "protected") || sortedReturns[0]
    : sortedReturns[0];
  if (!returnOffer) {
    return { ok: false, error: "No compatible return passed the duration and stop limits." };
  }
  return {
    ok: true,
    offer: combineRoundTripOffers(outboundOffer, returnOffer)
  };
}

function combineRoundTripOffers(outboundOffer, returnOffer) {
  return {
    ...outboundOffer,
    price: returnOffer.price,
    totalDurationMinutes: outboundOffer.totalDurationMinutes + returnOffer.totalDurationMinutes,
    maxStops: Math.max(outboundOffer.maxStops, returnOffer.maxStops),
    airlines: [...new Set([...outboundOffer.airlines, ...returnOffer.airlines])],
    returnDurationMinutes: returnOffer.totalDurationMinutes,
    outboundDurationMinutes: outboundOffer.totalDurationMinutes,
    returnFlights: returnOffer.flights,
    returnLayovers: returnOffer.layovers,
    maxLayoverMinutes: Math.max(
      outboundOffer.maxLayoverMinutes || 0,
      returnOffer.maxLayoverMinutes || 0
    ),
    hasOvernight: outboundOffer.hasOvernight || returnOffer.hasOvernight,
    hasSelfTransfer: outboundOffer.hasSelfTransfer || returnOffer.hasSelfTransfer,
    hasAirportChange: outboundOffer.hasAirportChange || returnOffer.hasAirportChange,
    itineraryProtection: (
      outboundOffer.hasSelfTransfer ||
      returnOffer.hasSelfTransfer ||
      outboundOffer.hasAirportChange ||
      returnOffer.hasAirportChange
    )
      ? "self-transfer"
      : "protected",
    connections: [
      ...(outboundOffer.connections || []),
      ...(returnOffer.connections || [])
    ],
    transferAssessment: (
      outboundOffer.hasSelfTransfer ||
      returnOffer.hasSelfTransfer ||
      outboundOffer.hasAirportChange ||
      returnOffer.hasAirportChange
    )
      ? {
          status: "self-transfer-manual-review",
          reasons: ["Transit policy has not yet been assessed."],
          warnings: [],
          transitCountries: [...new Set([
            ...(outboundOffer.connections || []).map((item) => item.transitCountry),
            ...(returnOffer.connections || []).map((item) => item.transitCountry)
          ].filter(Boolean))],
          transitAirports: [...new Set([
            ...(outboundOffer.connections || []).map((item) => item.airport),
            ...(returnOffer.connections || []).map((item) => item.airport)
          ].filter(Boolean))],
          visaRequired: null,
          paidVisaRequired: null,
          authorizationRequired: null,
          authorizationName: null,
          authorizationCost: null,
          immigrationLikely: true,
          baggageRecheckLikely: null,
          airportChange: outboundOffer.hasAirportChange || returnOffer.hasAirportChange,
          terminalChange: null,
          minimumRecommendedConnectionMinutes: null,
          shortestConnectionMinutes: null,
          extraEstimatedCost: null,
          policySource: null,
          policyLastVerifiedAt: null
        }
      : outboundOffer.transferAssessment,
    baggageNotes: [...new Set([
      ...(outboundOffer.baggageNotes || []),
      ...(returnOffer.baggageNotes || [])
    ])],
    bookingToken: returnOffer.bookingToken,
    verifiedRoundTrip: true
  };
}

function candidateStrategy(search, offer) {
  if (offer.hasAirportChange) return "airport-change";
  if (offer.hasSelfTransfer) return "self-transfer";
  return (search.searchStrategy || "standard") === "standard"
    ? "protected"
    : search.searchStrategy;
}

function normalizedHistoryStrategy(item) {
  return (item?.searchStrategy || "standard") === "standard"
    ? "protected"
    : item.searchStrategy;
}

function selectCandidateOffers(offers, transferConfig = {}) {
  const sorted = [...(offers || [])].sort((left, right) => left.price - right.price);
  const protectedOffer = sorted.find((offer) => offer.itineraryProtection === "protected");
  const transferOffers = [
    sorted.find((offer) => offer.hasSelfTransfer && !offer.hasAirportChange),
    sorted.find((offer) => offer.hasAirportChange)
  ].filter(Boolean);
  const selected = [];
  if (protectedOffer) selected.push(protectedOffer);
  for (const transferOffer of transferOffers) {
    if (protectedOffer && transferOffer.price >= protectedOffer.price) continue;
    const savings = qualifiesTransferSavings(
      transferOffer.price,
      protectedOffer?.price,
      transferConfig
    );
    selected.push({
      ...transferOffer,
      protectedComparablePrice: protectedOffer?.price ?? null,
      transferSavings: savings.amount,
      transferSavingsPercent: savings.percent,
      transferSavingsQualifies: savings.qualifies
    });
  }
  return selected.length ? selected : sorted.slice(0, 1);
}

async function getSerpApiAccount() {
  assertEnv("SERPAPI_API_KEY");
  try {
    const url = new URL("https://serpapi.com/account.json");
    url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ok: false,
        error: `SerpApi account lookup failed: ${response.status} ${await response.text()}`
      };
    }
    const account = await response.json();
    if (account.error) {
      return { ok: false, error: `SerpApi account error: ${account.error}` };
    }
    return { ok: true, account };
  } catch (error) {
    return { ok: false, error: `SerpApi account lookup failed: ${error.message}` };
  }
}

async function searchGoogleTravelExplore(discovery, state, knownDestinations) {
  if (!discovery?.enabled) {
    return {
      ok: true,
      searches: [],
      nextMonthCursor: Number(state.discoveryMonthCursor || 0)
    };
  }
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
    passportNationality: discovery.passportNationality || "Switzerland",
    passportCountryCode: normalizePassportCountry(
      discovery.passportCountryCode || "CHE"
    ),
    carryOnBags: Math.max(0, Number(discovery.carryOnBags) || 0),
    checkedBags: Math.max(0, Number(discovery.checkedBags) || 0),
    baggageProfile: discovery.baggageProfile || "",
    transitAirportCountries: discovery.transitAirportCountries || {},
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
  const tripLengthDays = search.returnDate
    ? Math.round((
      Date.parse(`${search.returnDate}T00:00:00Z`) -
      Date.parse(`${search.departureDate}T00:00:00Z`)
    ) / (24 * 60 * 60 * 1000))
    : null;
  const departureDay = new Date(`${search.departureDate}T00:00:00Z`).getUTCDay();
  const weekendDeparture = departureDay === 5 || departureDay === 6;
  const durationDescription = offer.verifiedRoundTrip
    ? `${Math.round(offer.outboundDurationMinutes / 60)}h outbound and ${Math.round(offer.returnDurationMinutes / 60)}h return`
    : search.returnDate
      ? `${Math.round(offer.totalDurationMinutes / 60)}h outbound; return verified only before an alert`
      : `${Math.round(offer.totalDurationMinutes / 60)}h`;
  const baggageDescription = offer.baggageNotes?.length
    ? `fare notes: ${offer.baggageNotes.join("; ")}`
    : "personal-item allowance not confirmed by the flight feed";
  const historyStrategy = candidateStrategy(search, offer);
  const entry = {
    routeId: search.routeId,
    source: offer.source,
    price: offer.price,
    currency: offer.currency,
    origin: offer.resolvedOrigin || search.origin,
    destination: offer.resolvedDestination || search.destination,
    searchedOrigin: search.origin,
    searchedDestination: search.destination,
    departureDate: search.departureDate,
    returnDate: search.returnDate,
    tripType: search.tripType,
    searchStrategy: historyStrategy,
    loggedAt,
    leadTimeBucket,
    tripLengthDays,
    weekendDeparture,
    destinationName: search.destinationName || null,
    averagePrice: offer.averagePrice || null,
    discountPercentage: offer.discountPercentage || null,
    passportNationality: search.passportNationality || null,
    passportCountryCode: search.passportCountryCode || null,
    carryOnBags: search.carryOnBags || 0,
    checkedBags: search.checkedBags || 0,
    baggageProfile: search.baggageProfile || null,
    maxStops: offer.maxStops,
    returnVerified: Boolean(offer.verifiedRoundTrip),
    itineraryProtection: offer.itineraryProtection || "protected",
    transferAssessment: offer.transferAssessment || null,
    baseFare: Number(offer.baseFare ?? offer.price),
    extraEstimatedCost: offer.transferAssessment
      ? offer.transferAssessment.extraEstimatedCost
      : 0,
    protectedComparablePrice: offer.protectedComparablePrice ?? null,
    transferSavings: offer.transferSavings ?? null,
    transferSavingsPercent: offer.transferSavingsPercent ?? null,
    transferSavingsQualifies: offer.transferSavingsQualifies ?? null,
    notes: `${offer.airlines.join(", ") || "carrier unknown"} via ${offer.source}, ${durationDescription}, maximum ${offer.maxStops} stop${offer.maxStops === 1 ? "" : "s"} per direction, ${baggageDescription}`,
    googlePriceInsights: offer.googlePriceInsights
  };
  const routeHistory = history.filter((item) => {
    const sameRoute = search.searchStrategy
      ? item.routeId === search.routeId
      : item.origin === search.origin && item.destination === search.destination;
    return (
      sameRoute &&
      (item.tripType || (item.returnDate ? "round-trip" : "one-way")) === search.tripType &&
      hasSameBaggageProfile(item, search) &&
      normalizedHistoryStrategy(item) === historyStrategy
    );
  });
  const comparisonHistory = routeHistory.filter((item) => {
    const itemDepartureDay = new Date(`${item.departureDate}T00:00:00Z`).getUTCDay();
    const itemWeekendDeparture = item.weekendDeparture ??
      (itemDepartureDay === 5 || itemDepartureDay === 6);
    const itemMonth = String(item.departureDate || "").slice(0, 7);
    const itemTripLengthDays = item.returnDate
      ? Math.round((
        Date.parse(`${item.returnDate}T00:00:00Z`) -
        Date.parse(`${item.departureDate}T00:00:00Z`)
      ) / (24 * 60 * 60 * 1000))
      : null;
    const sameTripLength = tripLengthDays === null
      ? !item.returnDate
      : Math.abs(Number(item.tripLengthDays ?? itemTripLengthDays) - tripLengthDays) <= 1;
    return (
      (item.leadTimeBucket || getLeadTimeBucket(item.departureDate, item.loggedAt)) === leadTimeBucket &&
      itemMonth === search.departureDate.slice(0, 7) &&
      itemWeekendDeparture === weekendDeparture &&
      sameTripLength
    );
  });
  const insights = analyzeFareHistory([...comparisonHistory, entry], search.maxPrice, {
    marketInsights: offer.googlePriceInsights
  });

  const candidate = {
    entry,
    insights: {
      ...insights,
      baselineScope: `matching ${leadTimeBucket} lead time, month, trip length, and weekend pattern`
    },
    search,
    offer,
    links: {
      googleFlights: getGoogleFlightsUrl(search),
      itaMatrix: getItaMatrixUrl(search),
      skiplagged: getSkiplaggedUrl(search)
    }
  };
  candidate.value = scoreTravelerValue(candidate);
  return candidate;
}

function summarizeSearchOffers(search, offers, history, transferConfig, source) {
  return selectCandidateOffers(offers, transferConfig).map((offer) => summarizeCandidate(
    search,
    {
      ...offer,
      source: source || offer.source
    },
    history
  ));
}

function summarizeSplitTicketCandidate(
  roundTripSearch,
  outboundOffer,
  inboundOffer,
  roundTripCandidate,
  history,
  splitConfig = {}
) {
  const combinedPrice = outboundOffer.price + inboundOffer.price;
  if (combinedPrice >= roundTripCandidate.entry.price) return null;

  const savings = roundTripCandidate.entry.price - combinedPrice;
  const savingsPercent = Math.round((savings / roundTripCandidate.entry.price) * 100);
  const airlines = [...new Set([
    ...outboundOffer.airlines,
    ...inboundOffer.airlines
  ])];
  const splitOffer = {
    source: "Two separately priced one-way tickets via Google Flights",
    price: combinedPrice,
    currency: roundTripSearch.currencyCode,
    totalDurationMinutes: outboundOffer.totalDurationMinutes + inboundOffer.totalDurationMinutes,
    maxStops: Math.max(outboundOffer.maxStops, inboundOffer.maxStops),
    airlines,
    googlePriceInsights: null
  };
  const candidate = summarizeCandidate(
    {
      ...roundTripSearch,
      routeId: `split-${roundTripSearch.origin}-${roundTripSearch.destination}`,
      searchStrategy: "split-one-ways"
    },
    splitOffer,
    history
  );
  const [outboundSearch, inboundSearch] = buildSplitTicketSearches(roundTripSearch);
  candidate.entry.searchStrategy = "split-one-ways";
  candidate.entry.roundTripComparisonPrice = roundTripCandidate.entry.price;
  candidate.entry.strategySavings = savings;
  candidate.entry.strategySavingsPercent = savingsPercent;
  candidate.entry.strategyMinimumSavingsUsd = Number(splitConfig.minimumSavingsUsd || 15);
  candidate.entry.strategyMinimumSavingsPercent = Number(splitConfig.minimumSavingsPercent || 10);
  candidate.entry.notes = `${outboundOffer.airlines.join(", ") || "unknown carrier"} outbound plus ${inboundOffer.airlines.join(", ") || "unknown carrier"} return on separate one-way tickets, ${Math.round(outboundOffer.totalDurationMinutes / 60)}h outbound and ${Math.round(inboundOffer.totalDurationMinutes / 60)}h return, maximum ${splitOffer.maxStops} stop${splitOffer.maxStops === 1 ? "" : "s"} per direction`;
  candidate.links.outboundGoogleFlights = getGoogleFlightsUrl(outboundSearch);
  candidate.links.inboundGoogleFlights = getGoogleFlightsUrl(inboundSearch);

  const minimumSavingsUsd = candidate.entry.strategyMinimumSavingsUsd;
  const minimumSavingsPercent = candidate.entry.strategyMinimumSavingsPercent;
  const strongSavingsUsd = Number(splitConfig.strongSavingsUsd || 30);
  const strongSavingsPercent = Number(splitConfig.strongSavingsPercent || 20);
  const qualifies = savings >= minimumSavingsUsd && savingsPercent >= minimumSavingsPercent;
  const strong = savings >= strongSavingsUsd && savingsPercent >= strongSavingsPercent;
  const roundTripInsights = roundTripCandidate.insights || {};
  if (qualifies) {
    candidate.insights.level = strong ? "strong-deal" : "good-deal";
    candidate.insights.confidence = roundTripInsights.marketBaselineAvailable
      ? "medium"
      : "low";
    candidate.insights.confidenceBasis = roundTripInsights.marketBaselineAvailable
      ? `live separate-ticket comparison plus ${roundTripInsights.confidenceBasis}`
      : "one live separate-ticket comparison; no external statistical baseline returned";
    candidate.insights.marketBaselineAvailable =
      Boolean(roundTripInsights.marketBaselineAvailable);
    candidate.insights.dealSignals = [
      ...new Set([...candidate.insights.dealSignals, "separate-one-way-pricing"])
    ];
  }
  candidate.insights.strategyQualifies = qualifies;
  candidate.insights.strategySavings = savings;
  candidate.insights.strategySavingsPercent = savingsPercent;
  candidate.value = scoreTravelerValue(candidate);
  return candidate;
}

function summarizeOpenJawCandidate(
  referenceSearch,
  definition,
  outboundOffer,
  inboundOffer,
  history
) {
  const combinedOffer = {
    source: "Open-jaw one-way combination via Google Flights",
    price: outboundOffer.price + inboundOffer.price,
    currency: referenceSearch.currencyCode,
    totalDurationMinutes: outboundOffer.totalDurationMinutes + inboundOffer.totalDurationMinutes,
    outboundDurationMinutes: outboundOffer.totalDurationMinutes,
    returnDurationMinutes: inboundOffer.totalDurationMinutes,
    maxStops: Math.max(outboundOffer.maxStops, inboundOffer.maxStops),
    airlines: [...new Set([...outboundOffer.airlines, ...inboundOffer.airlines])],
    baggageNotes: [...new Set([
      ...(outboundOffer.baggageNotes || []),
      ...(inboundOffer.baggageNotes || [])
    ])],
    hasOvernight: outboundOffer.hasOvernight || inboundOffer.hasOvernight,
    hasSelfTransfer: false,
    hasAirportChange: false,
    verifiedRoundTrip: true,
    resolvedOrigin: referenceSearch.origin,
    resolvedDestination: `${definition.outboundDestination}/${definition.inboundOrigin}`,
    googlePriceInsights: null
  };
  const pseudoSearch = {
    ...referenceSearch,
    routeId: `construction-${definition.id}`,
    destination: `${definition.outboundDestination}/${definition.inboundOrigin}`,
    destinationName: definition.label,
    searchStrategy: "open-jaw",
    maxPrice: Number(definition.targetRoundTripPrice || referenceSearch.maxPrice) || null
  };
  const candidate = summarizeCandidate(pseudoSearch, combinedOffer, history);
  candidate.entry.searchStrategy = "open-jaw";
  candidate.entry.outboundDestination = definition.outboundDestination;
  candidate.entry.inboundOrigin = definition.inboundOrigin;
  candidate.entry.notes = `${outboundOffer.airlines.join(", ") || "unknown carrier"} from ${referenceSearch.origin} to ${definition.outboundDestination}, then ${inboundOffer.airlines.join(", ") || "unknown carrier"} from ${definition.inboundOrigin} to ${referenceSearch.origin}; ${Math.round(outboundOffer.totalDurationMinutes / 60)}h outbound and ${Math.round(inboundOffer.totalDurationMinutes / 60)}h return-side flight. Ground transport between ${definition.outboundDestination} and ${definition.inboundOrigin} is not included`;
  candidate.links.outboundGoogleFlights = getGoogleFlightsUrl({
    ...referenceSearch,
    destination: definition.outboundDestination,
    returnDate: ""
  });
  candidate.links.inboundGoogleFlights = getGoogleFlightsUrl({
    ...referenceSearch,
    origin: definition.inboundOrigin,
    destination: referenceSearch.origin,
    departureDate: referenceSearch.returnDate,
    returnDate: ""
  });
  candidate.value = scoreTravelerValue(candidate);
  return candidate;
}

function isFareDeal(candidate) {
  return ["strong-deal", "good-deal"].includes(candidate.insights.level);
}

function shouldAlert(candidate) {
  if (!isFareDeal(candidate)) return false;
  if ((candidate.entry.itineraryProtection || "protected") === "protected") return true;
  return candidate.entry.transferSavingsQualifies === true &&
    candidate.entry.transferAssessment?.status === "self-transfer-acceptable";
}

function alertKey(candidate) {
  const entry = candidate.entry;
  return [
    entry.origin,
    entry.destination,
    entry.tripType,
    entry.departureDate,
    entry.returnDate || "",
    entry.searchStrategy || "standard"
  ].join(":");
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

    lines.push(`${entry.origin} -> ${entry.destination} ${formatTravelDate(entry.departureDate)}${entry.returnDate ? ` to ${formatTravelDate(entry.returnDate)}` : ""}`);
    lines.push(`${entry.currency} ${entry.price} | ${entry.tripType} | ${insights.level} | confidence ${insights.confidence}`);
    if (candidate.value) {
      lines.push(`Decision: ${candidate.value.action} | traveler value ${candidate.value.score}/100.`);
      if (candidate.value.reasons.length) {
        lines.push(`Why it stands out: ${candidate.value.reasons.join("; ")}.`);
      }
      if (candidate.value.risks.length) {
        lines.push(`Tradeoffs: ${candidate.value.risks.join("; ")}.`);
      }
    }
    lines.push(`Confidence basis: ${insights.confidenceBasis || "external market evidence unavailable"}.`);
    lines.push(`Analysis: ${medianDelta}; ${averageDelta}; ${marketDelta}; baseline ${insights.baselineScope}; ${insights.baselineSampleCount} independent prior days.`);
    if (insights.marketPriceHistorySampleCount) {
      lines.push(
        `Online market history: ${insights.marketPriceHistorySampleCount} Google price points; current fare is ${Math.abs(insights.latestVsMarketHistoryPct)}% ${insights.latestVsMarketHistoryPct <= 0 ? "below" : "above"} their median of ${entry.currency} ${insights.marketHistoryMedian}.`
      );
    }
    if (entry.discountPercentage) {
      lines.push(`Google deal context: ${entry.discountPercentage}% below its average fare of ${entry.currency} ${entry.averagePrice}.`);
    }
    if (insights.dealSignals.length) {
      lines.push(`Deal signals: ${insights.dealSignals.join(", ")}.`);
    }
    if (insights.savingsVsMedian || insights.savingsVsAverage) {
      lines.push(`Estimated savings: ${entry.currency} ${insights.savingsVsMedian || 0} vs median; ${entry.currency} ${insights.savingsVsAverage || 0} vs average.`);
    }
    if (entry.searchStrategy === "split-one-ways") {
      lines.push(
        `Split-ticket advantage: ${entry.currency} ${entry.strategySavings} (${entry.strategySavingsPercent}%) below the same-run round-trip fare of ${entry.currency} ${entry.roundTripComparisonPrice}. These are independent outbound and return bookings.`
      );
    }
    const transfer = entry.transferAssessment;
    if (transfer?.status === "self-transfer-acceptable") {
      lines.push(
        `Transfer status: ACCEPTABLE SELF-TRANSFER | saves ${entry.currency} ${entry.transferSavings} (${entry.transferSavingsPercent}%) versus the comparable protected fare.`
      );
      lines.push(
        `Connection evidence: ${transfer.shortestConnectionMinutes} minutes minimum observed; ${transfer.minimumRecommendedConnectionMinutes} recommended; transit ${transfer.transitAirports.join(", ") || "airport unknown"}; immigration ${transfer.immigrationLikely ? "likely" : "not expected"}; baggage recheck ${transfer.baggageRecheckLikely ? "likely" : "not expected"}.`
      );
      if (transfer.authorizationRequired) {
        lines.push(
          `Required authorization: ${transfer.authorizationName}; cost ${entry.currency} ${transfer.authorizationCost}.`
        );
      }
      if (transfer.warnings.length) {
        lines.push(`Self-transfer warnings: ${transfer.warnings.join(" ")}`);
      }
      lines.push(
        `Policy evidence: ${transfer.policySource || "manual policy"}; verified ${transfer.policyLastVerifiedAt || "date unavailable"}. Recheck before purchase.`
      );
    } else if (transfer?.status === "protected") {
      lines.push("Transfer status: protected itinerary.");
    }
    if (
      entry.tripType === "round-trip" &&
      !["split-one-ways", "open-jaw"].includes(entry.searchStrategy)
    ) {
      lines.push(
        entry.returnVerified
          ? "Itinerary check: both outbound and return passed the configured duration and stop checks; transfer risk was assessed separately."
          : "Itinerary check: return could not be verified; this candidate should not have been alerted."
      );
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
    if (candidate.links.outboundGoogleFlights) {
      lines.push(`Outbound one-way: ${candidate.links.outboundGoogleFlights}`);
      lines.push(`Return one-way: ${candidate.links.inboundGoogleFlights}`);
    }
    lines.push(`ITA Matrix: ${candidate.links.itaMatrix}`);
    lines.push(`Skiplagged: ${candidate.links.skiplagged}`);
    lines.push("");
  });

  return lines.join("\n");
}

function explainNoDeal(insights, entry = {}) {
  if (entry.transferAssessment?.status === "self-transfer-manual-review") {
    return `self-transfer needs manual review: ${entry.transferAssessment.reasons.join(" ")}`;
  }
  if (entry.transferAssessment?.status === "self-transfer-rejected") {
    return `self-transfer rejected: ${entry.transferAssessment.reasons.join(" ")}`;
  }
  if (
    entry.itineraryProtection === "self-transfer" &&
    entry.transferSavingsQualifies === false
  ) {
    return `self-transfer savings do not meet both configured risk premiums`;
  }
  if (entry.verificationError) {
    return `the price signal qualified, but the return itinerary was not safe to alert: ${entry.verificationError}`;
  }
  if (entry.searchStrategy === "split-one-ways" && !insights.strategyQualifies) {
    return `separate one-ways save ${entry.currency} ${entry.strategySavings} (${entry.strategySavingsPercent}%); this needs both ${entry.currency} ${entry.strategyMinimumSavingsUsd} and ${entry.strategyMinimumSavingsPercent}% savings to qualify`;
  }
  if (insights.baselineSampleCount < 3 && !insights.marketBaselineAvailable) {
    const remaining = 3 - insights.baselineSampleCount;
    return `baseline building; needs ${remaining} more comparable sample${remaining === 1 ? "" : "s"} unless Google supplies a typical-price range`;
  }
  if (insights.level === "wait") {
    return insights.marketPriceLevel === "high"
      ? "Google currently rates this fare as high"
      : "fare is at least 10% above its comparable history";
  }
  if (insights.latestVsMedianPct !== null && insights.latestVsMedianPct > -10) {
    const direction = insights.latestVsMedianPct < 0 ? "below" : "above";
    return `only ${Math.abs(insights.latestVsMedianPct)}% ${direction} the prior median; a good deal needs at least 10% below plus statistical evidence`;
  }
  if (
    insights.latestVsMedianPct !== null &&
    insights.latestVsMedianPct <= -10 &&
    insights.robustZScore !== null &&
    insights.robustZScore > -1
  ) {
    return "price drop falls within normal route volatility";
  }
  if (insights.targetHit) {
    return "inside the budget target, but not yet supported by relative-deal evidence";
  }
  return "no qualifying independent local-history or Google online market signal";
}

function formatHistoryAnalysis(entry, insights) {
  const parts = [
    `${insights.confidence} confidence`,
    insights.confidenceBasis || "no external statistical baseline returned"
  ];
  if (entry.searchStrategy === "split-one-ways") {
    parts.push(
      `${entry.currency} ${entry.strategySavings} (${entry.strategySavingsPercent}%) below same-run round trip`
    );
  }
  if (insights.baselineSampleCount >= 3) {
    parts.push(
      `${Math.abs(insights.latestVsMedianPct)}% ${insights.latestVsMedianPct <= 0 ? "below" : "above"} prior median ${entry.currency} ${insights.medianPrice}`
    );
    parts.push(
      `${Math.abs(insights.latestVsAveragePct)}% ${insights.latestVsAveragePct <= 0 ? "below" : "above"} prior average ${entry.currency} ${insights.averagePrice}`
    );
  } else {
    parts.push(`${insights.baselineSampleCount}/3 prior comparable samples`);
  }
  if (insights.typicalLow !== null && insights.typicalHigh !== null) {
    parts.push(`Google typical range ${entry.currency} ${insights.typicalLow}-${insights.typicalHigh}`);
  }
  if (insights.marketPriceHistorySampleCount) {
    parts.push(
      `${insights.marketPriceHistorySampleCount} Google online history points, median ${entry.currency} ${insights.marketHistoryMedian}`
    );
  }
  return parts.join("; ");
}

function formatNoDealSummary(candidates, options = {}) {
  const discoveryResult = options.discoveryResult || {};
  const dealCandidates = options.dealCandidates || [];
  const checkIntervalHours = Number(options.checkIntervalHours || 48);
  const lines = [
    "Flight Tracker check complete",
    "",
    dealCandidates.length
      ? `${dealCandidates.length} relative deal${dealCandidates.length === 1 ? "" : "s"} still qualified, but the alert cooldown prevented a duplicate deal alert.`
      : "No new relative deals matched the alert criteria.",
    `Checked ${candidates.length} live fare candidate${candidates.length === 1 ? "" : "s"}.`
  ];

  if (discoveryResult.exploredCandidates) {
    lines.push(
      `Flexible discovery reviewed ${discoveryResult.exploredCandidates} option${discoveryResult.exploredCandidates === 1 ? "" : "s"} for month ${discoveryResult.exploredMonth}.`
    );
  }
  if (options.splitTicketsChecked) {
    lines.push(
      `Compared ${options.splitTicketsChecked} round trip${options.splitTicketsChecked === 1 ? "" : "s"} against separately priced outbound and return tickets.`
    );
  }
  if (options.returnVerificationsAttempted) {
    lines.push(
      `Return-itinerary verification passed ${options.returnVerificationsPassed || 0} of ${options.returnVerificationsAttempted} alertable round trip${options.returnVerificationsAttempted === 1 ? "" : "s"}; unverified returns were suppressed.`
    );
  }
  if (options.providerStats?.failed) {
    lines.push(
      `Provider health: ${options.providerStats.successful} Google Flights requests succeeded and ${options.providerStats.failed} failed; this was a partial check.`
    );
  }
  if (options.providerStats) {
    const quota = options.quota || {};
    const remaining = Number.isFinite(quota.remaining)
      ? `${quota.remaining} credits remained before this run`
      : "provider balance unavailable";
    lines.push(
      `Search usage: ${options.providerStats.attempted} attempted, ${options.providerStats.successful} succeeded, ${options.providerStats.skipped || 0} skipped; ${remaining}.`
    );
  }
  if (options.coverage) {
    lines.push(
      `Coverage: ${options.coverage.recentlyCoveredSearches}/${options.coverage.eligibleSearches} eligible exact searches attempted in the last ${options.coverage.recentDays} days (${options.coverage.coveragePercent}%).`
    );
  }
  if (options.constructionSummary) {
    lines.push(`Alternative construction: ${options.constructionSummary}.`);
  }
  if (options.promotionResult) {
    lines.push(
      `Promotion watch: checked ${options.promotionResult.checked} official airline page${options.promotionResult.checked === 1 ? "" : "s"}; ${options.promotionResult.changed.length} changed since the previous check.`
    );
  }
  const manualReviewCandidates = candidates.filter((candidate) => (
    isFareDeal(candidate) &&
    candidate.entry.transferAssessment?.status === "self-transfer-manual-review"
  ));
  const rejectedTransferCandidates = candidates.filter((candidate) => (
    candidate.entry.transferAssessment?.status === "self-transfer-rejected"
  ));
  if (manualReviewCandidates.length) {
    lines.push("", "Self-transfers requiring manual review:");
    manualReviewCandidates.slice(0, 3).forEach((candidate, index) => {
      const entry = candidate.entry;
      lines.push(
        `${index + 1}. ${entry.origin} -> ${entry.destination} | ${entry.currency} ${entry.price} | ${entry.departureDate}${entry.returnDate ? ` to ${entry.returnDate}` : ""}`
      );
      lines.push(`Unresolved: ${entry.transferAssessment.reasons.join(" ")}`);
      lines.push(
        "Verify entry/transit permission, passport validity, onward proof, baggage recheck, terminals, fallback flights, and all transfer costs before booking."
      );
      if (candidate.links?.googleFlights) {
        lines.push(`Open flight search: ${candidate.links.googleFlights}`);
      }
    });
  }
  if (rejectedTransferCandidates.length) {
    lines.push(
      `Rejected self-transfers: ${rejectedTransferCandidates.length}; reasons were recorded in fare history.`
    );
  }
  (options.splitComparisons || []).forEach((comparison) => {
    const difference = Math.abs(comparison.roundTripPrice - comparison.splitPrice);
    const winner = comparison.splitPrice < comparison.roundTripPrice
      ? `separate one-ways save ${comparison.currency} ${difference}`
      : `the normal return is ${comparison.currency} ${difference} cheaper`;
    lines.push(
      `Split check ${comparison.origin} -> ${comparison.destination}: ${comparison.currency} ${comparison.splitPrice} as two one-ways vs ${comparison.currency} ${comparison.roundTripPrice} return; ${winner}.`
    );
  });

  const cheapest = [...candidates]
    .sort((a, b) => a.entry.price - b.entry.price)
    .slice(0, 3);

  if (cheapest.length) {
    lines.push("", "Cheapest observed (not deal alerts):");
    cheapest.forEach(({ entry, insights, links, value }, index) => {
      const dates = `${formatTravelDate(entry.departureDate)}${entry.returnDate ? ` to ${formatTravelDate(entry.returnDate)}` : ""}`;
      lines.push(`${index + 1}. ${entry.origin} -> ${entry.destination} | ${dates} | ${entry.currency} ${entry.price} ${entry.tripType}`);
      if (entry.notes) lines.push(`Flight: ${entry.notes}.`);
      if (value) {
        lines.push(`Decision: ${value.action} | traveler value ${value.score}/100.`);
        if (value.risks.length) lines.push(`Tradeoffs: ${value.risks.join("; ")}.`);
      }
      lines.push(`Analysis: ${formatHistoryAnalysis(entry, insights)}.`);
      lines.push(`Why no alert: ${explainNoDeal(insights, entry)}.`);
      if (entry.verificationError) {
        lines.push(`Return verification: ${entry.verificationError}`);
      }
      if (links?.outboundGoogleFlights) {
        lines.push(`Outbound: ${links.outboundGoogleFlights}`);
        lines.push(`Return: ${links.inboundGoogleFlights}`);
      } else if (links?.googleFlights) {
        lines.push(`Open flight search: ${links.googleFlights}`);
      }
    });
  } else {
    lines.push(
      "",
      "No live candidates were returned. Review the GitHub Actions log for API or route errors."
    );
  }

  lines.push("", `The next completed automatic check is due in about ${checkIntervalHours} hours.`);
  return lines.join("\n");
}

function formatPromotionUpdate(promotionResult) {
  const lines = [
    "Airline promotion pages changed",
    "",
    "These are leads, not verified fare deals. Check the linked offer and compare it with Google Flights before booking."
  ];
  promotionResult.changed.forEach((promotion) => {
    lines.push("", `${promotion.label}: ${promotion.snippet}`, promotion.url);
  });
  return lines.join("\n");
}

async function sendDiscord(message) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;

  const chunks = [];
  let current = "";
  for (const line of String(message).split("\n")) {
    const addition = `${current ? "\n" : ""}${line}`;
    if (current && current.length + addition.length > 1900) {
      chunks.push(current);
      current = line;
    } else if (!current && line.length > 1900) {
      chunks.push(line.slice(0, 1900));
      current = line.slice(1900);
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);

  for (const content of chunks) {
    const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!response.ok) {
      throw new Error(`Discord alert failed: ${response.status} ${await response.text()}`);
    }
  }
}

async function deliverNotifications(message) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    if (String(process.env.REQUIRE_NOTIFICATION_CHANNEL).toLowerCase() === "true") {
      throw new Error("Discord is not configured.");
    }
    console.warn("No local Discord webhook configured; message was logged only.");
    return;
  }
  await sendDiscord(message);
}

async function main() {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  const config = readJson(configPath, { routes: [] });
  const history = readJson(HISTORY_PATH, []);
  const state = readJson(STATE_PATH, { cursor: 0, alerts: {} });
  const transitPolicyConfig = readJson(TRANSIT_POLICY_PATH, { policies: [] });
  let transitPolicyCache = readJson(TRANSIT_POLICY_CACHE_PATH, {});
  const transitPolicyProvider = new ManualTransitPolicyProvider(
    transitPolicyConfig.policies || []
  );
  const transferConfig = config.transitAssessment || {};
  const traveler = {
    ...(config.traveler || {}),
    passportNationality: config.traveler?.passportNationality || "Switzerland",
    passportCountryCode: normalizePassportCountry(
      config.traveler?.passportCountryCode || "CHE"
    )
  };
  const runId = new Date().toISOString();
  const checkIntervalHours = Number(config.checkIntervalHours || 48);
  const minimumElapsedMs = Math.max(1, checkIntervalHours - 1) * 60 * 60 * 1000;
  const lastCompletedAt = Date.parse(state.lastCompletedAt || "");
  const forceRun = String(process.env.FORCE_RUN || "").toLowerCase() === "true";

  if (!forceRun && Number.isFinite(lastCompletedAt) && Date.now() - lastCompletedAt < minimumElapsedMs) {
    console.log(`Skipping fare check: the previous run completed less than ${checkIntervalHours} hours ago.`);
    return;
  }

  const allSearches = config.routes.flatMap((route) => buildSearches({
    ...traveler,
    transitAirportCountries: transferConfig.airportCountries || {},
    ...route
  }));
  const maxSearchesPerRun = Math.min(
    20,
    Number(process.env.MAX_SEARCHES_PER_RUN || config.maxSearchesPerRun || 80)
  );
  const discoveryEnabled = Boolean(config.discovery?.enabled)
    && String(process.env.DISCOVERY_ENABLED ?? "true").toLowerCase() !== "false";
  const constructionsEnabled = Boolean(config.constructions?.enabled)
    && String(process.env.CONSTRUCTIONS_ENABLED ?? "true").toLowerCase() !== "false";
  const maximumReturnVerifications = Math.min(
    1,
    Math.max(0, Number(config.returnVerification?.maxPerRun || 1))
  );
  const constructionReserve = constructionsEnabled ? 2 : 0;
  const exactSearchSlots = Math.max(
    1,
    maxSearchesPerRun - constructionReserve - maximumReturnVerifications
  );
  const normalizedCursor = allSearches.length ? Number(state.cursor || 0) % allSearches.length : 0;
  const searches = selectSearches(allSearches, history, {
    maxSearches: exactSearchSlots,
    horizonDays: config.exactSearchHorizonDays,
    oneWayShare: config.oneWaySearchShare
  });
  const nextCursor = allSearches.length ? (normalizedCursor + searches.length) % allSearches.length : 0;

  if (!searches.length && !discoveryEnabled && !constructionsEnabled) {
    console.log("No searches configured.");
    return;
  }

  if (configPath === EXAMPLE_CONFIG_PATH) {
    console.log("Using automation/routes.example.json. Copy it to automation/routes.json and edit it for real alerts.");
  }

  const candidates = [];
  const newEntries = [];
  let splitTicketsChecked = 0;
  let returnVerificationsAttempted = 0;
  let returnVerificationsPassed = 0;
  const splitComparisons = [];
  let constructionSummary = "";
  let nextCoverage = { ...(state.coverageLedger || {}) };
  const accountBeforeResult = await getSerpApiAccount();
  if (!accountBeforeResult.ok) console.warn(accountBeforeResult.error);
  const quota = buildQuotaSnapshot(
    accountBeforeResult.ok ? accountBeforeResult.account : null,
    config.quota?.reserveSearches || 10
  );
  const maximumCallsPerCycle = Math.max(
    1,
    Number(config.quota?.maxCallsPerCycle || 14)
  );
  const budgetLimit = quota.spendableThisRun === null
    ? maximumCallsPerCycle
    : Math.min(maximumCallsPerCycle, quota.spendableThisRun);
  const providerStats = {
    attempted: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    byKind: {},
    errors: []
  };
  const canSpend = () => providerStats.attempted < budgetLimit;
  const recordProviderResult = (kind, result) => {
    providerStats.byKind[kind] ||= { attempted: 0, successful: 0, failed: 0 };
    providerStats.byKind[kind].attempted += 1;
    providerStats.attempted += 1;
    if (result.ok) {
      providerStats.successful += 1;
      providerStats.byKind[kind].successful += 1;
    } else {
      providerStats.failed += 1;
      providerStats.byKind[kind].failed += 1;
      providerStats.errors.push(result.error);
    }
  };
  const trackedSearch = async (search, options, requestedKind = "exact") => {
    const kind = options?.departureToken ? "return-verify" : requestedKind;
    if (!canSpend()) {
      providerStats.skipped += 1;
      return {
        ok: false,
        skipped: true,
        error: `Search skipped to preserve the ${config.quota?.reserveSearches || 10}-credit reserve and ${maximumCallsPerCycle}-call cycle cap.`,
        offers: []
      };
    }
    let result;
    try {
      result = await searchSerpApi(search, options);
    } catch (error) {
      result = {
        ok: false,
        error: `Google Flights request failed: ${error.message}`,
        offers: []
      };
    }
    recordProviderResult(kind, result);
    nextCoverage = updateCoverage(nextCoverage, search, kind, result, runId);
    return result;
  };

  const knownDestinations = new Set(config.routes.flatMap((route) => (
    route.destinationLocationCodes || [route.destinationLocationCode || route.destination]
  )).filter(Boolean));
  let discoveryResult;
  if (discoveryEnabled && !canSpend()) {
    providerStats.skipped += 1;
    discoveryResult = {
      ok: false,
      error: "Flexible discovery skipped because the run has no safe SerpApi credits left.",
      searches: [],
      nextMonthCursor: Number(state.discoveryMonthCursor || 0)
    };
  } else {
    try {
      discoveryResult = await searchGoogleTravelExplore(
        {
          ...traveler,
          transitAirportCountries: transferConfig.airportCountries || {},
          ...config.discovery,
          enabled: discoveryEnabled
        },
        state,
        knownDestinations
      );
    } catch (error) {
      discoveryResult = {
        ok: false,
        error: `Google Travel Explore request failed: ${error.message}`,
        searches: [],
        nextMonthCursor: Number(state.discoveryMonthCursor || 0)
      };
    }
    if (discoveryEnabled) recordProviderResult("explore", discoveryResult);
  }
  if (!discoveryResult.ok) {
    console.warn(discoveryResult.error);
  } else {
    for (const search of discoveryResult.searches) {
      const result = await trackedSearch(search, undefined, "explore-verify");
      if (!result.ok) {
        console.warn(result.error);
        continue;
      }
      const searchCandidates = summarizeSearchOffers(
        search,
        result.offers,
        history,
        transferConfig,
        "Google Travel Explore, verified via Google Flights"
      );
      candidates.push(...searchCandidates);
      newEntries.push(...searchCandidates.map((candidate) => candidate.entry));
    }
  }

  if (config.splitTickets?.enabled && discoveryResult.searches.length) {
    const splitTargets = discoveryResult.searches.slice(
      0,
      Math.max(0, Number(config.splitTickets.verifyPerRun || 1))
    );
    for (const roundTripSearch of splitTargets) {
      const roundTripCandidate = candidates.find((candidate) => (
        candidate.entry.origin === roundTripSearch.origin &&
        candidate.entry.destination === roundTripSearch.destination &&
        candidate.entry.departureDate === roundTripSearch.departureDate &&
        candidate.entry.returnDate === roundTripSearch.returnDate &&
        candidate.entry.itineraryProtection === "protected"
      ));
      if (!roundTripCandidate) continue;
      const [outboundSearch, inboundSearch] = buildSplitTicketSearches(roundTripSearch);
      const outboundResult = await trackedSearch(outboundSearch, undefined, "split-outbound");
      const inboundResult = await trackedSearch(inboundSearch, undefined, "split-inbound");
      splitTicketsChecked += 1;
      if (!outboundResult.ok || !inboundResult.ok) {
        if (!outboundResult.ok) console.warn(outboundResult.error);
        if (!inboundResult.ok) console.warn(inboundResult.error);
        continue;
      }
      const outboundOffer = [...outboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      const inboundOffer = [...inboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      if (!outboundOffer || !inboundOffer) continue;
      splitComparisons.push({
        origin: roundTripSearch.origin,
        destination: roundTripSearch.destination,
        departureDate: roundTripSearch.departureDate,
        returnDate: roundTripSearch.returnDate,
        currency: roundTripSearch.currencyCode,
        splitPrice: outboundOffer.price + inboundOffer.price,
        roundTripPrice: roundTripCandidate.entry.price
      });
      const splitCandidate = summarizeSplitTicketCandidate(
        roundTripSearch,
        outboundOffer,
        inboundOffer,
        roundTripCandidate,
        history,
        config.splitTickets
      );
      if (splitCandidate) {
        candidates.push(splitCandidate);
        newEntries.push(splitCandidate.entry);
      }
    }
  }

  for (const search of searches) {
    const result = await trackedSearch(search, undefined, "exact");
    if (!result.ok) {
      console.warn(result.error);
      continue;
    }

    const searchCandidates = summarizeSearchOffers(
      search,
      result.offers,
      history,
      transferConfig
    );
    candidates.push(...searchCandidates);
    newEntries.push(...searchCandidates.map((candidate) => candidate.entry));
  }

  const referenceSearch = searches.find((search) => search.tripType === "round-trip") ||
    allSearches.find((search) => (
      search.tripType === "round-trip" &&
      Date.parse(`${search.departureDate}T00:00:00Z`) > Date.now()
    ));
  const constructionLane = buildConstructionLane(
    {
      ...traveler,
      ...(config.constructions || {}),
      enabled: constructionsEnabled
    },
    state,
    referenceSearch
  );
  if (constructionLane.definition?.type === "nearby-airports") {
    const constructionSearch = constructionLane.searches[0];
    const result = await trackedSearch(constructionSearch, undefined, "construction");
    if (result.ok) {
      const searchCandidates = summarizeSearchOffers(
        constructionSearch,
        result.offers,
        history,
        transferConfig,
        "Nearby-airport group via Google Flights"
      );
      candidates.push(...searchCandidates);
      newEntries.push(...searchCandidates.map((candidate) => candidate.entry));
    }
    constructionSummary = `checked ${constructionLane.definition.label} as a grouped nearby-airport search`;
  } else if (constructionLane.definition?.type === "open-jaw") {
    const [outboundSearch, inboundSearch] = constructionLane.searches;
    const outboundResult = await trackedSearch(outboundSearch, undefined, "construction");
    const inboundResult = await trackedSearch(inboundSearch, undefined, "construction");
    if (outboundResult.ok && inboundResult.ok) {
      const outboundOffer = [...outboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      const inboundOffer = [...inboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      if (outboundOffer && inboundOffer) {
        const candidate = summarizeOpenJawCandidate(
          referenceSearch,
          constructionLane.definition,
          outboundOffer,
          inboundOffer,
          history
        );
        candidates.push(candidate);
        newEntries.push(candidate.entry);
      }
    }
    constructionSummary = `checked ${constructionLane.definition.label} as two open-jaw one-way fares; transfer cost is excluded`;
  }

  for (const candidate of [...candidates]) {
    if (
      !isFareDeal(candidate) ||
      candidate.entry.tripType !== "round-trip" ||
      ["split-one-ways", "open-jaw"].includes(candidate.entry.searchStrategy)
    ) {
      continue;
    }
    if (returnVerificationsAttempted >= maximumReturnVerifications) {
      candidate.insights.level = "verification-required";
      candidate.entry.verificationError =
        "Per-run return-verification quota was reached; no alert was sent.";
      continue;
    }

    returnVerificationsAttempted += 1;
    const verification = await verifyRoundTripOffer(
      candidate.search,
      candidate.offer,
      trackedSearch
    );
    if (!verification.ok) {
      console.warn(
        `Suppressing ${candidate.entry.origin}-${candidate.entry.destination} alert: ${verification.error}`
      );
      candidate.insights.level = "verification-failed";
      candidate.entry.verificationError = verification.error;
      continue;
    }

    const verifiedCandidate = summarizeCandidate(
      candidate.search,
      verification.offer,
      history
    );
    const candidateIndex = candidates.indexOf(candidate);
    const entryIndex = newEntries.indexOf(candidate.entry);
    candidates[candidateIndex] = verifiedCandidate;
    if (entryIndex >= 0) newEntries[entryIndex] = verifiedCandidate.entry;
    returnVerificationsPassed += 1;
  }

  for (const candidate of [...candidates]) {
    if (
      !isFareDeal(candidate) ||
      (candidate.entry.itineraryProtection || "protected") === "protected"
    ) {
      continue;
    }

    const result = await assessTransferRisk({
      offer: candidate.offer,
      traveler: {
        ...traveler,
        passportNationality: candidate.search.passportNationality || traveler.passportNationality,
        passportCountryCode: normalizePassportCountry(
          candidate.search.passportCountryCode || traveler.passportCountryCode
        ),
        carryOnBags: Number(candidate.search.carryOnBags ?? traveler.carryOnBags ?? 0),
        checkedBags: Number(candidate.search.checkedBags ?? traveler.checkedBags ?? 0),
        baggageProfile: candidate.search.baggageProfile || traveler.baggageProfile
      },
      travelEndDate: candidate.search.returnDate || candidate.search.departureDate,
      currency: candidate.entry.currency,
      config: transferConfig,
      provider: transitPolicyProvider,
      cache: transitPolicyCache
    });
    const assessment = result.assessment;
    transitPolicyCache = result.cache;

    const extraCost = assessment.extraEstimatedCost;
    const effectivePrice = isKnownNumber(extraCost)
      ? candidate.offer.price + Number(extraCost)
      : candidate.offer.price;
    const effectiveSavings = qualifiesTransferSavings(
      effectivePrice,
      candidate.offer.protectedComparablePrice,
      transferConfig
    );
    const assessedOffer = {
      ...candidate.offer,
      baseFare: candidate.offer.price,
      price: effectivePrice,
      transferSavings: effectiveSavings.amount,
      transferSavingsPercent: effectiveSavings.percent,
      transferSavingsQualifies: effectiveSavings.qualifies,
      transferAssessment: assessment,
      itineraryProtection: "self-transfer"
    };
    const assessedCandidate = summarizeCandidate(
      candidate.search,
      assessedOffer,
      history
    );
    if (assessment.status === "self-transfer-rejected") {
      assessedCandidate.entry.transferRejectionReason =
        assessment.reasons.join(" ");
    }
    const candidateIndex = candidates.indexOf(candidate);
    const entryIndex = newEntries.indexOf(candidate.entry);
    candidates[candidateIndex] = assessedCandidate;
    if (entryIndex >= 0) newEntries[entryIndex] = assessedCandidate.entry;
  }

  const accountAfterResult = await getSerpApiAccount();
  if (!accountAfterResult.ok) console.warn(accountAfterResult.error);
  quota.after = accountAfterResult.ok
    ? buildQuotaSnapshot(accountAfterResult.account, config.quota?.reserveSearches || 10)
    : null;
  quota.providerUsageDelta = accountBeforeResult.ok && accountAfterResult.ok
    ? Number(accountAfterResult.account.this_month_usage) -
      Number(accountBeforeResult.account.this_month_usage)
    : null;
  const promotionResult = await checkPromotionSources(
    config.promotionMonitoring,
    state.promotions || {}
  );
  promotionResult.errors.forEach((error) => console.warn(`Promotion watch: ${error}`));
  const coverage = summarizeCoverage(allSearches, nextCoverage, {
    horizonDays: config.exactSearchHorizonDays,
    recentDays: 14
  });
  const nextHistory = [...history, ...newEntries].slice(-2000);
  writeJson(HISTORY_PATH, nextHistory);
  writeJson(TRANSIT_POLICY_CACHE_PATH, transitPolicyCache);
  const cooldownHours = Number(config.alertCooldownHours || 168);
  const alerts = state.alerts || {};
  const dealCandidates = candidates.filter(shouldAlert);
  const alertCandidates = dealCandidates
    .filter((candidate) => isFreshAlert(candidate, alerts, cooldownHours));
  const nextState = {
    ...state,
    cursor: forceRun ? state.cursor : nextCursor,
    constructionCursor: forceRun
      ? Number(state.constructionCursor || 0)
      : constructionLane.nextCursor,
    totalSearches: allSearches.length,
    checkedThisRun: searches.length,
    discoveryMonthCursor: discoveryResult.nextMonthCursor,
    exploredMonth: discoveryResult.exploredMonth || null,
    exploredCandidates: discoveryResult.exploredCandidates || 0,
    flexibleDealsChecked: discoveryResult.ok ? discoveryResult.searches.length : 0,
    splitTicketsChecked,
    splitComparisons,
    constructionSummary,
    returnVerificationsAttempted,
    returnVerificationsPassed,
    providerStats,
    quota,
    coverage,
    coverageLedger: nextCoverage,
    promotions: promotionResult.state,
    promotionErrors: promotionResult.errors,
    lastRunAt: runId,
    lastCompletedAt: forceRun ? state.lastCompletedAt : runId,
    alerts
  };

  if (
    providerStats.successful === 0 &&
    (providerStats.attempted > 0 || providerStats.skipped > 0)
  ) {
    const message = [
      "Flight Tracker check incomplete",
      "",
      providerStats.attempted
        ? `All ${providerStats.attempted} Google Flights requests failed.`
        : "No fare request could run without breaching the configured quota reserve.",
      "No no-deal conclusion was recorded and the tracker will retry on its next workflow wake-up.",
      ...providerStats.errors.slice(0, 3).map((error) => `Error: ${error}`)
    ].join("\n");
    console.error(message);
    nextState.lastCompletedAt = state.lastCompletedAt;
    writeJson(STATE_PATH, nextState);
    await deliverNotifications(message);
    throw new Error("All Google Flights provider requests failed.");
  }

  writeJson(STATE_PATH, nextState);
  if (alertCandidates.length) {
    const message = formatAlert(alertCandidates);
    console.log(message);
    await deliverNotifications(message);
    alertCandidates.forEach((candidate) => {
      alerts[alertKey(candidate)] = {
        price: candidate.entry.price,
        sentAt: Date.now()
      };
    });
    writeJson(STATE_PATH, { ...nextState, alerts });
  } else {
    const discoveryNote = discoveryResult.searches.length
      ? ", including flexible discovery"
      : "";
    console.log(`Checked ${candidates.length} live fare candidates${discoveryNote}. No new relative deals found.`);
    if (config.notifyOnNoDeals !== false) {
      const summary = formatNoDealSummary(candidates, {
        discoveryResult,
        dealCandidates,
        splitTicketsChecked,
        splitComparisons,
        returnVerificationsAttempted,
        returnVerificationsPassed,
        providerStats,
        quota,
        coverage,
        constructionSummary,
        promotionResult,
        checkIntervalHours
      });
      console.log(summary);
      await deliverNotifications(summary);
    }
  }

  if (promotionResult.changed.length) {
    await deliverNotifications(formatPromotionUpdate(promotionResult));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  alertKey,
  buildSearches,
  buildSplitTicketSearches,
  combineRoundTripOffers,
  explainNoDeal,
  formatAlert,
  formatNoDealSummary,
  formatHistoryAnalysis,
  isFareDeal,
  main,
  mapSerpApiOffer,
  selectSearches,
  shouldAlert,
  summarizeCandidate,
  summarizeOpenJawCandidate,
  summarizeSplitTicketCandidate,
  verifyRoundTripOffer
};
