# Flight Deal Tracker

A 48-hour flight-deal worker and local review dashboard for a budget student based in Singapore.

This project does not scrape flight sites or bypass their controls. Flight pages are dynamic, account-aware, and often protected by site terms. The app opens the correct sources, stores your observed fares locally, tracks target-price hits, and reminds you when the next manual or browser-assisted check is due.

For true background checks, use the included GitHub Actions worker. It runs while your browser is closed, queries SerpApi's Google Travel Explore and Google Flights engines, preserves fare history and coverage in the repo, and sends Discord alerts with verification links. ITA Matrix and Skiplagged are not scraped automatically.

## Run it

Open `index.html` in a browser, or serve the folder locally:

```powershell
python -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## How to use the tracker

1. Add a route with three-letter airport codes, dates, cabin, and optional target fare.
2. Click `Open sources` to open Google Flights, ITA Matrix, and Skiplagged.
3. Turn on native alerts where the source supports them.
4. Enter the best observed fare with `Log fare`.
5. The app resets the route for another 48-hour check.
6. Enable browser notifications if you want this page to notify you while it is open.

All route and fare history is stored in your browser's `localStorage`.

## How it works in the background

The app is a local scheduler and fare journal:

1. Each route receives a `nextCheckAt` timestamp.
2. New routes are due immediately so you can create source alerts right away.
3. `Open sources` opens the three source searches and resets the route for 48 hours later.
4. `Check due` opens every due route and also resets those timers.
5. Browser notifications run only while this page is open. They are throttled so the same due routes do not notify every minute.
6. Fare logging is manual by design. This avoids fragile scraping of dynamic flight pages and keeps the tracker aligned with source-site restrictions.
7. The insight badge compares the latest logged fare to your own median history. It labels a route as target hit, strong deal, good deal, high versus history, or watching.

The deal algorithm is relative-first. A fare is only treated as a real alert if it is materially cheaper than an external Google market baseline or enough independent, closely matched observations. Absolute price caps are context, not enough by themselves. See [DEAL_CRITERIA.md](DEAL_CRITERIA.md) for the complete search scope, scoring rules, research decisions, and unresolved baggage/visa inputs.

- `strong deal`: latest fare is at least 20% below the prior route median and is a robust statistical outlier.
- `good deal`: latest fare is at least 10% below the prior route median and is statistically unusual.
- `Google market deal`: latest fare is materially below Google's typical-price range.
- `high versus history`: latest fare is at least 10% above the route median.
- confidence: low, medium, or high based only on external Google market statistics, never on repeated tracker samples alone.

The worker needs at least three independent observation days matching route, trip type, booking lead time, travel month, trip length, weekend pattern, baggage profile, and ticket strategy before local history can call something a relative deal. Multiple QA runs on one day count once. It excludes the new price from its own baseline and uses median absolute deviation with a dispersion floor to reject ordinary volatility. Google's similar-flight typical range and online price history can independently qualify a fare before local history is mature. Confidence is medium when one external statistical baseline is available and high when both are available. Repeat alerts are date- and strategy-specific.

Each alert includes:

- latest fare
- trip type, weekday dates, stops, and per-direction duration
- route median and average from observed history
- percentage above/below median
- percentage above/below average
- estimated savings versus median and average
- historical best observed fare
- sample count and confidence level
- Google's typical-price range and the signals that triggered the alert
- Google's online price-history sample count and median when returned
- the exact external evidence used for the confidence label
- outbound and return verification status for round trips
- a traveler-value score and `BOOK`, `VERIFY`, `WATCH`, or `SKIP` action
- practical tradeoffs such as weekday timing, stops, baggage uncertainty, or separate tickets
- protected/self-transfer classification, policy evidence, connection time, and
  authorization or transfer costs when applicable

## Native alert setup

### Google Flights

1. Open the Google Flights link from the tracker.
2. Confirm origin, destination, dates, cabin, and passenger count.
3. Use the `Track prices` control for either the route or selected flight.
4. Keep email enabled on the Google account you are using.

Google's Travel Help says tracked flights can send notification emails when prices change or when Google predicts a fare is likely to increase.

### Skiplagged

1. Open the Skiplagged link from the tracker.
2. Sign in.
3. Search the same route and dates.
4. Use `Create a Price Alert`.
5. Watch for Skiplagged's email notification when the price drops.

Skiplagged's support page says website alerts require login and can send email notifications when prices drop.

### ITA Matrix

ITA Matrix is best used as a verification and advanced-search source. It does not provide a native public price-alert workflow, so use it to validate fares, date ranges, routing codes, and fare construction before booking elsewhere.

## Chrome plugin automation with Distill

Distill Web Monitor can monitor selected areas of a web page and trigger email, desktop, push, webhook, Slack, or Discord alerts. The free plan is usually enough for low-frequency 48-hour route checks, but check its current free limits before relying on it.

1. Install the Distill Web Monitor Chrome extension.
2. Open the exact flight-results page you want to monitor.
3. Click the Distill extension icon.
4. Choose `Monitor parts of page`.
5. Select a stable fare area, such as the visible best-price block.
6. Save the monitor with a name like `JFK-LAX Google Flights`.
7. Set the interval to `48 hours` or the closest available free interval.
8. Add an action: desktop notification, email, or webhook.
9. Repeat for each source where the results page renders consistently.
10. When Distill alerts you, open this tracker and log the fare.

Use native Google Flights and Skiplagged alerts first. Use Distill as a backup for visible page changes, because dynamic flight pages can change layout, require sign-in, or block background checks.

## True background automation

The static browser app is useful as a control panel, but it cannot reliably check fares after you close the tab. For real 48-hour background checks, use `.github/workflows/fare-check.yml`.

### 1. Create a route file

Copy:

```powershell
Copy-Item automation/routes.example.json automation/routes.json
```

Edit `automation/routes.json`. Add multiple nearby origins, nearby destinations, and date options. This is where the worker finds deals that a single exact search can miss.

### 2. Get a SerpApi key

Create a SerpApi account and add this GitHub repository secret:

```text
SERPAPI_API_KEY
```

The worker uses Google Travel Explore to discover short trips across configured months, then verifies promising results with exact `engine=google_flights` searches. It enables SerpApi `deep_search` for browser-parity Google results, sorts by price, allows Google's expanded "View more flights" results, limits stops and duration, and rotates through searches so the free tier is not burned too quickly.

### 3. Add Discord alerts

For Discord alerts, add:

```text
DISCORD_WEBHOOK_URL
```

Discord is the sole production notification channel. Email delivery is disabled.

### 4. Enable the scheduled workflow

Commit the workflow to the repository default branch. GitHub Actions wakes daily at:

```text
17 6 * * *
```

The worker stores its last successful completion time and only spends API searches after roughly 48 hours have elapsed. The daily wake-up avoids the 24-hour month-boundary gap that an every-other-calendar-day cron expression can produce. A manual run from the Actions tab bypasses the interval guard and defaults to one search for quota-safe testing.

A scheduled cycle has a hard 14-request cap across every billable lane. Its normal
plan is one Explore query, up to three Explore verifications, two split-ticket
checks, five prioritized exact searches, up to two nearby-airport/open-jaw
construction calls, and one reserved return verification. Actual use can be
lower. The free SerpApi Account API supplies the current balance, and the worker
protects a 10-credit reserve rather than assuming a fixed monthly allowance.
Exact searches request zero paid carry-on and checked bags; the free personal-item
allowance remains unconfirmed unless returned fare notes explicitly establish it.

The exact-search queue favors destinations checked least recently and dates
inside the next 90 days, with both returns and one ways. Coverage records attempts,
successful empty responses, offers, and failures instead of inferring checks from
fare history.

After every completed search cycle, the worker sends either a deal alert or a
no-deal heartbeat to every configured channel. The heartbeat reports how many
live candidates were checked, how many flexible options were reviewed, and the
three cheapest observed fares. Each listed fare includes route and dates, flight
details, historical and Google-market analysis, the specific reason it did not
trigger, and a Google Flights verification link. Daily workflow wake-ups skipped
by the 48-hour guard do not send a notification.

The worker also rotates grouped nearby-airport searches and open jaws. Open-jaw
prices exclude travel between the two destination cities and say so explicitly.
Official AirAsia and Scoot promotion pages are monitored for changes; those
changes are leads that still require a live Google Flights comparison.

The worker treats a complete provider failure as an incomplete check, sends an
error notification, fails the workflow, and does not advance the successful
completion timestamp. Search state is persisted before Discord delivery, so an
alert-channel failure cannot erase credits already spent. Manual smoke runs do
not postpone the next scheduled cycle.

## Self-transfer assessment

Protected itineraries remain preferred. Google Flights results marked as separate
tickets or requiring an airport change are no longer discarded before scoring.
When a transfer fare is a relative deal and saves at least both the configured
percentage and amount versus the cheapest comparable protected fare, the worker
assesses it separately.

The assessment uses nationality `Switzerland`, passport code `CHE`, and the
configured baggage profile. `passportExpiresOn` must be configured before an
entry-validity rule can pass automatically. Defaults require 240 minutes for a known same-airport
transfer, 360 minutes when immigration/recheck/terminal uncertainty applies, and
480 minutes for an airport change. Authorization, bag-recheck, ground-transfer,
and accommodation costs are added to the effective fare when known.

Policy results are `protected`, `self-transfer-acceptable`,
`self-transfer-manual-review`, or `self-transfer-rejected`. Unknown, stale,
unsourced, or incomplete evidence is never promoted as acceptable. Manual-review
fares remain visible in the Discord heartbeat with a direct verification note.

No visa website is scraped. Rules come from the provider interface in
`transit-policy.js`; the current provider reads manually maintained records from
`automation/transit-policies.json`. That production file is deliberately empty
until a rule has been checked against an official authority or a licensed source
such as IATA Timatic. Cache entries live in `data/transit-policy-cache.json` and
expire according to `transitPolicyMaxAgeDays`.

### 5. Verify before booking

When an alert fires, open the included links:

- Google Flights: broad fare sanity check and native price tracking.
- ITA Matrix: fare construction, routing, and advanced filters.
- Skiplagged: hidden-city and unusual routing check.

The worker intentionally uses SerpApi for live automated Google Flights prices because Google Flights, ITA Matrix, and Skiplagged do not expose a simple official free API for this exact use case. Amadeus Self-Service was removed from this setup because its portal is being decommissioned in 2026.

## Hidden-city caution

Skiplagged can surface hidden-city fares. Those can be cheaper, but they carry practical risks: checked bags may continue to the ticketed final city, later segments can be canceled if you skip a leg, airline loyalty benefits may be affected, and airline contract terms may prohibit the practice. Log hidden-city candidates in the notes field before booking so you can compare the real tradeoff against a standard itinerary.

## QA and research notes

Reddit's r/travel airfare wiki recommends using ITA Matrix and Google Flights for aggregation, tracking prices with Google Flights, and booking directly with the airline when possible. It also cautions that skipped legs can cancel later segments and that there is no reliable universal rule for timing airfare purchases.

A TravelHacks thread also frames ITA Matrix as powerful but less friendly than Google Flights. That supports the current workflow: Google Flights and Skiplagged for alerts, ITA Matrix for verification and advanced searching.

Open-source GitHub projects tend to choose one of two heavier approaches:

- scraper/API-backed trackers such as Flight Finder, FlightClaw, and Google Flights scraping examples;
- predictive ML projects using historical features and regression models.

Several popular trackers use a 5% change or a fixed dollar drop from the immediately previous observation. Live fares are noisy enough that this produces weak alerts. The worker instead uses independent daily observations, closely matched trip shape, median absolute deviation, Google's similar-flight typical range, and Google's online price history. Google's own price insights compare current fares with similar flights cataloged over the previous 12 months.

The documented Google Flights Deals API was also tested live. Its trip-length controls returned trips outside the requested 2-to-4-day window, so it was rejected for production. Google Travel Explore respected weekend-duration searches and is now paired with exact fare verification.

The included scheduled worker takes the safer production path: API-backed fare collection, open-ended destination discovery, robust relative scoring, and source links for final verification. The full rationale and source list are in [DEAL_CRITERIA.md](DEAL_CRITERIA.md).

## Test it

Run the complete offline suite:

```powershell
npm run check
```

Operational and handoff documentation is in [AGENTS.md](AGENTS.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Sources checked while building

- Google Travel Help: `https://support.google.com/travel/answer/6235879`
- ITA Matrix by Google: `https://matrix.itasoftware.com/`
- Skiplagged Support: `https://support.skiplagged.com/hc/en-us/articles/115001361053-Can-I-track-the-price-of-a-specific-flight`
- Distill Chrome Web Store listing: `https://chromewebstore.google.com/detail/distill-web-monitor/inlikjemeeknofckkjolnjbpehgadgge`
- Distill website: `https://distill.io/`
