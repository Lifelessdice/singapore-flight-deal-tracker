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
      passportNationality: route.passportNationality || "",
      passportCountryCode: route.passportCountryCode || "",
      carryOnBags: Math.max(0, Number(route.carryOnBags) || 0),
      checkedBags: Math.max(0, Number(route.checkedBags) || 0),
      baggageProfile: route.baggageProfile || "",
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
    departureTime: flight.departure_airport?.time || "",
    arrivalAirport: flight.arrival_airport?.id || "",
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
  const hasSelfTransfer = extensions.some((extension) => (
    /separate tickets|self[- ]transfer/i.test(extension)
  ));

  return {
    source: "Google Flights via SerpApi",
    price: Number(offer.price),
    currency: search.currencyCode,
    itineraries: offer.type || search.tripType,
    totalDurationMinutes: Number(offer.total_duration) || 0,
    maxStops: layovers.length,
    airlines: [...new Set(flights.map((flight) => flight.airline).filter(Boolean))],
    flights,
    layovers,
    maxLayoverMinutes: layovers.reduce(
      (longest, layover) => Math.max(longest, layover.durationMinutes),
      0
    ),
    hasAirportChange,
    hasSelfTransfer,
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
  const returnOffer = [...result.offers].sort((a, b) => a.price - b.price)[0];
  if (!returnOffer) {
    return { ok: false, error: "No compatible return passed the duration and stop limits." };
  }
  if (returnOffer.hasSelfTransfer || returnOffer.hasAirportChange) {
    return {
      ok: false,
      error: "The compatible return requires a self-transfer or airport change."
    };
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
    baggageNotes: [...new Set([
      ...(outboundOffer.baggageNotes || []),
      ...(returnOffer.baggageNotes || [])
    ])],
    bookingToken: returnOffer.bookingToken,
    verifiedRoundTrip: true
  };
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
    returnVerified: Boolean(offer.verifiedRoundTrip),
    notes: `${offer.airlines.join(", ") || "carrier unknown"} via ${offer.source}, ${durationDescription}, maximum ${offer.maxStops} stop${offer.maxStops === 1 ? "" : "s"} per direction, ${baggageDescription}`,
    googlePriceInsights: offer.googlePriceInsights
  };
  const routeHistory = history.filter((item) => (
    item.origin === search.origin &&
    item.destination === search.destination &&
    (item.tripType || (item.returnDate ? "round-trip" : "one-way")) === search.tripType &&
    hasSameBaggageProfile(item, search) &&
    (item.searchStrategy || "standard") === (search.searchStrategy || "standard")
  ));
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

  return {
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
  return candidate;
}

function shouldAlert(candidate) {
  return ["strong-deal", "good-deal"].includes(candidate.insights.level);
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
    if (entry.tripType === "round-trip" && entry.searchStrategy !== "split-one-ways") {
      lines.push(
        entry.returnVerified
          ? "Itinerary check: both outbound and return passed the configured duration, stop, airport-change, and self-transfer checks."
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
    cheapest.forEach(({ entry, insights, links }, index) => {
      const dates = `${formatTravelDate(entry.departureDate)}${entry.returnDate ? ` to ${formatTravelDate(entry.returnDate)}` : ""}`;
      lines.push(`${index + 1}. ${entry.origin} -> ${entry.destination} | ${dates} | ${entry.currency} ${entry.price} ${entry.tripType}`);
      if (entry.notes) lines.push(`Flight: ${entry.notes}.`);
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

async function sendResend(message, subject) {
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
      subject,
      text: message
    })
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Resend alert failed: ${response.status} ${responseBody}`);
  }

  const sent = JSON.parse(responseBody);
  if (!sent.id) {
    throw new Error("Resend accepted the request without returning an email ID.");
  }
  const maskedRecipients = String(process.env.ALERT_EMAIL_TO)
    .split(",")
    .map((recipient) => {
      const [localPart, domain] = recipient.trim().split("@");
      return domain ? `${localPart.slice(0, 2)}***@${domain}` : "***";
    });
  console.log(
    `Resend accepted email ${sent.id} for ${maskedRecipients.join(", ")}; checking delivery.`
  );

  let lastEvent = "sent";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusResponse = await fetch(`https://api.resend.com/emails/${sent.id}`, {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      }
    });
    if (!statusResponse.ok) continue;
    const status = await statusResponse.json();
    lastEvent = String(status.last_event || lastEvent).toLowerCase();
    if (lastEvent === "delivered") {
      const domains = (status.to || [process.env.ALERT_EMAIL_TO])
        .map((recipient) => String(recipient).split("@").at(-1))
        .filter(Boolean);
      console.log(
        `Resend confirmed email delivery to ${[...new Set(domains)].join(", ")}.`
      );
      return;
    }
    if (["bounced", "failed", "suppressed", "complained"].includes(lastEvent)) {
      throw new Error(`Resend email delivery ended with status: ${lastEvent}.`);
    }
  }

  if (String(process.env.REQUIRE_EMAIL_DELIVERY).toLowerCase() === "true") {
    throw new Error(
      `Resend did not confirm recipient-server delivery within 120 seconds; last event: ${lastEvent}; email ID: ${sent.id}.`
    );
  }
  console.warn(`Resend accepted the email; latest delivery event: ${lastEvent}.`);
}

