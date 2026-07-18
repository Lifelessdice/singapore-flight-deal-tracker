# Deal criteria

This tracker is optimized for one economy passenger based in Singapore through
December 2026. It looks for short student trips, not merely the lowest displayed
number.

## Search scope

| Rule | Current setting |
| --- | --- |
| Origin | Singapore Changi (`SIN`) |
| Passengers | 1 adult |
| Passport | Switzerland (`CHE`); alerts still require current entry/transit verification |
| Baggage | One free under-seat personal-item backpack; no overhead-bin or checked bag |
| Cabin | Economy |
| Travel window | August through December 2026 |
| Trip length | 2 to 4 days |
| Dates | Weekends are seeded heavily; weekday departures are also eligible |
| Ticket types | Round trips and one ways |
| Stops | At most 1 |
| Duration | At most 15 hours per direction |
| Listed destinations | 14 nearby Asian airports plus rotating grouped-airport searches |
| Open-ended discovery | Google Travel Explore searches every configured month |
| Discovery verification | The three most useful Explore results are re-priced as exact Google Flights searches |
| Alternative construction | Rotating nearby-airport groups and open-jaw one-way pairs |

The listed `USD 75` one-way and `USD 160` round-trip figures are useful targets.
They do not, by themselves, make a fare a deal. The `USD 300` Explore limit is a
search ceiling that prevents wasting API calls on obviously unsuitable options.
Exact Google Flights verification requests zero carry-on bags because the
backpack is assumed to fit the airline's free personal-item allowance under the
seat. Airline personal-item size and weight rules still need confirmation before
booking.

## What earns an alert

A fare can qualify through closely matched independent history or Google's
online market statistics:

1. **Local relative deal:** compare the new fare with at least three prior
   observation days matching origin, destination, trip type, booking lead-time
   bucket, travel month, trip length, weekend pattern, baggage, and ticket
   strategy. Repeated checks on the same day count once.
2. **Good deal:** at least 10% below the prior median and statistically unusual
   under a median absolute deviation test with a 5% dispersion floor.
3. **Strong deal:** at least 20% below the prior median with a robust z-score of
   `-2` or lower.
4. **Google market deal:** below the low end of Google's typical-price range, or
   sufficiently below its midpoint when Google labels the fare low. At least
   seven points from Google's online price history can provide a second external
   anomaly test.
5. **Target hit:** at or below a configured target is useful context, but never
   earns an alert without relative evidence.

The current fare is excluded from its own baseline. This matters because including
a large drop in the median and average weakens the apparent discount. Median
absolute deviation is used instead of standard deviation because a small fare
history often contains large seasonal outliers.

Confidence does not increase merely because this tracker collected more samples.
One Google external baseline earns medium confidence; both the similar-flight
typical range and online price history earn high confidence. Local-only signals
remain low confidence. Alerts show the evidence basis, prior median and average,
percentage discount, estimated savings, Google's statistics, dates, per-direction
duration, stops, and links. Cooldowns are specific to route, dates, trip type, and
ticket strategy.

## Discovery strategy

Each eligible 48-hour run rotates through August to December using Google Travel
Explore's weekend-duration search. It keeps only real 2-to-4-day itineraries within
the stop, duration, and price limits. It then verifies two of the cheapest known
destinations plus one promising destination outside the fixed list. Exact
verification is important because discovery prices can be stale or can represent
a different itinerary than the one ultimately booked.

SerpApi's first round-trip response describes the outbound selection. Before a
round-trip price signal can alert, the worker follows its `departure_token` and
requires a compatible return to pass the stop and duration rules. At most one
such call is reserved per cycle, and unverified returns are suppressed.
Self-transfers and airport changes continue to a separate late policy/risk check.

The normal queue prioritizes routes that have been checked least recently, then
rotates exact dates inside a 90-day booking horizon. Construction and return
verification reserves leave up to five routine exact slots in a full scheduled
cycle. Coverage is recorded from actual requests, including successful searches
that return no offers.

For the cheapest verified flexible trip, the worker also prices the outbound and
return as independent one-way tickets. The split option qualifies only when it
saves at least both `USD 15` and 10% against the exact same-run return fare.
Savings of at least `USD 30` and 20% form a strong deal. Because the tickets are
for opposite travel days rather than a self-connection, a delayed outbound does
not create a missed-connection risk on the return.

One rotating construction lane also checks grouped destination airports such as
`BKK,DMK`, or prices an open jaw such as `SIN-KUL` plus `PEN-SIN`. These strategies
have separate history and confidence. Open-jaw ground transport is not included,
so it is disclosed as a material tradeoff and cannot raise statistical confidence.

