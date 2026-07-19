# Roadmap

## Current priorities

- Measure date-first Explore recall and matched exact-price-insight reuse across
  return and one-way lanes.
- Accumulate strategy-specific reverse one-way, nearby-airport, and open-jaw
  evidence so construction selection relies less on exploration value.
- Maintain explicit surface-transfer cost/time data for open jaws; unknown costs
  remain ineligible for normal deal alerts.
- Improve date-lane coverage reporting by destination and travel month.
- Reconcile Account API usage deltas into a bounded run-history ledger.
- Replace the empty manual transit-policy set with narrowly scoped, sourced rules
  or a licensed real-time document-requirements provider.

## Planned improvements

- Compare grouped nearby-airport fares with a same-run canonical-airport fare
  after access cost, without making fixed price alone an alert signal.
- Use SerpApi multi-city continuation only after fixtures prove cumulative-price
  semantics for the final leg.
- Monitor more official Singapore airline sale pages with stable extraction.
- Add total-trip accommodation and ground-transfer estimates without allowing
  estimates to inflate statistical confidence.
- Add a licensed Timatic/Sherpa-style provider adapter without changing the
  conservative `unknown` and staleness behavior.

## Intentionally deferred

- Automatic JHB positioning until border time and transport cost are modeled.
- Hidden-city booking automation because skipped segments, baggage, and airline
  terms create substantial risk.
- Machine-learning price prediction until there is a large, clean external
  dataset. The current private history is too small for defensible forecasting.
- Scraping ITA Matrix or Skiplagged. They remain manual verification sources.
