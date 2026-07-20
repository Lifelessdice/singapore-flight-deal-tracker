const fs = require("node:fs");
const path = require("node:path");
const {
  analyzeFareHistory,
  getLeadTimeBucket,
  hasSameBaggageProfile
} = require("../fare-insights");
const {
  buildDateFirstExploreLanes,
  buildConstructionLane,
  buildQuotaSnapshot,
  checkPromotionSources,
  createCallBudget,
  rankExploreCandidates,
  resolveCallLimit,
  scoreTravelerValue,
  selectExploreCandidates,
  summarizeCoverage,
  updateDateFirstExploreState,
  updateCoverage
} = require("../tracker-product");
const {
  ManualTransitPolicyProvider,
  assessTransferRisk,
  isKnownNumber,
  normalizePassportCountry,
  transferSavings
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

function getGoogleFlightsSearchUrl(search) {
  const query = `${search.origin} to ${search.destination} ${search.departureDate}${search.returnDate ? ` return ${search.returnDate}` : ""}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function getGoogleFlightsUrl(search) {
  return search.googleFlightsUrl || getGoogleFlightsSearchUrl(search);
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

function mapSerpApiOffer(offer, search, priceInsights, googleFlightsUrl = null) {
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
    googleFlightsUrl,
    averagePrice: search.discoveryAveragePrice ?? null,
    discountPercentage: search.discoveryDiscountPercentage ?? null,
    googlePriceInsights: priceInsights || search.discoveryGooglePriceInsights || null
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
  const googleFlightsUrl = data.search_metadata?.google_flights_url || null;
  const offers = rawFlights
    .map((offer) => mapSerpApiOffer(
      offer,
      search,
      data.price_insights,
      googleFlightsUrl
    ))
    .filter((offer) => Number.isFinite(offer.price))
    .filter((offer) => !search.maxTotalDurationMinutes || offer.totalDurationMinutes <= search.maxTotalDurationMinutes)
    .filter((offer) => search.maxStops === null || offer.maxStops <= search.maxStops);

  return { ok: true, offers, googleFlightsUrl };
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
    googleFlightsUrl: returnOffer.googleFlightsUrl ||
      outboundOffer.googleFlightsUrl ||
      null,
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
    const savings = transferSavings(
      transferOffer.price,
      protectedOffer?.price
    );
    selected.push({
      ...transferOffer,
      protectedComparablePrice: protectedOffer?.price ?? null,
      transferSavings: savings.amount,
      transferSavingsPercent: savings.percent,
      transferSavingsQualifies: null
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

async function searchGoogleTravelExploreLane(
  lane,
  fetchImpl = fetch,
  now = Date.now()
) {
  assertEnv("SERPAPI_API_KEY");

  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set("engine", "google_travel_explore");
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);
  url.searchParams.set("departure_id", lane.origin);
  url.searchParams.set("type", lane.tripType === "one-way" ? "2" : "1");
  url.searchParams.set("outbound_date", lane.departureDate);
  if (lane.returnDate) url.searchParams.set("return_date", lane.returnDate);
  url.searchParams.set("adults", String(lane.adults || 1));
  url.searchParams.set("currency", lane.currencyCode || "USD");
  url.searchParams.set("travel_class", getTravelClassCode(lane.travelClass));
  url.searchParams.set("gl", "sg");
  url.searchParams.set("hl", "en");
  url.searchParams.set("travel_mode", "1");
  url.searchParams.set("stops", String((Number(lane.maxStops) || 0) + 1));
  url.searchParams.set("bags", String(Math.max(0, Number(lane.carryOnBags) || 0)));
  if (lane.maxDiscoveryPrice) {
    url.searchParams.set("max_price", String(lane.maxDiscoveryPrice));
  }
  if (lane.maxTotalDurationMinutes) {
    url.searchParams.set("max_duration", String(lane.maxTotalDurationMinutes));
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    return {
      ok: false,
      error: `Google Travel Explore ${lane.laneType} search failed: ${response.status} ${await response.text()}`,
      candidates: []
    };
  }

  const data = await response.json();
  if (data.error) {
    return {
      ok: false,
      error: `Google Travel Explore ${lane.laneType} error: ${data.error}`,
      candidates: []
    };
  }

  const candidates = (data.destinations || [])
    .map((destination) => {
      const airportCode = destination.destination_airport?.code;
      const departureDate = destination.start_date || lane.departureDate;
      const returnDate = lane.tripType === "round-trip"
        ? destination.end_date || lane.returnDate
        : "";
      const departure = Date.parse(`${departureDate}T00:00:00Z`);
      const returning = returnDate
        ? Date.parse(`${returnDate}T00:00:00Z`)
        : null;
      const tripLengthDays = returning
        ? Math.round((returning - departure) / (24 * 60 * 60 * 1000))
        : null;
      return {
        origin: lane.origin,
        destination: airportCode,
        destinationName: destination.name || airportCode,
        departureDate,
        returnDate,
        tripType: lane.tripType,
        tripLengthDays,
        price: Number(destination.flight_price),
        averagePrice: null,
        discountPercentage: null,
        googlePriceInsights: null,
        totalDurationMinutes: Number.isFinite(Number(destination.flight_duration))
          ? Number(destination.flight_duration)
          : null,
        stops: Number.isFinite(Number(destination.number_of_stops))
          ? Number(destination.number_of_stops)
          : null,
        airline: destination.airline || "",
        airlineCode: destination.airline_code || "",
        maxPrice: lane.maxPrice,
        maxDiscoveryPrice: lane.maxDiscoveryPrice,
        maxTotalDurationMinutes: lane.maxTotalDurationMinutes,
        maxStops: lane.maxStops,
        adults: lane.adults,
        currencyCode: lane.currencyCode,
        travelClass: lane.travelClass,
        passportNationality: lane.passportNationality,
        passportCountryCode: lane.passportCountryCode,
        carryOnBags: lane.carryOnBags,
        checkedBags: lane.checkedBags,
        baggageProfile: lane.baggageProfile,
        transitAirportCountries: lane.transitAirportCountries,
        laneId: lane.id,
        laneType: lane.laneType,
        routeId: lane.routeId,
        observedAt: now,
        googleFlightsUrl: destination.link || destination.flight_link || null
      };
    })
    .filter((candidate) => candidate.destination && candidate.destination !== candidate.origin)
    .filter((candidate) => Number.isFinite(candidate.price) && candidate.price > 0)
    .filter((candidate) => (
      Number.isFinite(candidate.totalDurationMinutes) &&
      Number.isFinite(candidate.stops)
    ))
    .filter((candidate) => (
      Date.parse(`${candidate.departureDate}T00:00:00Z`) > now
    ))
    .filter((candidate) => candidate.departureDate === lane.departureDate)
    .filter((candidate) => (
      lane.tripType === "one-way" ||
      (
        candidate.returnDate === lane.returnDate &&
        candidate.tripLengthDays === lane.tripLengthDays
      )
    ))
    .filter((candidate) => (
      !lane.maxTotalDurationMinutes ||
      candidate.totalDurationMinutes <= Number(lane.maxTotalDurationMinutes)
    ))
    .filter((candidate) => candidate.stops <= Number(lane.maxStops));

  return {
    ok: true,
    lane,
    candidates
  };
}

function buildExploreVerificationSearch(candidate) {
  return {
    routeId: `explore-${candidate.origin}-${candidate.destination}`,
    label: `${candidate.destinationName || candidate.destination} date-first discovery`,
    origin: candidate.origin,
    destination: candidate.destination,
    destinationName: candidate.destinationName || candidate.destination,
    departureDate: candidate.departureDate,
    returnDate: candidate.returnDate || "",
    adults: candidate.adults || 1,
    currencyCode: candidate.currencyCode || "USD",
    travelClass: candidate.travelClass || "ECONOMY",
    maxPrice: candidate.maxPrice,
    tripType: candidate.tripType,
    maxTotalDurationMinutes: candidate.maxTotalDurationMinutes,
    maxStops: candidate.maxStops,
    passportNationality: candidate.passportNationality || "Switzerland",
    passportCountryCode: normalizePassportCountry(
      candidate.passportCountryCode || "CHE"
    ),
    carryOnBags: Math.max(0, Number(candidate.carryOnBags) || 0),
    checkedBags: Math.max(0, Number(candidate.checkedBags) || 0),
    baggageProfile: candidate.baggageProfile || "",
    transitAirportCountries: candidate.transitAirportCountries || {},
    discoveryPrice: candidate.price,
    discoveryAveragePrice: candidate.averagePrice,
    discoveryDiscountPercentage: candidate.discountPercentage,
    discoveryGooglePriceInsights: candidate.googlePriceInsights,
    discoveryEvidence: candidate.ranking,
    discoveryTotalDurationMinutes: candidate.totalDurationMinutes,
    discoveryStops: candidate.stops,
    discoveryAirline: candidate.airline || "",
    exploreUrl: candidate.googleFlightsUrl || null
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
    adults: Number(search.adults || 1),
    travelClass: search.travelClass || "ECONOMY",
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
      String(item.currency || entry.currency) === String(entry.currency) &&
      String(item.travelClass || entry.travelClass) === entry.travelClass &&
      Number(item.adults ?? entry.adults) === entry.adults &&
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
      googleFlights: offer.googleFlightsUrl || getGoogleFlightsSearchUrl(search),
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
  const surfaceTransferCost = Number(definition.surfaceTransferCost);
  const hasKnownSurfaceTransferCost = (
    definition.surfaceTransferCost !== null &&
    definition.surfaceTransferCost !== undefined &&
    definition.surfaceTransferCost !== "" &&
    Number.isFinite(surfaceTransferCost) &&
    surfaceTransferCost >= 0
  );
  const combinedOffer = {
    source: "Open-jaw one-way combination via Google Flights",
    price: outboundOffer.price + inboundOffer.price +
      (hasKnownSurfaceTransferCost ? surfaceTransferCost : 0),
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
  candidate.entry.constructionCostComplete = hasKnownSurfaceTransferCost;
  candidate.entry.constructionExtraEstimatedCost = hasKnownSurfaceTransferCost
    ? surfaceTransferCost
    : null;
  candidate.entry.notes = `${outboundOffer.airlines.join(", ") || "unknown carrier"} from ${referenceSearch.origin} to ${definition.outboundDestination}, then ${inboundOffer.airlines.join(", ") || "unknown carrier"} from ${definition.inboundOrigin} to ${referenceSearch.origin}; ${Math.round(outboundOffer.totalDurationMinutes / 60)}h outbound and ${Math.round(inboundOffer.totalDurationMinutes / 60)}h return-side flight. Ground transport between ${definition.outboundDestination} and ${definition.inboundOrigin} ${hasKnownSurfaceTransferCost ? `is estimated at ${referenceSearch.currencyCode} ${surfaceTransferCost} and included` : "has unknown cost and is not included"}`;
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
  if (
    candidate.entry.searchStrategy === "open-jaw" &&
    candidate.entry.constructionCostComplete === false
  ) {
    return false;
  }
  if ((candidate.entry.itineraryProtection || "protected") === "protected") return true;
  return candidate.entry.transferAssessment?.status === "self-transfer-acceptable";
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
      lines.push("Transfer status: ACCEPTABLE SELF-TRANSFER.");
      lines.push(
        `Effective cost: ${entry.currency} ${entry.baseFare} base fare + ${entry.currency} ${entry.extraEstimatedCost} estimated transfer requirements = ${entry.currency} ${entry.price}.`
      );
      if (
        Number.isFinite(Number(entry.transferSavings)) &&
        Number.isFinite(Number(entry.transferSavingsPercent))
      ) {
        const cheaper = Number(entry.transferSavings) >= 0;
        lines.push(
          `Protected comparison: ${entry.currency} ${Math.abs(Number(entry.transferSavings))} (${Math.abs(Number(entry.transferSavingsPercent))}%) ${cheaper ? "cheaper than" : "more than"} the comparable protected fare; this comparison is informational, not an eligibility threshold.`
        );
      } else {
        lines.push(
          "Protected comparison: no same-run protected fare was available; no additional monetary threshold was applied."
        );
      }
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
    lines.push("Live-search links (recheck the fare before booking):");
    lines.push(`Google Flights exact results: ${candidate.links.googleFlights}`);
    if (candidate.links.outboundGoogleFlights) {
      lines.push(`Outbound one-way: ${candidate.links.outboundGoogleFlights}`);
      lines.push(`Return one-way: ${candidate.links.inboundGoogleFlights}`);
    }
    lines.push(
      `ITA Matrix comparison (enter the route and dates manually): ${candidate.links.itaMatrix}`
    );
    lines.push(`Skiplagged route/date comparison: ${candidate.links.skiplagged}`);
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
  const manualProbe = Boolean(options.forceRun);
  const rawExploreOptions = Number(discoveryResult.exploredCandidates || 0);
  const unverifiedManualDiscovery = (
    manualProbe &&
    rawExploreOptions > 0 &&
    candidates.length === 0 &&
    Number(options.providerStats?.skipped || 0) > 0
  );
  const lines = [
    manualProbe
      ? "Flight Tracker manual probe complete"
      : "Flight Tracker check complete",
    "",
    unverifiedManualDiscovery
      ? `Smoke test succeeded: Explore found ${rawExploreOptions} raw option${rawExploreOptions === 1 ? "" : "s"}, but the manual call cap intentionally left exact verification for a full cycle. This probe did not make a deal/no-deal decision.`
      : dealCandidates.length
      ? `${dealCandidates.length} relative deal${dealCandidates.length === 1 ? "" : "s"} still qualified, but the alert cooldown prevented a duplicate deal alert.`
      : "No new relative deals matched the alert criteria.",
    `Checked ${candidates.length} exactly verified fare candidate${candidates.length === 1 ? "" : "s"}.`
  ];

  if (discoveryResult.laneCount) {
    lines.push(
      `Date-first discovery reviewed ${discoveryResult.exploredCandidates} option${discoveryResult.exploredCandidates === 1 ? "" : "s"} across ${discoveryResult.successfulLaneCount || 0}/${discoveryResult.laneCount || 0} configured date lane${discoveryResult.laneCount === 1 ? "" : "s"}.`
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
    if (manualProbe && options.providerStats.skipped) {
      lines.push(
        "Skipped follow-up searches are expected under this manual probe's total-call cap."
      );
    }
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
  const exploreLeads = (discoveryResult.searches || []).slice(0, 3);
  if (exploreLeads.length) {
    lines.push(
      "",
      "Top Explore leads (indicative, not exactly verified):",
      "These are ranked discovery leads, not deal alerts. Open Google Flights to confirm the current itinerary and price."
    );
    exploreLeads.forEach((search, index) => {
      const dates = `${formatTravelDate(search.departureDate)}${search.returnDate ? ` to ${formatTravelDate(search.returnDate)}` : ""}`;
      const stops = Number(search.discoveryStops);
      const stopSummary = Number.isFinite(stops)
        ? stops === 0
          ? "nonstop"
          : `${stops} stop${stops === 1 ? "" : "s"}`
        : "stops unknown";
      const duration = Number(search.discoveryTotalDurationMinutes);
      const durationSummary = Number.isFinite(duration)
        ? `${Math.floor(duration / 60)}h ${duration % 60}m`
        : "duration unknown";
      const airline = search.discoveryAirline
        ? ` | ${search.discoveryAirline}`
        : "";
      lines.push(
        `${index + 1}. ${search.origin} -> ${search.destination} (${search.destinationName || search.destination}) | ${dates} | indicative ${search.currencyCode} ${search.discoveryPrice} | ${stopSummary} | ${durationSummary}${airline}`
      );
      if (search.discoveryEvidence?.reasons?.length) {
        lines.push(`Why it ranked: ${search.discoveryEvidence.reasons.join("; ")}.`);
      }
      lines.push(`Check exact flights: ${getGoogleFlightsSearchUrl(search)}`);
      if (search.exploreUrl) {
        lines.push(`Open original Explore result: ${search.exploreUrl}`);
      }
    });
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
    const emptyReason = rawExploreOptions > 0
      ? "Explore returned raw options, but none received an exact Google Flights verification in this run."
      : Number(options.providerStats?.successful || 0) > 0
        ? "Provider requests completed successfully but returned no exactly verified fare candidates for the selected searches."
        : "No live candidates were returned. Review the GitHub Actions log for API or route errors.";
    lines.push("", emptyReason);
  }

  lines.push(
    "",
    manualProbe
      ? "This manual probe did not change the scheduled 48-hour cadence."
      : `The next completed automatic check is due in about ${checkIntervalHours} hours.`
  );
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

function evaluateRunCompletion({
  accountAvailable,
  forceRun,
  providerStats
}) {
  const stats = providerStats || {};
  const successfulFareRequests = Object.entries(stats.byKind || {})
    .filter(([kind]) => !kind.startsWith("date-first-"))
    .reduce((total, [, values]) => total + Number(values.successful || 0), 0);

  if (!accountAvailable) {
    return {
      complete: false,
      reason: "SerpApi account balance was unavailable, so the quota reserve failed closed.",
      successfulFareRequests
    };
  }
  if (Number(stats.successful || 0) === 0) {
    return {
      complete: false,
      reason: Number(stats.attempted || 0)
        ? "All attempted Google Flights requests failed."
        : "No Google Flights request could run within the safe quota.",
      successfulFareRequests
    };
  }
  if (!forceRun && Number(stats.skipped || 0) > 0) {
    return {
      complete: false,
      reason: "The safe quota was exhausted before the scheduled search plan completed.",
      successfulFareRequests
    };
  }
  if (!forceRun && successfulFareRequests === 0) {
    return {
      complete: false,
      reason: "Discovery returned, but no exact Google Flights fare request completed.",
      successfulFareRequests
    };
  }
  return { complete: true, reason: null, successfulFareRequests };
}

function finalizeWorkerState(state, proposedState, options = {}) {
  const preserveProgress = Boolean(options.forceRun) ||
    !options.completion?.complete;
  if (!preserveProgress) return proposedState;
  return {
    ...proposedState,
    cursor: Number(state.cursor || 0),
    dateFirstReturnCursor: Number(state.dateFirstReturnCursor || 0),
    dateFirstOneWayCursor: Number(state.dateFirstOneWayCursor || 0),
    constructionEvidence: state.constructionEvidence || {},
    lastCompletedAt: state.lastCompletedAt
  };
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
  let nextConstructionEvidence = { ...(state.constructionEvidence || {}) };
  let nextCoverage = { ...(state.coverageLedger || {}) };
  const accountBeforeResult = await getSerpApiAccount();
  if (!accountBeforeResult.ok) console.warn(accountBeforeResult.error);
  const quota = buildQuotaSnapshot(
    accountBeforeResult.ok ? accountBeforeResult.account : null,
    config.quota?.reserveSearches || 10
  );
  const maximumCallsPerCycle = resolveCallLimit(
    config.quota?.maxCallsPerCycle,
    process.env.MAX_CALLS_PER_CYCLE
  );
  const budgetLimit = accountBeforeResult.ok &&
    quota.spendableThisRun !== null
    ? Math.min(maximumCallsPerCycle, quota.spendableThisRun)
    : 0;
  const callBudget = createCallBudget(maximumCallsPerCycle, budgetLimit);
  const providerStats = {
    attempted: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    byKind: {},
    errors: []
  };
  const canSpend = () => callBudget.canSpend();
  const recordProviderResult = (kind, result) => {
    callBudget.recordAttempt();
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
  const discoveryConfig = {
    ...traveler,
    transitAirportCountries: transferConfig.airportCountries || {},
    ...config.discovery,
    enabled: discoveryEnabled
  };
  const explorePlan = discoveryEnabled
    ? buildDateFirstExploreLanes(
        config.routes.map((route) => ({
          ...traveler,
          transitAirportCountries: transferConfig.airportCountries || {},
          ...route
        })),
        discoveryConfig,
        state
      )
    : {
        lanes: [],
        nextReturnCursor: Number(state.dateFirstReturnCursor || 0),
        nextOneWayCursor: Number(state.dateFirstOneWayCursor || 0)
      };
  const rawExploreCandidates = [];
  let successfulExploreLanes = 0;
  let successfulReturnLanes = 0;
  let successfulOneWayLanes = 0;
  for (const lane of discoveryEnabled ? explorePlan.lanes : []) {
    if (!canSpend()) {
      providerStats.skipped += 1;
      console.warn(
        `Skipping ${lane.laneType} Explore lane to preserve the quota reserve and cycle cap.`
      );
      continue;
    }
    let result;
    try {
      result = await searchGoogleTravelExploreLane(lane);
    } catch (error) {
      result = {
        ok: false,
        error: `Google Travel Explore request failed: ${error.message}`,
        candidates: []
      };
    }
    recordProviderResult(lane.laneType, result);
    if (!result.ok) {
      console.warn(result.error);
      continue;
    }
    successfulExploreLanes += 1;
    if (lane.laneType === "date-first-return") successfulReturnLanes += 1;
    if (lane.laneType === "date-first-one-way") successfulOneWayLanes += 1;
    rawExploreCandidates.push(...result.candidates);
  }
  const rankedExploreCandidates = rankExploreCandidates(
    rawExploreCandidates,
    history,
    knownDestinations,
    {
      marketEvidenceMaxAgeDays:
        config.discovery?.marketEvidenceMaxAgeDays || 30
    }
  );
  const selectedExploreCandidates = selectExploreCandidates(
    rankedExploreCandidates,
    Number(config.discovery?.verifyCount || 3)
  );
  const discoveryResult = {
    ok: !discoveryEnabled || successfulExploreLanes > 0,
    searches: selectedExploreCandidates.map(buildExploreVerificationSearch),
    exploredCandidates: rawExploreCandidates.length,
    laneCount: explorePlan.lanes.length,
    successfulLaneCount: successfulExploreLanes,
    laneDates: explorePlan.lanes.map((lane) => (
      lane.returnDate
        ? `${lane.departureDate}/${lane.returnDate}`
        : `${lane.departureDate} one-way`
    )),
    nextReturnCursor: successfulReturnLanes === explorePlan.lanes.filter(
      (lane) => lane.laneType === "date-first-return"
    ).length
      ? explorePlan.nextReturnCursor
      : Number(state.dateFirstReturnCursor || 0),
    nextOneWayCursor: successfulOneWayLanes === explorePlan.lanes.filter(
      (lane) => lane.laneType === "date-first-one-way"
    ).length
      ? explorePlan.nextOneWayCursor
      : Number(state.dateFirstOneWayCursor || 0)
  };
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
      "Date-first Google Travel Explore, verified via Google Flights"
    );
    candidates.push(...searchCandidates);
    newEntries.push(...searchCandidates.map((candidate) => candidate.entry));
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

  const protectedRoundTripCandidates = candidates
    .filter((candidate) => (
      candidate.entry.tripType === "round-trip" &&
      candidate.entry.itineraryProtection === "protected"
    ))
    .sort((left, right) => (
      right.value.score - left.value.score ||
      left.entry.price - right.entry.price
    ));
  const fallbackReferenceSearch = searches.find((search) => search.tripType === "round-trip") ||
    allSearches.find((search) => (
      search.tripType === "round-trip" &&
      Date.parse(`${search.departureDate}T00:00:00Z`) > Date.now()
    ));
  const constructionReferences = protectedRoundTripCandidates.length
    ? protectedRoundTripCandidates.slice(0, 5).map((candidate) => ({
        search: candidate.search,
        candidate
      }))
    : fallbackReferenceSearch
      ? [{ search: fallbackReferenceSearch, candidate: null }]
      : [];
  const constructionPlans = constructionReferences.map(({ search, candidate }) => ({
    ...buildConstructionLane(
      {
        ...traveler,
        ...(config.constructions || {}),
        splitTickets: config.splitTickets,
        enabled: constructionsEnabled
      },
      state,
      search,
      {
        history: [...history, ...newEntries],
        referencePrice: candidate?.entry.price,
        maximumEvidenceAgeDays:
          config.constructions?.maximumEvidenceAgeDays || 45
      }
    ),
    referenceSearch: search,
    referenceCandidate: candidate
  }));
  const constructionLane = constructionPlans
    .filter((plan) => plan.definition)
    .sort((left, right) => (
      Number(right.evidence?.score || 0) - Number(left.evidence?.score || 0)
    ))[0] || {
      definition: null,
      searches: [],
      ranking: [],
      referenceSearch: fallbackReferenceSearch,
      referenceCandidate: null
    };
  const referenceSearch = constructionLane.referenceSearch;
  let constructionWasAttempted = false;
  if (constructionLane.definition?.type === "split-one-ways") {
    const [outboundSearch, inboundSearch] = constructionLane.searches;
    const outboundResult = await trackedSearch(outboundSearch, undefined, "split-outbound");
    const inboundResult = await trackedSearch(inboundSearch, undefined, "split-inbound");
    constructionWasAttempted = !outboundResult.skipped || !inboundResult.skipped;
    splitTicketsChecked += 1;
    if (!outboundResult.ok) console.warn(outboundResult.error);
    if (!inboundResult.ok) console.warn(inboundResult.error);
    if (outboundResult.ok && inboundResult.ok) {
      const outboundOffer = [...outboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      const inboundOffer = [...inboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      if (outboundOffer) {
        newEntries.push(summarizeCandidate(
          outboundSearch,
          outboundOffer,
          history
        ).entry);
      }
      if (inboundOffer) {
        newEntries.push(summarizeCandidate(
          inboundSearch,
          inboundOffer,
          history
        ).entry);
      }
      if (outboundOffer && inboundOffer && constructionLane.referenceCandidate) {
        splitComparisons.push({
          origin: referenceSearch.origin,
          destination: referenceSearch.destination,
          departureDate: referenceSearch.departureDate,
          returnDate: referenceSearch.returnDate,
          currency: referenceSearch.currencyCode,
          splitPrice: outboundOffer.price + inboundOffer.price,
          roundTripPrice: constructionLane.referenceCandidate.entry.price
        });
        const splitCandidate = summarizeSplitTicketCandidate(
          referenceSearch,
          outboundOffer,
          inboundOffer,
          constructionLane.referenceCandidate,
          history,
          config.splitTickets
        );
        if (splitCandidate) {
          candidates.push(splitCandidate);
          newEntries.push(splitCandidate.entry);
        }
      }
    }
    constructionSummary =
      `evidence selected separate one-ways for ${referenceSearch.origin}-${referenceSearch.destination}`;
  } else
  if (constructionLane.definition?.type === "nearby-airports") {
    const constructionSearch = constructionLane.searches[0];
    const result = await trackedSearch(constructionSearch, undefined, "construction");
    constructionWasAttempted = !result.skipped;
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
    constructionSummary =
      `evidence selected ${constructionLane.definition.label} as a grouped nearby-airport search`;
  } else if (constructionLane.definition?.type === "open-jaw") {
    const [outboundSearch, inboundSearch] = constructionLane.searches;
    const outboundResult = await trackedSearch(outboundSearch, undefined, "construction");
    const inboundResult = await trackedSearch(inboundSearch, undefined, "construction");
    constructionWasAttempted = !outboundResult.skipped || !inboundResult.skipped;
    if (outboundResult.ok && inboundResult.ok) {
      const outboundOffer = [...outboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      const inboundOffer = [...inboundResult.offers]
        .sort((a, b) => a.price - b.price)
        .find((offer) => offer.itineraryProtection === "protected");
      if (outboundOffer && inboundOffer) {
        newEntries.push(summarizeCandidate(
          outboundSearch,
          outboundOffer,
          history
        ).entry);
        newEntries.push(summarizeCandidate(
          inboundSearch,
          inboundOffer,
          history
        ).entry);
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
    const surfaceTransferCost = Number(
      constructionLane.definition.surfaceTransferCost
    );
    const hasKnownSurfaceTransferCost = (
      constructionLane.definition.surfaceTransferCost !== null &&
      constructionLane.definition.surfaceTransferCost !== undefined &&
      constructionLane.definition.surfaceTransferCost !== "" &&
      Number.isFinite(surfaceTransferCost) &&
      surfaceTransferCost >= 0
    );
    constructionSummary = hasKnownSurfaceTransferCost
      ? `evidence selected ${constructionLane.definition.label} as two open-jaw one-way fares; ${referenceSearch.currencyCode} ${surfaceTransferCost} surface transport is included`
      : `evidence selected ${constructionLane.definition.label} as two open-jaw one-way fares; surface transport cost is unknown, so normal alerts are suppressed`;
  }
  if (constructionLane.definition && constructionWasAttempted) {
    nextConstructionEvidence[constructionLane.definition.id] = {
      lastSelectedAt: runId,
      score: constructionLane.evidence?.score ?? null,
      expectedSavings: constructionLane.evidence?.expectedSavings ?? null,
      expectedSavingsPercent: constructionLane.evidence?.expectedSavingsPercent ?? null,
      evidence: constructionLane.evidence?.evidence || []
    };
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
    const effectiveSavings = transferSavings(
      effectivePrice,
      candidate.offer.protectedComparablePrice
    );
    const assessedOffer = {
      ...candidate.offer,
      baseFare: candidate.offer.price,
      price: effectivePrice,
      transferSavings: effectiveSavings.amount,
      transferSavingsPercent: effectiveSavings.percent,
      transferSavingsQualifies: null,
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
  const proposedState = {
    ...state,
    cursor: nextCursor,
    constructionCursor: Number(state.constructionCursor || 0),
    constructionEvidence: nextConstructionEvidence,
    totalSearches: allSearches.length,
    checkedThisRun: searches.length,
    ...updateDateFirstExploreState(state, discoveryResult, false),
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
    lastCompletedAt: runId,
    alerts
  };
  const completion = evaluateRunCompletion({
    accountAvailable: accountBeforeResult.ok &&
      quota.spendableThisRun !== null,
    forceRun,
    providerStats
  });
  const nextState = finalizeWorkerState(state, proposedState, {
    completion,
    forceRun
  });

  if (!completion.complete) {
    const message = [
      "Flight Tracker check incomplete",
      "",
      completion.reason,
      "No no-deal conclusion was recorded and the tracker will retry on its next workflow wake-up.",
      ...providerStats.errors.slice(0, 3).map((error) => `Error: ${error}`)
    ].join("\n");
    console.error(message);
    writeJson(STATE_PATH, nextState);
    await deliverNotifications(message);
    throw new Error(completion.reason);
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
      ? ", including date-first discovery"
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
        checkIntervalHours,
        forceRun
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
  buildExploreVerificationSearch,
  buildSearches,
  buildSplitTicketSearches,
  combineRoundTripOffers,
  evaluateRunCompletion,
  explainNoDeal,
  finalizeWorkerState,
  formatAlert,
  formatNoDealSummary,
  formatHistoryAnalysis,
  isFareDeal,
  main,
  mapSerpApiOffer,
  searchGoogleTravelExploreLane,
  selectCandidateOffers,
  selectSearches,
  shouldAlert,
  summarizeCandidate,
  summarizeOpenJawCandidate,
  summarizeSplitTicketCandidate,
  verifyRoundTripOffer
};
