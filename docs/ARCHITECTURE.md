# Architecture

## Data flow

GitHub Actions wakes daily. The worker enforces a roughly 48-hour successful-run
interval, reads configuration/history/state, gets a free SerpApi Account API
snapshot, builds a quota-safe work plan, runs fare lanes, scores candidates,
persists results, and sends Discord output.

Automated prices come from SerpApi's Google Travel Explore and Google Flights
engines. ITA Matrix and Skiplagged are verification links only; the worker does
not scrape either site.

## Search lanes

- `explore`: one rotating month for destination discovery.
- `explore-verify`: exact Google Flights checks for selected Explore results.
- `split-outbound` / `split-inbound`: compare a normal return with two one ways.
- `exact`: prioritized configured route/date searches.
- `construction`: one rotating nearby-airport group or two-leg open jaw.
- `return-verify`: follow Google's departure token before a normal return alerts.

All billable lanes pass through one call guard. The production maximum is 14
attempts per completed cycle and a provider-account reserve of 10 searches is
protected. The normal allocation reserves two calls for construction and one for
return verification, reducing routine exact work from eight slots to five.

## Candidate decisions

`fare-insights.js` determines whether a fare is a relative deal. It compares
closely matched independent observation days using median/MAD and consumes
Google's external typical range and online history when present.

`tracker-product.js` adds a 0-100 traveler-value score and `BOOK`, `VERIFY`,
`WATCH`, or `SKIP` action. It rewards anomaly strength, external evidence,
student-target fit, and weekend timing. It penalizes long travel, stops,
overnights, separate tickets, open-jaw transfers, one-way incompleteness, and
unconfirmed baggage. This score ranks usability; it does not make a non-relative
price into a deal.

## Alternative constructions

Nearby-airport searches send comma-separated Google Flights airport groups, such
as `BKK,DMK`, and store the actual endpoint returned by the itinerary. Open jaws
price two independent one-way flights, such as `SIN-KUL` and `PEN-SIN`.
Surface transport is not included, so open-jaw notifications disclose that cost
and must not be interpreted as total-trip cost.

JHB positioning is intentionally excluded. Singapore-Malaysia border time and
ground cost need a dedicated model before those fares can be compared honestly.

## State

`data/worker-state.json` contains:

- queue and construction cursors;
- alert cooldowns;
- Explore rotation and split/construction summaries;
- per-run provider counts by request kind;
- SerpApi before/after quota snapshots and provider usage delta;
- exact-search coverage attempts, successes, offers, and errors;
- official promotion-page fingerprints;
- `lastRunAt` and the scheduled-only `lastCompletedAt`.

Fare history is separate in `data/fare-history.json`. Coverage is based on request
events, including successful empty responses, rather than inferred from fares.

State is persisted before Discord delivery. Therefore notification failure cannot
erase credits already spent. Alert cooldowns are persisted only after Discord
accepts the alert, allowing a failed alert to retry.

Promotion changes must produce the same new relevant-content fingerprint on two
consecutive checks before Discord is notified. This filters dynamic page chrome
and region-dependent rendering.

## Provider limitations

Google's first return response is normally an outbound selection; a
`departure_token` continuation resolves a compatible return. Grouped and open-jaw
queries may not include statistical price insights, so they build
strategy-specific history and never borrow confidence from unrelated standard
searches. Fare baggage text can be incomplete. Booking, entry, and transit rules
must always be verified directly.