async function deliverNotifications(message, subject) {
  const deliveryTasks = [];
  if (process.env.DISCORD_WEBHOOK_URL) deliveryTasks.push(sendDiscord(message));
  if (
    process.env.RESEND_API_KEY &&
    process.env.ALERT_EMAIL_TO &&
    process.env.ALERT_EMAIL_FROM
  ) {
    deliveryTasks.push(sendResend(message, subject));
  }
  if (!deliveryTasks.length) {
    if (String(process.env.REQUIRE_NOTIFICATION_CHANNEL).toLowerCase() === "true") {
      throw new Error("No notification channel is fully configured.");
    }
    console.warn("No local notification channel configured; message was logged only.");
    return;
  }
  const deliveries = await Promise.allSettled(deliveryTasks);
  const deliveryFailures = deliveries
    .filter((delivery) => delivery.status === "rejected")
    .map((delivery) => delivery.reason?.message || String(delivery.reason));
  if (deliveryFailures.length) {
    throw new Error(`Notification delivery failed: ${deliveryFailures.join("; ")}`);
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
  const maxSearchesPerRun = Math.min(
    20,
    Number(process.env.MAX_SEARCHES_PER_RUN || config.maxSearchesPerRun || 80)
  );
  const discoveryEnabled = Boolean(config.discovery?.enabled)
    && String(process.env.DISCOVERY_ENABLED ?? "true").toLowerCase() !== "false";
  const normalizedCursor = allSearches.length ? Number(state.cursor || 0) % allSearches.length : 0;
  const searches = selectSearches(allSearches, history, {
    maxSearches: maxSearchesPerRun,
    horizonDays: config.exactSearchHorizonDays,
    oneWayShare: config.oneWaySearchShare
  });
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
  let splitTicketsChecked = 0;
  let returnVerificationsAttempted = 0;
  let returnVerificationsPassed = 0;
  const splitComparisons = [];
  const providerStats = {
    attempted: 0,
    successful: 0,
    failed: 0,
    errors: []
  };
  const trackedSearch = async (search, options) => {
    providerStats.attempted += 1;
    const result = await searchSerpApi(search, options);
    if (result.ok) {
      providerStats.successful += 1;
    } else {
      providerStats.failed += 1;
      providerStats.errors.push(result.error);
    }
    return result;
  };

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
      const result = await trackedSearch(search);
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
        candidate.entry.returnDate === roundTripSearch.returnDate
      ));
      if (!roundTripCandidate) continue;
      const [outboundSearch, inboundSearch] = buildSplitTicketSearches(roundTripSearch);
      const outboundResult = await trackedSearch(outboundSearch);
      const inboundResult = await trackedSearch(inboundSearch);
      splitTicketsChecked += 1;
      if (!outboundResult.ok || !inboundResult.ok) {
        if (!outboundResult.ok) console.warn(outboundResult.error);
        if (!inboundResult.ok) console.warn(inboundResult.error);
        continue;
      }
      const outboundOffer = outboundResult.offers.sort((a, b) => a.price - b.price)[0];
      const inboundOffer = inboundResult.offers.sort((a, b) => a.price - b.price)[0];
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
    const result = await trackedSearch(search);
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

  const maxReturnVerifications = Math.max(
    0,
    Number(config.returnVerification?.maxPerRun || 3)
  );
  for (const candidate of [...candidates]) {
    if (
      !shouldAlert(candidate) ||
      candidate.entry.tripType !== "round-trip" ||
      candidate.entry.searchStrategy === "split-one-ways"
    ) {
      continue;
    }
    if (returnVerificationsAttempted >= maxReturnVerifications) {
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

  if (providerStats.attempted > 0 && providerStats.successful === 0) {
    const message = [
      "Flight Tracker check incomplete",
      "",
      `All ${providerStats.attempted} Google Flights requests failed.`,
      "No no-deal conclusion was recorded and the tracker will retry on its next workflow wake-up.",
      ...providerStats.errors.slice(0, 3).map((error) => `Error: ${error}`)
    ].join("\n");
    console.error(message);
    await deliverNotifications(message, "Flight Tracker check incomplete");
    throw new Error("All Google Flights provider requests failed.");
  }

  const nextHistory = [...history, ...newEntries].slice(-2000);
  writeJson(HISTORY_PATH, nextHistory);
  const cooldownHours = Number(config.alertCooldownHours || 168);
  const alerts = state.alerts || {};
  const dealCandidates = candidates.filter(shouldAlert);
  const alertCandidates = dealCandidates
    .filter((candidate) => isFreshAlert(candidate, alerts, cooldownHours));

  if (alertCandidates.length) {
    const message = formatAlert(alertCandidates);
    console.log(message);
    await deliverNotifications(message, "Flight deal candidates found");
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
    if (config.notifyOnNoDeals !== false) {
      const summary = formatNoDealSummary(candidates, {
        discoveryResult,
        dealCandidates,
        splitTicketsChecked,
        splitComparisons,
        returnVerificationsAttempted,
        returnVerificationsPassed,
        providerStats,
        checkIntervalHours
      });
      console.log(summary);
      await deliverNotifications(summary, "Flight Tracker check complete: no new deals");
    }
  }

  writeJson(STATE_PATH, {
    cursor: nextCursor,
    totalSearches: allSearches.length,
    checkedThisRun: searches.length,
    discoveryMonthCursor: discoveryResult.nextMonthCursor,
    exploredMonth: discoveryResult.exploredMonth || null,
    exploredCandidates: discoveryResult.exploredCandidates || 0,
    flexibleDealsChecked: discoveryResult.ok ? discoveryResult.searches.length : 0,
    splitTicketsChecked,
    splitComparisons,
    returnVerificationsAttempted,
    returnVerificationsPassed,
    providerStats,
    lastCompletedAt: new Date().toISOString(),
    alerts
  });
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
  formatNoDealSummary,
  formatHistoryAnalysis,
  main,
  selectSearches,
  summarizeSplitTicketCandidate
};
