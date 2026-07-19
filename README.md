# Singapore Flight Deal Tracker

An automated flight tracker for finding unusually cheap, practical short trips
from Singapore.

It checks fares roughly every 48 hours, compares each price with matched market
and historical evidence, and sends a detailed Discord alert when a fare is
genuinely unusual. A no-deal heartbeat is sent after every completed scheduled
cycle so you can tell that the tracker is still working.

The current search profile is designed for one student traveling from Singapore
through December 2026:

- economy, one adult, Swiss passport;
- one under-seat backpack and no paid bags;
- two-to-four-day trips, including weekends, weekdays, and one ways;
- no more than one stop or 15 hours per direction;
- nearby destinations across Southeast and East Asia.

## What makes this different

The cheapest visible fare is not always a deal. This tracker asks whether the
fare is unusually cheap for a comparable trip.

A price can qualify when it is:

- at least 10% below a closely matched historical median and statistically
  unusual;
- at least 20% below that median with strong outlier evidence; or
- materially below Google's typical-price range or online price history.

The fixed `USD 75` one-way and `USD 160` return targets provide useful context,
but hitting one of them is not enough to trigger a deal alert.

Comparisons account for the route, travel month, trip length, booking lead time,
weekend pattern, baggage profile, and ticket strategy. Protected tickets,
self-transfers, airport changes, split tickets, and open jaws do not share the
same price baseline.

See [DEAL_CRITERIA.md](DEAL_CRITERIA.md) for the complete qualification rules and
research behind them.

## What you receive

A deal notification explains:

- the live fare, route, dates, airline, stops, and duration;
- how much cheaper it is than the matched median and average;
- Google's typical-price evidence when available;
- confidence level and traveler-value score;
- return-flight verification for round trips;
- baggage uncertainty, weekday timing, separate-ticket risk, and other tradeoffs;
- self-transfer requirements and estimated extra costs when relevant;
- a live Google Flights link for final verification and booking.

When nothing qualifies, the heartbeat reports the cheapest fares observed,
why they did not trigger, search coverage, provider health, quota use, and any
self-transfers requiring manual review.

## How it works

1. GitHub Actions wakes daily and starts a fare cycle when about 48 hours have
   passed since the previous successful scheduled check.
2. Google Travel Explore looks for inexpensive short-trip destinations.
3. Promising results and configured route/date combinations are checked through
   Google Flights using SerpApi.
4. The worker applies price, stop, duration, return-safety, and transfer-risk
   checks before sending an alert.
5. Fare history and worker state are committed back to the repository, allowing
   later checks to compare like-for-like prices.

ITA Matrix and Skiplagged are provided as manual verification tools. They are not
scraped by the background worker.

## Quick start

You need:

- a GitHub repository created from this project;
- a [SerpApi](https://serpapi.com/) API key;
- a Discord server where you can create a webhook;
- Node.js 24 or newer for local testing.

### 1. Configure the searches

Copy the example configuration if `automation/routes.json` does not exist:

```powershell
Copy-Item automation/routes.example.json automation/routes.json
```

Edit `automation/routes.json` with your origin, destinations, travel dates,
price context, baggage profile, and search limits.

### 2. Add GitHub secrets

In the repository, open **Settings > Secrets and variables > Actions** and add:

```text
SERPAPI_API_KEY
DISCORD_WEBHOOK_URL
```

The tracker never needs an email password. Discord is the only production
notification channel.

### 3. Test the project

Run the offline test suite:

```powershell
npm run check
```

For a one-credit live smoke test, create an uncommitted `.env` containing the two
secrets and run:

```powershell
npm run check:fares:once
```

This live test performs at most one exact fare search and does not postpone the
next scheduled cycle.

### 4. Enable the background worker

Open the repository's **Actions** tab, select **Fare check**, and run it manually
with the default one-search settings. Confirm that:

- the workflow succeeds;
- Discord receives a heartbeat;
- the state-update commit succeeds.

The checked-in workflow then wakes automatically at `06:17 UTC` each day and
enforces the configured 48-hour interval.

## Local review dashboard

The repository also includes a browser-based route and fare journal. Open
`index.html` directly, or serve it locally:

```powershell
python -m http.server 5173
```

Then visit `http://localhost:5173`. Browser data is stored in `localStorage` and
is separate from the GitHub Actions worker's JSON history.

The dashboard can open matching Google Flights, ITA Matrix, and Skiplagged
searches and record manually observed fares. Browser notifications only work
while the page is open.

## Optional browser alerts

Use native Google Flights price tracking when available. Skiplagged also offers
account-based price alerts for supported searches, while ITA Matrix is primarily
useful for inspecting routes and fare construction.

A page-monitoring extension such as Distill can provide an additional visible
page-change alert:

1. Install Distill Web Monitor in Chrome.
2. Open the exact flight-results page.
3. Select the stable best-price area.
4. Set the interval to 48 hours or the closest free option.
5. Choose a desktop, email, or webhook notification.

Dynamic flight pages can change layout or require sign-in, so extension monitors
are a backup rather than the primary worker.

## Self-transfers and hidden-city fares

Protected itineraries are preferred. A self-transfer is considered only after it
passes the normal deal tests and saves at least both 15% and `USD 40` versus a
comparable protected itinerary.

Unknown visa rules, uncertain costs, or incomplete airport evidence are shown for
manual review instead of being promoted as safe. Paid visas and connections below
the conservative minimum are rejected. The production transit-policy file is
empty until narrowly scoped rules are verified from official or licensed
sources, so current self-transfer candidates normally require manual review.

Hidden-city fares are verification leads only. Skipping a segment can cancel
later flights, checked baggage may continue to the ticketed destination, and the
practice may conflict with airline terms.

## Current limitations

- SerpApi supplies automated Google results; ITA Matrix and Skiplagged remain
  manual checks.
- Personal-item inclusion must be confirmed against the actual fare and airline
  rules before booking.
- Entry and transit rules can change and always require final verification.
- Local statistical confidence improves only after enough comparable observation
  days have accumulated.
- Open-jaw prices currently exclude transport between the destination cities.

## Documentation

- [Deal criteria](DEAL_CRITERIA.md): search scope, statistical rules, and research
- [Architecture](docs/ARCHITECTURE.md): data flow, search lanes, and state
- [Operations](docs/OPERATIONS.md): scheduling, secrets, failure handling, and QA
- [Roadmap](docs/ROADMAP.md): known gaps and planned improvements
- [Agent guide](AGENTS.md): constraints for coding agents working on the repository

## License and booking responsibility

This project provides fare-monitoring and comparison assistance. Prices can
change between the alert and checkout, and it does not guarantee ticket
availability, admission, transit eligibility, or airline acceptance. Verify the
full itinerary and applicable travel rules before purchasing.
