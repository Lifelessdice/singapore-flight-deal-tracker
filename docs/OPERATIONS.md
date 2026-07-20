# Operations

## Required secrets

Add these GitHub Actions repository secrets:

```text
SERPAPI_API_KEY
DISCORD_WEBHOOK_URL
```

Email delivery is disabled. Resend and Gmail credentials are not used.
No transit-policy API key is currently required.

For local live checks, create `.env` with the same names. Never commit `.env`.

## Schedule

`.github/workflows/fare-check.yml` wakes at `06:17 UTC` daily. A scheduled worker
spends fare credits only when about 48 hours have passed since the last completed
scheduled cycle. Skipped wake-ups do not send a heartbeat.

A manual workflow run forces execution, defaults to one exact search, and disables
date-first Explore and alternative construction unless explicitly selected.
Manual runs update usage and coverage but do not postpone the next scheduled
cycle or advance the production date-lane cursors. The manual `max_searches`
input controls the routine exact-search queue. The independent `max_calls` input
caps all provider attempts across Explore, exact verification, routine searches,
constructions, and return verification. Both default to one, so a discovery
smoke test still spends at most one credit.
Its Discord message separates raw Explore options from exactly verified fares and
states that cap-driven skipped follow-ups are expected. Selected raw leads include
indicative itinerary details, ranking reasons, and exact route/date Google
Flights links. Per-lead status distinguishes a priced exact follow-up, no eligible
exact options, a quota skip, and a provider failure. The worker does not report a
deal/no-deal conclusion from unverified discovery results.

## Commands

```powershell
npm run check
npm run check:fares:once
```

`npm run check` is offline and must pass before push. `check:fares:once` spends up
to one SerpApi credit and logs the Discord message locally unless the webhook is
present.

## Expected Discord output

Every completed scheduled cycle sends either:

- a deal alert with price, relative analysis, confidence evidence, traveler-value
  action, risks, itinerary checks, and live comparison links; or
- a no-deal heartbeat with the cheapest observations, rejection reasons, request
  usage, exact coverage, date-first lane coverage, construction activity, and
  promotion-page health. Up to three top Explore leads remain actionable even
  when no exact candidate qualifies.

The primary deal link is the selected Google Flights results page returned with
the exact provider response, with a generated route/date search as fallback.
Skiplagged receives route and dates. ITA Matrix opens its generic search page and
is explicitly labeled for manual route/date entry. All displayed fares must be
rechecked before purchase.

Official airline promotion changes are sent as a separate lead. A promotion-page
change is not a verified flight deal. A new page fingerprint must repeat on two
consecutive checks before it is announced.

## Quota behavior

The free Account API is queried before and after a run. The worker enforces both
`quota.maxCallsPerCycle` and `quota.reserveSearches`. Provider usage delta is more
authoritative than attempted count because cached or failed provider requests may
not consume a credit.

If no safe credits remain, the run must persist its status, fail as incomplete,
and retain the old `lastCompletedAt`. The same fail-closed behavior applies when
the opening Account API balance is unavailable or lacks a usable remaining count.

A full scheduled plan cannot exceed 14 billable attempts: two date-first Explore
calls, three exact Explore verifications, six routine exact searches, two
alternative-construction calls, and one return verification. When fewer safe
credits remain, the single shared call guard stops every lane at the lower
account-reserve limit.
The 14-call ceiling is also clamped in code; configuration or manual input cannot
raise it. Zero, negative, or malformed manual limits permit no fare calls.

## Failure behavior

- All fare requests fail: persist diagnostics, notify Discord, fail the action,
  and do not advance cadence.
- Account balance unavailable or safe quota truncates a scheduled plan: persist
  diagnostics, notify Discord, fail the action, and preserve all scheduling
  cursors.
- Some requests fail: complete the run and disclose partial provider health.
- Discord fails: searched state remains persisted; the action fails.
- Promotion page fails: fare checks continue and the heartbeat records the error.
- Unknown/stale transit policy: the fare remains in the manual-review heartbeat.
- Paid visa or insufficient transfer time: the transfer is rejected and its
  reason is stored in fare history.
- Concurrent state push: the workflow rebases and retries up to three times.

The state commit step uses `if: always()` so provider or Discord failures still
preserve billable work.

## Cloud QA

1. Push a branch or `main` change.
2. Open Actions and run `Fare check` manually with `max_searches=1` and
   `max_calls=1`.
3. Enable discovery and leave constructions disabled to probe one date-first
   Explore lane without allowing exact follow-up calls.
4. Confirm tests pass, the fare step succeeds, Discord receives a heartbeat, and
   the state commit succeeds.
5. Verify `providerStats.attempted` is one and manual execution did not change
   `lastCompletedAt`.

For an intentional end-to-end product test, set `max_searches=9`,
`max_calls=14`, and enable both discovery and constructions. This reproduces the
scheduled allocation and may spend up to 14 credits. Use it sparingly; formatting
alone remains covered by deterministic tests.

## Maintaining transit policies

1. Use an official immigration authority or licensed travel-document provider.
2. Copy the schema from `automation/transit-policies.example.json`.
3. Use ISO `CHE` for the passport and a three-letter transit-country code.
4. Set `traveler.passportExpiresOn` only from the traveler’s actual passport.
5. Record the exact airport and transfer type; avoid broad country wildcards.
6. Fill every legal/practical field and source URL.
7. Store authorization and transfer costs in the route currency; otherwise the
   result remains manual review until a verified conversion exists.
8. Set `lastVerifiedAt` to the actual review time.
9. Run `npm run check`.

Do not copy the example placeholder into production unchanged. The production
policy file is empty by default, so transfer deals remain manual review until a
maintained rule exists.