The traveler-value score ranks already observed fares from 0 to 100 and emits a
`BOOK`, `VERIFY`, `WATCH`, or `SKIP` action. It rewards relative anomaly strength,
external evidence, target fit, and weekend timing, while penalizing duration,
stops, overnights, incomplete one ways, separate bookings, transfers, and
unconfirmed baggage. The score cannot turn a mere target hit into a deal.

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
- Skyscanner's Everywhere and whole-month workflow supports destination-first,
  date-flexible discovery followed by exact verification.
- KAYAK Explore's budget, duration, and nearby-airport controls support ranking
  total trip fit rather than airfare alone.
- Going and Secret Flying emphasize abnormal price drops and mistake fares. The
  tracker mirrors the anomaly concept while requiring reproducible price evidence
  and a live Google Flights link.
- FlightConnections' route-map model supports periodic coverage checks for direct
  destinations that may not yet be in the fixed list.
- Kiwi-style ticket combinations inspired the separately priced outbound/return
  comparison, but not unprotected tight connections.

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
- Self-transfers remain lower priority than protected itineraries. They require a
  configurable savings premium, sufficient connection time, fresh sourced
  passport policy, known immigration/baggage/terminal handling, and accounted
  extra costs. Unknown cases are manual review; paid-visa or short connections
  are rejected.
- Johor Bahru positioning is not automatically ranked yet. Border queues and
  ground transfers can consume a large share of a 2-to-4-day trip, so airfare
  savings would need a separate total-cost and time model.
- Hidden-city fares are verification candidates only. They should never be used
  with checked baggage or on an itinerary where a later segment must be flown.

## Search frequency and quota

GitHub Actions wakes once per day, but the worker only performs a scheduled fare
cycle after approximately 48 hours. Every billable request uses one global guard
with a maximum of 14 attempts per cycle. The normal maximum allocation is one
Explore request, three Explore verifications, two split-ticket requests, five
exact searches, two construction requests, and one return verification. The
worker reads the free SerpApi Account API before and after each run and protects a
10-credit reserve. Manual smoke tests disable Explore and constructions, default
to one exact search, and do not change scheduled cadence.

An acceptable self-transfer means the maintained evidence passed the configured
checks; it is not a guarantee of admission. Entry and transit rules can change
and must be rechecked for the Switzerland (`CHE`) passport before booking.
Fare-history comparisons also require the same carry-on and checked-bag counts,
so changing baggage assumptions cannot manufacture an artificial price drop.

## Transit policy and connection rules

Transit checks happen only after fare, route, stop, duration, and relative-deal
checks. Protected fares use a `protected` baseline. Self-transfers and airport
changes use separate history strategies and cannot depress that baseline.

The conservative connection defaults are 240 minutes for a confirmed
same-airport transfer, 360 minutes when immigration, baggage recheck, or terminal
uncertainty applies, and 480 minutes for an airport change. A transfer also needs
at least 15% and `USD 40` savings versus a comparable protected itinerary. Extra
authorization, baggage, ground transport, and overnight costs are included before
the final savings and deal check.

The current `manual-static` policy provider requires source metadata,
`lastVerifiedAt`, passport validity, onward-travel requirements, visa and
authorization fields, immigration permission, and terminal feasibility. Rules
older than 30 days become manual review. `automation/transit-policies.example.json`
documents the schema; its placeholder is not a production rule. The actual
`passportExpiresOn` is intentionally unset until the traveler provides it, so
passport-validity-dependent transfer rules remain manual review.

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
- SerpApi Google Flights return tokens, price insights, and deep search:
  <https://serpapi.com/google-flights-api>
- SerpApi Account API:
  <https://serpapi.com/account-api>
- IATA Timatic travel-documentation services:
  <https://www.iata.org/en/services/compliance/timatic/travel-documentation/>
- FlightClaw:
  <https://github.com/jackculpan/flightclaw>
- Flight Finder:
  <https://github.com/affromero/flight-finder>
- Flight Analysis:
  <https://github.com/celebi-pkg/flight-analysis>
- Skyscanner flexible dates and Everywhere:
  <https://help.skyscanner.net/hc/en-gb/articles/201150942-How-do-I-find-the-best-prices>
- KAYAK Explore:
  <https://www.kayak.com/news/where-to-fly-on-your-budget-kayak-explore/>
- Going deal alerts:
  <https://www.going.com/>
- Secret Flying:
  <https://www.secretflying.com/faq/>
- FlightConnections:
  <https://www.flightconnections.com/>
