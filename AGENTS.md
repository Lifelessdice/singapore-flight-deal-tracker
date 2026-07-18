# Agent guide

Read these files before changing the worker:

1. `DEAL_CRITERIA.md` for the product rules.
2. `docs/ARCHITECTURE.md` for data flow and state ownership.
3. `docs/OPERATIONS.md` for secrets, scheduling, QA, and failures.
4. `docs/ROADMAP.md` for known gaps and intentionally deferred work.

## Mission

Find unusually cheap, practical short trips for one Swiss-passport student based
in Singapore through December 2026. Cheap means cheap relative to a matched
market baseline, not merely below a fixed dollar target.

## Non-negotiable rules

- One adult, economy, origin `SIN`, August-December 2026.
- Assume one free under-seat backpack, zero paid carry-on bags, and zero checked
  bags. Never state that the personal item is included unless the fare feed says so.
- Search 2-to-4-day trips, including weekdays and one ways.
- Reject more than one stop, more than 15 hours per direction, self-transfers,
  and airport changes.
- `USD 75` one way and `USD 160` return are context only. They cannot independently
  trigger a deal alert.
- Confidence comes only from Google's external typical-price range and online
  price history. Tracker samples can establish a relative deal but remain low
  confidence.
- Round-trip alerts require a verified safe return. Split one-ways and open jaws
  must have both flight directions successfully priced.
- Keep strategy and date in history and cooldown keys.
- Discord receives either a deal notification or a no-deal heartbeat after every
  completed scheduled cycle.
- A provider-wide failure or exhausted safe quota must not advance
  `lastCompletedAt`.
- Never commit API keys, Discord webhooks, or provider request URLs containing keys.

## Repository map

- `scripts/check-fares.js`: provider orchestration, notifications, and persistence.
- `fare-insights.js`: relative-fare statistics and confidence.
- `tracker-product.js`: traveler-value scoring, construction rotation, quota,
  coverage, and promotion helpers.
- `automation/routes.json`: production traveler and search configuration.
- `data/fare-history.json`: observed candidate history.
- `data/worker-state.json`: cursors, cooldowns, quota, coverage, and promotions.
- `.github/workflows/fare-check.yml`: cloud schedule and state commit.
- `test/`: deterministic tests with no paid API calls.

## Change protocol

1. Preserve user data and unrelated worktree changes.
2. Put pure decision logic in `fare-insights.js` or `tracker-product.js`.
3. Route every billable SerpApi request through the global tracked-search budget.
4. Add focused tests for changed qualification, quota, persistence, or formatting.
5. Run `npm run check`.
6. Run `npm run check:fares:once` only when live provider validation is necessary;
   it spends one credit, disables discovery/constructions, and does not move the
   scheduled cadence.
7. Inspect the GitHub Actions run and confirm the Discord heartbeat before calling
   a cloud change complete.

## Definition of done

Code, config, tests, and docs agree; no secrets are staged; the global call cap is
enforced; state is written after credits are spent even if Discord fails; and the
notification explains price, relative evidence, confidence, traveler value,
tradeoffs, and a live Google Flights link.
