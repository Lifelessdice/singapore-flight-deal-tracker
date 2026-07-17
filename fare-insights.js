(function initFareInsights(globalScope) {
  function toPrices(history) {
    return (history || [])
      .map((item) => Number(item.price))
      .filter((price) => Number.isFinite(price) && price > 0);
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  function average(values) {
    if (!values.length) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  function medianAbsoluteDeviation(values) {
    if (!values.length) return null;
    const center = median(values);
    return median(values.map((value) => Math.abs(value - center)));
  }

  function latestFare(history) {
    if (!history || !history.length) return null;
    return [...history].sort((a, b) => Number(a.loggedAt) - Number(b.loggedAt)).at(-1);
  }

  function getLeadTimeBucket(departureDate, observedAt = Date.now()) {
    const departure = Date.parse(`${departureDate}T00:00:00Z`);
    const observed = Number(observedAt);
    if (!Number.isFinite(departure) || !Number.isFinite(observed)) return "unknown";
    const days = Math.ceil((departure - observed) / (24 * 60 * 60 * 1000));
    if (days <= 14) return "0-14d";
    if (days <= 30) return "15-30d";
    if (days <= 60) return "31-60d";
    if (days <= 120) return "61-120d";
    return "121d+";
  }

  function marketContext(latest, marketInsights) {
    const insights = marketInsights || latest?.googlePriceInsights || null;
    const range = Array.isArray(insights?.typical_price_range)
      ? insights.typical_price_range.map(Number).filter(Number.isFinite)
      : [];
    const typicalLow = range.length === 2 ? Math.min(...range) : null;
    const typicalHigh = range.length === 2 ? Math.max(...range) : null;
    const typicalMidpoint = range.length === 2 ? median(range) : null;
    const priceLevel = String(insights?.price_level || "").toLowerCase() || null;
    return { priceLevel, typicalLow, typicalHigh, typicalMidpoint };
  }

  function analyzeFareHistory(history, targetFare, options = {}) {
    const ordered = [...(history || [])].sort((a, b) => Number(a.loggedAt) - Number(b.loggedAt));
    const prices = toPrices(ordered);
    const latest = latestFare(history);
    const latestPrice = latest ? Number(latest.price) : null;
    const baselinePrices = toPrices(ordered.slice(0, -1));
    const hasLocalBaseline = baselinePrices.length >= 3;
    const medianPrice = median(baselinePrices.length ? baselinePrices : prices);
    const averagePrice = average(baselinePrices.length ? baselinePrices : prices);
    const bestPrice = prices.length ? Math.min(...prices) : null;
    const sourceCount = new Set(ordered.map((item) => item.source).filter(Boolean)).size;
    const target = Number(targetFare);
    const hasTarget = Number.isFinite(target) && target > 0;
    const targetHit = hasTarget && latestPrice !== null && latestPrice <= target;
    const latestVsMedianPct = latestPrice !== null && medianPrice && hasLocalBaseline
      ? Math.round(((latestPrice - medianPrice) / medianPrice) * 100)
      : null;
    const latestVsAveragePct = latestPrice !== null && averagePrice && hasLocalBaseline
      ? Math.round(((latestPrice - averagePrice) / averagePrice) * 100)
      : null;
    const savingsVsMedian = latestPrice !== null && medianPrice && hasLocalBaseline
      ? Math.max(0, Math.round(medianPrice - latestPrice))
      : null;
    const savingsVsAverage = latestPrice !== null && averagePrice && hasLocalBaseline
      ? Math.max(0, Math.round(averagePrice - latestPrice))
      : null;
    const mad = hasLocalBaseline ? medianAbsoluteDeviation(baselinePrices) : null;
    const robustZScore = latestPrice !== null && medianPrice && mad
      ? Number((0.6745 * (latestPrice - medianPrice) / mad).toFixed(2))
      : null;
    const market = marketContext(latest, options.marketInsights);
    const latestVsMarketPct = latestPrice !== null && market.typicalMidpoint
      ? Math.round(((latestPrice - market.typicalMidpoint) / market.typicalMidpoint) * 100)
      : null;

    const statisticallyLow = robustZScore === null || robustZScore <= -1;
    const localGood = latestVsMedianPct !== null && latestVsMedianPct <= -10 && statisticallyLow;
    const localStrong = latestVsMedianPct !== null && latestVsMedianPct <= -20 &&
      (robustZScore === null || robustZScore <= -2);
    const marketGood = latestPrice !== null && market.typicalLow !== null &&
      latestPrice < market.typicalLow &&
      (market.priceLevel === "low" || latestVsMarketPct <= -10);
    const marketStrong = marketGood && latestVsMarketPct <= -20;
    const dealSignals = [
      localGood ? "local-history" : null,
      marketGood ? "google-typical-range" : null,
      localStrong ? "robust-outlier" : null
    ].filter(Boolean);

    let level = "watching";
    if (localStrong || marketStrong) {
      level = "strong-deal";
    } else if (localGood || marketGood) {
      level = "good-deal";
    } else if (
      (latestVsMedianPct !== null && latestVsMedianPct >= 10) ||
      market.priceLevel === "high"
    ) {
      level = "wait";
    }

    const confidence = hasLocalBaseline && market.typicalMidpoint && baselinePrices.length >= 6
      ? "high"
      : hasLocalBaseline || market.typicalMidpoint
        ? "medium"
        : "low";

    return {
      sampleCount: prices.length,
      baselineSampleCount: baselinePrices.length,
      sourceCount,
      latest,
      latestPrice,
      medianPrice,
      averagePrice,
      bestPrice,
      targetHit,
      latestVsMedianPct,
      latestVsAveragePct,
      savingsVsMedian,
      savingsVsAverage,
      medianAbsoluteDeviation: mad,
      robustZScore,
      marketPriceLevel: market.priceLevel,
      typicalLow: market.typicalLow,
      typicalHigh: market.typicalHigh,
      typicalMidpoint: market.typicalMidpoint,
      latestVsMarketPct,
      dealSignals,
      level,
      confidence
    };
  }

  const api = {
    analyzeFareHistory,
    average,
    getLeadTimeBucket,
    median,
    medianAbsoluteDeviation
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.FareInsights = api;
})(typeof window !== "undefined" ? window : globalThis);
