# Roadmap

## Current priorities

- Accumulate strategy-specific samples for nearby-airport and open-jaw searches.
- Add explicit surface-transfer cost/time data before open jaws can earn a
  high traveler-value action.
- Improve monthly coverage reporting by destination and travel month.
- Reconcile Account API usage deltas into a bounded run-history ledger.

## Planned improvements

- Compare grouped nearby-airport fares with a same-run canonical-airport fare and
  require both dollar and percentage savings after access cost.
- Use SerpApi multi-city continuation only after fixtures prove cumulative-price
  semantics for the final leg.
- Monitor more official Singapore airline sale pages with stable extraction.
- Add total-trip accommodation and ground-transfer estimates without allowing
  estimates to inflate statistical confidence.

## Intentionally deferred

- Automatic JHB positioning until border time and transport cost are modeled.
- Hidden-city booking automation because skipped segments, baggage, and airline
  terms create substantial risk.
- Machine-learning price prediction until there is a large, clean external
  dataset. The current private history is too small for defensible forecasting.
- Scraping ITA Matrix or Skiplagged. They remain manual verification sources.
