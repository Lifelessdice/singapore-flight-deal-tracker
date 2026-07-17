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

  function latestFare(history) {
    if (!history || !history.length) return null;
    return [...history].sort((a, b) => Number(a.loggedAt) - Number(b.loggedAt)).at(-1);
  }

  function analyzeFareHistory(history, targetFare) {
    const prices = toPrices(history);
    const latest = latestFare(history);
    const latestPrice = latest ? Number(latest.price) : null;
    const medianPrice = median(prices);
    const averagePrice = average(prices);
    const bestPrice = prices.length ? Math.min(...prices) : null;
    const sourceCount = new Set((history || []).map((item) => item.source).filter(Boolean)).size;
    const target = Number(targetFare);
    const hasTarget = Number.isFinite(target) && target > 0;
    const targetHit = hasTarget && latestPrice !== null && latestPrice <= target;
    const latestVsMedianPct = latestPrice !== null && medianPrice && prices.length >= 3
      ? Math.round(((latestPrice - medianPrice) / medianPrice) * 100)
      : null;
    const latestVsAveragePct = latestPrice !== null && averagePrice && prices.length >= 3
      ? Math.round(((latestPrice - averagePrice) / averagePrice) * 100)
      : null;
    const savingsVsMedian = latestPrice !== null && medianPrice && prices.length >= 3
      ? Math.max(0, Math.round(medianPrice - latestPrice))
      : null;
    const savingsVsAverage = latestPrice !== null && averagePrice && prices.length >= 3
      ? Math.max(0, Math.round(averagePrice - latestPrice))
      : null;

    let level = "watching";
    if (latestVsMedianPct !== null && latestVsMedianPct <= -20) {
      level = "strong-deal";
    } else if (latestVsMedianPct !== null && latestVsMedianPct <= -10) {
      level = "good-deal";
    } else if (latestVsMedianPct !== null && latestVsMedianPct >= 10) {
      level = "wait";
    }

    const confidence = sourceCount >= 3 && prices.length >= 6
      ? "high"
      : sourceCount >= 2 && prices.length >= 3
        ? "medium"
        : "low";

    return {
      sampleCount: prices.length,
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
      level,
      confidence
    };
  }

  const api = { analyzeFareHistory, average, median };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.FareInsights = api;
})(typeof window !== "undefined" ? window : globalThis);
