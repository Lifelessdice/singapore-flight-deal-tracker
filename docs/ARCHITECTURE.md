# Architecture

## Data flow

GitHub Actions wakes daily. The worker enforces a roughly 48-hour successful-run
interval, reads configuration/history/state, gets a free SerpApi Account API
snapshot, builds a quota-safe work plan, runs fare lanes, scores candidates,
performs late transit-policy checks only for qualifying transfer deals, persists
results, and sends Discord output.

Automated prices come from SerpApi's Google Travel Explore and Google Flights
engines. ITA Matrix and Skiplagged are verification links only; the worker does
not scrape either site.

## Search lanes

- `date-first-return`: one Explore call for a configured departure/return pair.
- `date-first-one-way`: one Explore call for a configured departure date.
- `explore-verify`: exact Google Flights checks for relatively ranked Explore results.
- `exact`: prioritized configured route/date searches.
- `split-outbound` / `split-inbound`: the evidence-selected split construction.
- `construction`: an evidence-selected nearby-airport group or two-leg open jaw.
- `return-verify`: follow Google's departure token before a normal return alerts.

All billable lanes pass through one call guard. The production maximum is 14
attempts per completed cycle and a provider-account reserve of 10 searches is
protected. The normal allocation is two Explore calls, three Explore
verifications, six routine exact calls, up to two alternative-construction calls,
and one return verification.

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

The documented Explore destination schema supplies fare, dates, duration, stops,
and airline, but not a Google typical-price range. Pre-verification ranking reuses
the newest external price insight only from matched exact-search history. Results
without a local or external relative baseline are explicitly exploration-only;
one-way and unfamiliar exploration slots are still preserved so the worker can
build evidence for new routes. Reused external market evidence expires after 30
days by default.

`transit-policy.js` is independent from fare scoring. Its provider interface
returns `known` or explicit `unknown` policy evidence. The manual provider,
cache/staleness logic, connection-time checks, extra-cost accounting, and final
four-state transfer classification are pure and provider-agnostic. A licensed
Timatic-style provider can replace the manual provider without changing fare
qualification.

## Alternative constructions

The alternative selector scores split tickets, nearby-airport groups, and open
jaws before spending construction calls. Evidence includes recent reverse
one-way prices, comparable protected history, previous grouped results, expected
savings, freshness, and call efficiency. This replaces the previous round-robin
construction cursor and the independent automatic split pass.

Nearby-airport searches send comma-separated Google Flights airport groups, such
as `BKK,DMK`, and store the actual endpoint returned by the itinerary. Open jaws
price two independent one-way flights, such as `SIN-KUL` and `PEN-SIN`.
Construction evidence must match exact departure/return dates, airport group,
currency, cabin, passenger count, and baggage profile. A configured open-jaw
surface-transfer estimate is
included in expected and effective price. If that cost is unknown, expected
savings remain unknown and the candidate cannot send a normal deal alert.

JHB positioning is intentionally excluded. Singapore-Malaysia border time and
ground cost need a dedicated model before those fares can be compared honestly.

## State

`data/worker-state.json` contains:

- exact-search and independent date-first return/one-way cursors;
- alert cooldowns;
- construction evidence, split comparisons, and selected-plan summaries;
- per-run provider counts by request kind;
- SerpApi before/after quota snapshots and provider usage delta;
- exact-search coverage attempts, successes, offers, and errors;
- official promotion-page fingerprints;
- policy lookup results are stored separately in
  `data/transit-policy-cache.json`;
- `lastRunAt` and the scheduled-only `lastCompletedAt`.

Fare history is separate in `data/fare-history.json`. Protected, self-transfer,
airport-change, split, and open-jaw strategies do not share baselines. Coverage
is based on request events, including successful empty responses, rather than
inferred from fares.

State is persisted before Discord delivery. Therefore notification failure cannot
erase credits already spent. Alert cooldowns are persisted only after Discord
accepts the alert, allowing a failed alert to retry.

The opening Account API snapshot is mandatory for fare spending. An unavailable
or incomplete balance fails closed at zero calls. Quota-truncated scheduled runs
persist diagnostics and spent-work coverage but preserve exact/date cursors and
`lastCompletedAt`.

Promotion changes must produce the same new relevant-content fingerprint on two
consecutive checks before Discord is notified. This filters dynamic page chrome
and region-dependent rendering.

## Provider limitations

Google's first return response is normally an outbound selection; a
`departure_token` continuation resolves a compatible return. Grouped and open-jaw
queries may not include statistical price insights, so they build
strategy-specific history and never borrow confidence from unrelated standard
searches. SerpApi does not reliably provide countries, terminal certainty,
fallback departure availability, or document eligibility. Airport-country
metadata and policy evidence are therefore maintained explicitly. Fare baggage
text can be incomplete. Booking, entry, and transit rules must always be verified
directly.
