# Deal criteria

This tracker is optimized for one economy passenger based in Singapore through
December 2026. It looks for short student trips, not merely the lowest displayed
number.

## Search scope

| Rule | Current setting |
| --- | --- |
| Origin | Singapore Changi (`SIN`) |
| Passengers | 1 adult |
| Cabin | Economy |
| Travel window | August through December 2026 |
| Trip length | 2 to 4 days |
| Dates | Weekends are seeded heavily; weekday departures are also eligible |
| Ticket types | Round trips and one ways |
| Stops | At most 1 |
| Total itinerary duration | At most 15 hours |
| Listed destinations | 14 nearby Asian airports |
| Open-ended discovery | Google Travel Explore searches every configured month |
| Discovery verification | The three most useful Explore results are re-priced as exact Google Flights searches |

The listed `USD 75` one-way and `USD 160` round-trip figures are useful targets.
They do not, by themselves, make a fare a deal. The `USD 300` Explore limit is a
search ceiling that prevents wasting API calls on obviously unsuitable options.

## What earns an alert

A fare can qualify through local history, Google's independent market baseline,
or an explicit target:

1. **Local relative deal:** compare the new fare with at least three prior
   observations for the same origin, destination, and trip type. When enough
   observations exist, compare only fares from the same booking lead-time bucket.
2. **Good deal:** at least 10% below the prior median and statistically unusual
   under a median absolute deviation test.
3. **Strong deal:** at least 20% below the prior median with a robust z-score of
   `-2` or lower.
4. **Google market deal:** below the low end of Google's typical-price range, or
   sufficiently below its midpoint when Google labels the fare low.
5. **Target hit:** at or below a configured target. The alert still shows the
   relative evidence so an arbitrary target is not mistaken for a market anomaly.

The current fare is excluded from its own baseline. This matters because including
a large drop in the median and average weakens the apparent discount. Median
absolute deviation is used instead of standard deviation because a small fare
history often contains large seasonal outliers.

Alerts show the prior median and average, percentage discount, estimated savings,
Google's typical range when available, baseline scope, confidence, dates, duration,
stops, and links for verification. A route is muted for seven days after an alert
unless a lower fare appears.

## Discovery strategy

Each eligible 48-hour run rotates through August to December using Google Travel
Explore's weekend-duration search. It keeps only real 2-to-4-day itineraries within
the stop, duration, and price limits. It then verifies two of the cheapest known
destinations plus one promising destination outside the fixed list. Exact
verification is important because discovery prices can be stale or can represent
a different itinerary than the one ultimately booked.

The normal queue also rotates exact date, destination, and one-way searches. At
the current limits, the design stays below the SerpApi free-tier allowance during
a normal month while gradually building comparable route history.

## Research decisions

### Adopted

- Google's own Flight Deals method uses a historical median adjusted for route,
  season, trip length, cabin, and filters. Google describes savings deals as at
  least 20% below typical, which supports this tracker's strong-deal threshold.
- Google Travel Explore is used for open-ended destination discovery and short
  weekend searches.
- Google Flights' date grid, price graph, nearby-airport checks, and Any Dates
  alerts remain useful manual confirmation tools.
- ITA Matrix is used for routing, connection, airport-change, and itinerary-length
  validation.
- One-way searches can expose asymmetric pricing and can be combined manually when
  separate tickets are genuinely cheaper.
- Airline-direct booking is preferred after comparison because schedule changes
  are usually easier to resolve than with an online travel agency.

### Tested but rejected

- A documented Google Flights Deals API was tested live, but its trip-length
  controls returned 6-to-9-day trips when 2-to-4-day trips were requested. The
  production worker uses Google Travel Explore plus exact verification instead.
- Several open-source trackers alert after only a 5% drop or a fixed dollar change
  from the immediately previous check. That is too sensitive for this use case and
  ignores normal fare volatility.
- Regression or machine-learning price prediction is not justified with the
  project's small private dataset. A robust statistical detector is more
  explainable and less likely to overfit.
- Cookies, incognito mode, and a universal "buy on Tuesday" rule are not treated as
  pricing strategies. There is no reliable evidence that they create repeatable
  savings.
- Tight self-transfers are not automated. Separate tickets can fail without
  protection when the first flight is late, and checked baggage may need to be
  reclaimed.
- Hidden-city fares are verification candidates only. They should never be used
  with checked baggage or on an itinerary where a later segment must be flown.

## Details still needed

Two personal details materially change the definition of a usable steal:

1. Passport nationality, so visa and transit feasibility can be evaluated.
2. Baggage requirement: personal item only, cabin bag, or checked bag.

Until these are supplied, alerts do not claim that a destination is visa-feasible
and displayed fares may not include the bag needed for the trip.

## Primary references

- Google Flights best-fare tools:
  <https://support.google.com/travel/answer/7664728>
- Google Flights price tracking:
  <https://support.google.com/travel/answer/6235879>
- Google Flight Deals methodology:
  <https://support.google.com/travel/answer/16497283>
- Google Flights bag-fee filter:
  <https://support.google.com/travel/answer/9074247>
- ITA Matrix routing codes:
  <https://support.google.com/faqs/faq/1739451>
- ITA Matrix sorting and advisories:
  <https://support.google.com/faqs/answer/2736487>
- SerpApi Google Travel Explore parameters:
  <https://serpapi.com/google-travel-explore-api>
- FlightClaw:
  <https://github.com/jackculpan/flightclaw>
- Flight Finder:
  <https://github.com/affromero/flight-finder>
- Flight Analysis:
  <https://github.com/celebi-pkg/flight-analysis>

