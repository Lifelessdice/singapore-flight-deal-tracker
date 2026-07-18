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

  function dedupeDailyFareObservations(history) {
    const byDay = new Map();
    [...(history || [])]
      .sort((a, b) => Number(a.loggedAt) - Number(b.loggedAt))
      .forEach((item) => {
        const loggedAt = Number(item.loggedAt);
        const day = Number.isFinite(loggedAt)
          ? new Date(loggedAt).toISOString().slice(0, 10)
          : `unknown-${byDay.size}`;
        byDay.set(day, item);
      });
    return [...byDay.values()];
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

  function hasSameBaggageProfile(fare, criteria) {
    return Number(fare?.carryOnBags || 0) === Number(criteria?.carryOnBags || 0) &&
      Number(fare?.checkedBags || 0) === Number(criteria?.checkedBags || 0);
  }

  function marketContext(latest, marketInsights) {
    const insights = marketInsights || latest?.googlePriceInsights || null;
    const range = Array.isArray(insights?.typical_price_range)
      ? insights.typical_price_range.map(Number).filter(Number.isFinite)
      : [];
    const priceHistory = Array.isArray(insights?.price_history)
      ? insights.price_history
        .map((point) => Number(Array.isArray(point) ? point[1] : null))
        .filter((price) => Number.isFinite(price) && price > 0)
      : [];
    const typicalLow = range.length === 2 ? Math.min(...range) : null;
    const typicalHigh = range.length === 2 ? Math.max(...range) : null;
    const typicalMidpoint = range.length === 2 ? median(range) : null;
    const priceLevel = String(insights?.price_level || "").toLowerCase() || null;
    return {
      priceLevel,
      priceHistory,
      typicalLow,
      typicalHigh,
      typicalMidpoint
    };
  }

  function analyzeFareHistory(history, targetFare, options = {}) {
    const ordered = dedupeDailyFareObservations(history);
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
    const latestVsMedianRaw = latestPrice !== null && medianPrice && hasLocalBaseline
      ? ((latestPrice - medianPrice) / medianPrice) * 100
      : null;
    const latestVsMedianPct = latestVsMedianRaw === null ? null : Math.round(latestVsMedianRaw);
    const latestVsAverageRaw = latestPrice !== null && averagePrice && hasLocalBaseline
      ? ((latestPrice - averagePrice) / averagePrice) * 100
      : null;
    const latestVsAveragePct = latestVsAverageRaw === null ? null : Math.round(latestVsAverageRaw);
    const savingsVsMedian = latestPrice !== null && medianPrice && hasLocalBaseline
      ? Math.max(0, Math.round(medianPrice - latestPrice))
      : null;
    const savingsVsAverage = latestPrice !== null && averagePrice && hasLocalBaseline
      ? Math.max(0, Math.round(averagePrice - latestPrice))
      : null;
    const mad = hasLocalBaseline ? medianAbsoluteDeviation(baselinePrices) : null;
    const localDispersion = hasLocalBaseline && medianPrice
      ? Math.max(Number(mad) || 0, medianPrice * 0.05)
      : null;
    const robustZScore = latestPrice !== null && medianPrice && localDispersion
      ? Number((0.6745 * (latestPrice - medianPrice) / localDispersion).toFixed(2))
      : null;
    const market = marketContext(latest, options.marketInsights);
    const latestVsMarketRaw = latestPrice !== null && market.typicalMidpoint
      ? ((latestPrice - market.typicalMidpoint) / market.typicalMidpoint) * 100
      : null;
    const latestVsMarketPct = latestVsMarketRaw === null ? null : Math.round(latestVsMarketRaw);
    const marketHistoryMedian = median(market.priceHistory);
    const marketHistoryMad = medianAbsoluteDeviation(market.priceHistory);
    const marketHistoryDispersion = marketHistoryMedian
      ? Math.max(Number(marketHistoryMad) || 0, marketHistoryMedian * 0.05)
      : null;
    const latestVsMarketHistoryRaw = latestPrice !== null && marketHistoryMedian
      ? ((latestPrice - marketHistoryMedian) / marketHistoryMedian) * 100
      : null;
    const latestVsMarketHistoryPct = latestVsMarketHistoryRaw === null
      ? null
      : Math.round(latestVsMarketHistoryRaw);
    const marketHistoryZScore = latestPrice !== null && marketHistoryMedian && marketHistoryDispersion
      ? Number((0.6745 * (latestPrice - marketHistoryMedian) / marketHistoryDispersion).toFixed(2))
      : null;

    const localGood = latestVsMedianRaw !== null && latestVsMedianRaw <= -10 &&
      robustZScore !== null && robustZScore <= -1;
    const localStrong = latestVsMedianRaw !== null && latestVsMedianRaw <= -20 &&
      robustZScore !== null && robustZScore <= -2;
    const marketRangeGood = latestPrice !== null && market.typicalMidpoint !== null && (
      latestPrice < market.typicalLow ||
      (market.priceLevel === "low" && latestVsMarketRaw <= -10)
    );
    const marketHistoryGood = market.priceHistory.length >= 7 &&
      latestVsMarketHistoryRaw !== null &&
      latestVsMarketHistoryRaw <= -10 &&
      marketHistoryZScore !== null &&
      marketHistoryZScore <= -1;
    const marketGood = marketRangeGood || marketHistoryGood;
    const marketStrong = (
      marketRangeGood && latestVsMarketRaw <= -20
    ) || (
      marketHistoryGood && latestVsMarketHistoryRaw <= -20 && marketHistoryZScore <= -2
    );
    const dealSignals = [
      localGood ? "local-history" : null,
      marketRangeGood ? "google-typical-range" : null,
      marketHistoryGood ? "google-online-price-history" : null,
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

    const hasTypicalMarketBaseline = market.typicalMidpoint !== null;
    const hasOnlinePriceHistory = market.priceHistory.length >= 7;
    const externalBaselineCount = Number(hasTypicalMarketBaseline) + Number(hasOnlinePriceHistory);
    const confidence = externalBaselineCount >= 2
      ? "high"
      : externalBaselineCount === 1
        ? "medium"
        : "low";
    const confidenceBasis = externalBaselineCount >= 2
      ? `Google's similar-flight typical range and ${market.priceHistory.length} online price-history points`
      : hasTypicalMarketBaseline
        ? "Google's online typical range for similar flights"
        : hasOnlinePriceHistory
          ? `${market.priceHistory.length} Google online price-history points`
          : "local observations only; no external statistical baseline returned";

    return {
      sampleCount: prices.length,
      baselineSampleCount: baselinePrices.length,
      rawObservationCount: (history || []).length,
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
      marketPriceHistorySampleCount: market.priceHistory.length,
      marketHistoryMedian,
      marketHistoryMad,
      latestVsMarketHistoryPct,
      marketHistoryZScore,
      marketBaselineAvailable: externalBaselineCount > 0,
      dealSignals,
      level,
      confidence,
      confidenceBasis
    };
  }

  const api = {
    analyzeFareHistory,
    average,
    dedupeDailyFareObservations,
    getLeadTimeBucket,
    hasSameBaggageProfile,
    median,
    medianAbsoluteDeviation
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.FareInsights = api;
})(typeof window !== "undefined" ? window : globalThis);
