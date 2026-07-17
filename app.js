const STORAGE_KEY = "flightDealTrackers.v1";
const CHECK_INTERVAL_MS = 48 * 60 * 60 * 1000;

const form = document.querySelector("#routeForm");
const list = document.querySelector("#trackerList");
const notifyBtn = document.querySelector("#notifyBtn");
const notifyStatus = document.querySelector("#notificationStatus");
const checkDueBtn = document.querySelector("#checkDueBtn");
const logDialog = document.querySelector("#logDialog");
const logForm = document.querySelector("#logForm");
const logRouteLabel = document.querySelector("#logRouteLabel");
const logSource = document.querySelector("#logSource");
const logPrice = document.querySelector("#logPrice");
const logNotes = document.querySelector("#logNotes");

let trackers = readTrackers();
let activeTrackerId = null;
let lastDueNotificationAt = 0;

const fareInsights = window.FareInsights || {
  analyzeFareHistory(history, targetFare) {
    const prices = (history || []).map((item) => Number(item.price)).filter((price) => Number.isFinite(price) && price > 0);
    const latest = (history || []).slice().sort((a, b) => Number(a.loggedAt) - Number(b.loggedAt)).at(-1) || null;
    const latestPrice = latest ? Number(latest.price) : null;
    const bestPrice = prices.length ? Math.min(...prices) : null;
    const target = Number(targetFare);
    const targetHit = Number.isFinite(target) && target > 0 && latestPrice !== null && latestPrice <= target;

    return {
      sampleCount: prices.length,
      sourceCount: new Set((history || []).map((item) => item.source).filter(Boolean)).size,
      latest,
      latestPrice,
      medianPrice: null,
      averagePrice: null,
      bestPrice,
      targetHit,
      latestVsMedianPct: null,
      level: targetHit ? "target-hit" : "watching",
      confidence: "low"
    };
  }
};

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function readTrackers() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveTrackers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trackers));
}

function normalizeAirport(value) {
  return value.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
}

function formatDate(value) {
  if (!value) return "Flexible";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatMoney(value) {
  return value ? `$${Number(value).toLocaleString()}` : "No target";
}

function priceLabel(value) {
  return value ? `$${Number(value).toLocaleString()}` : "n/a";
}

function timeUntil(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "Due now";

  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m`;
}

function getGoogleFlightsUrl(tracker) {
  const query = `${tracker.origin} to ${tracker.destination} ${tracker.departDate}${tracker.returnDate ? ` return ${tracker.returnDate}` : ""}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function getItaMatrixUrl() {
  return "https://matrix.itasoftware.com/search";
}

function getSkiplaggedUrl(tracker) {
  const trip = tracker.returnDate ? "roundtrip" : "oneway";
  const url = new URL(`https://skiplagged.com/flights/${tracker.origin}/${tracker.destination}/${tracker.departDate}`);
  if (tracker.returnDate) url.searchParams.set("return", tracker.returnDate);
  url.searchParams.set("trip", trip);
  return url.toString();
}

function sourceLinks(tracker) {
  return [
    ["Google Flights", getGoogleFlightsUrl(tracker), "plane"],
    ["ITA Matrix", getItaMatrixUrl(tracker), "grid-3x3"],
    ["Skiplagged", getSkiplaggedUrl(tracker), "route"]
  ];
}

function updateNotificationStatus() {
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const enabled = permission === "granted";
  notifyStatus.textContent = enabled ? "Notifications on" : permission === "denied" ? "Notifications blocked" : "Notifications off";
  notifyStatus.classList.toggle("enabled", enabled);
}

function maybeNotifyDueTrackers() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (Date.now() - lastDueNotificationAt < 6 * 60 * 60 * 1000) return;

  const dueCount = trackers.filter((tracker) => tracker.nextCheckAt <= Date.now()).length;
  if (dueCount > 0) {
    new Notification("Flight deal checks due", {
      body: `${dueCount} route${dueCount === 1 ? "" : "s"} ready for Google Flights, ITA Matrix, and Skiplagged checks.`
    });
    lastDueNotificationAt = Date.now();
  }
}

function insightCopy(insights) {
  if (!insights.sampleCount) return "No fare samples yet.";

    const direction = insights.latestVsMedianPct === null
    ? "building route history"
    : `${Math.abs(insights.latestVsMedianPct)}% ${insights.latestVsMedianPct <= 0 ? "below" : "above"} median`;
  const labels = {
    "target-hit": "Target context",
    "strong-deal": "Strong deal",
    "good-deal": "Good deal",
    "wait": "High versus history",
    watching: "Watching"
  };

  const average = insights.averagePrice ? ` Average ${priceLabel(insights.averagePrice)}${insights.latestVsAveragePct !== null ? ` (${Math.abs(insights.latestVsAveragePct)}% ${insights.latestVsAveragePct <= 0 ? "below" : "above"})` : ""}.` : "";

  return `${labels[insights.level]}: latest ${priceLabel(insights.latestPrice)} is ${direction}. Median ${priceLabel(insights.medianPrice)}.${average} Best ${priceLabel(insights.bestPrice)} across ${insights.sampleCount} sample${insights.sampleCount === 1 ? "" : "s"} from ${insights.sourceCount} source${insights.sourceCount === 1 ? "" : "s"} (${insights.confidence} confidence). Alerts are based on relative drops, not absolute cheapness alone.`;
}

function renderTrackers() {
  if (!trackers.length) {
    list.innerHTML = `<div class="empty">No routes tracked yet. Add one to start a 48-hour watch.</div>`;
    return;
  }

  list.innerHTML = trackers
    .map((tracker) => {
      const isDue = tracker.nextCheckAt <= Date.now();
      const insights = fareInsights.analyzeFareHistory(tracker.history, tracker.targetFare);
      const historyRows = tracker.history
        .slice(-4)
        .reverse()
        .map((item) => `
          <div class="history-row">
            <strong>${item.source}</strong>
            <span>$${Number(item.price).toLocaleString()}</span>
            <span>${new Date(item.loggedAt).toLocaleString()}${item.notes ? ` - ${escapeHtml(item.notes)}` : ""}</span>
          </div>
        `)
        .join("");

      return `
        <article class="tracker-card">
          <div class="tracker-top">
            <div>
              <div class="route-code">${tracker.origin} -> ${tracker.destination}</div>
              <div class="meta">${formatDate(tracker.departDate)} to ${formatDate(tracker.returnDate)} | ${tracker.cabin} | target ${formatMoney(tracker.targetFare)}</div>
            </div>
            <div class="${isDue ? "due" : "ready"}">${isDue ? "Due now" : timeUntil(tracker.nextCheckAt)}</div>
          </div>
          <div class="actions">
            <button class="secondary" data-action="open" data-id="${tracker.id}"><span data-lucide="external-link"></span>Open sources</button>
            <button class="secondary" data-action="log" data-id="${tracker.id}"><span data-lucide="circle-dollar-sign"></span>Log fare</button>
            <button class="secondary" data-action="snooze" data-id="${tracker.id}"><span data-lucide="clock"></span>Reset 48h</button>
            <button class="secondary" data-action="delete" data-id="${tracker.id}"><span data-lucide="trash-2"></span>Delete</button>
          </div>
          <div class="source-links">
            ${sourceLinks(tracker)
              .map(([name, href, icon]) => `<a href="${href}" target="_blank" rel="noreferrer"><span data-lucide="${icon}"></span>${name}</a>`)
              .join("")}
          </div>
          <div class="insight ${insights.level}">${insightCopy(insights)}</div>
          <div class="history">${historyRows || `<span class="meta">No fare history yet.</span>`}</div>
        </article>
      `;
    })
    .join("");

  renderIcons();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function openSources(tracker) {
  sourceLinks(tracker).forEach(([, href]) => window.open(href, "_blank", "noopener,noreferrer"));
}

function resetTrackerTimer(tracker) {
  tracker.lastCheckedAt = Date.now();
  tracker.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const origin = normalizeAirport(data.get("origin"));
  const destination = normalizeAirport(data.get("destination"));

  if (origin.length !== 3 || destination.length !== 3) {
    alert("Use three-letter airport codes, such as JFK or LAX.");
    return;
  }

  if (origin === destination) {
    alert("Origin and destination must be different airports.");
    return;
  }

  if (data.get("returnDate") && data.get("returnDate") < data.get("departDate")) {
    alert("Return date must be after the departure date.");
    return;
  }

  trackers.unshift({
    id: crypto.randomUUID(),
    origin,
    destination,
    departDate: data.get("departDate"),
    returnDate: data.get("returnDate"),
    targetFare: data.get("targetFare"),
    cabin: data.get("cabin"),
    createdAt: Date.now(),
    lastCheckedAt: null,
    nextCheckAt: Date.now(),
    history: []
  });

  saveTrackers();
  form.reset();
  renderTrackers();
});

list.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const tracker = trackers.find((item) => item.id === button.dataset.id);
  if (!tracker) return;

  if (button.dataset.action === "open") {
    openSources(tracker);
    resetTrackerTimer(tracker);
  }

  if (button.dataset.action === "log") {
    activeTrackerId = tracker.id;
    logRouteLabel.textContent = `${tracker.origin} -> ${tracker.destination}`;
    logPrice.value = "";
    logNotes.value = "";
    logDialog.showModal();
  }

  if (button.dataset.action === "snooze") {
    resetTrackerTimer(tracker);
  }

  if (button.dataset.action === "delete") {
    trackers = trackers.filter((item) => item.id !== tracker.id);
  }

  saveTrackers();
  renderTrackers();
});

logForm.addEventListener("submit", () => {
  const tracker = trackers.find((item) => item.id === activeTrackerId);
  if (!tracker) return;

  tracker.history.push({
    source: logSource.value,
    price: logPrice.value,
    notes: logNotes.value.trim(),
    loggedAt: Date.now()
  });
  resetTrackerTimer(tracker);
  saveTrackers();
  renderTrackers();
});

notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    alert("This browser does not support desktop notifications.");
    return;
  }

  await Notification.requestPermission();
  updateNotificationStatus();
  maybeNotifyDueTrackers();
});

checkDueBtn.addEventListener("click", () => {
  trackers
    .filter((tracker) => tracker.nextCheckAt <= Date.now())
    .forEach((tracker) => {
      openSources(tracker);
      resetTrackerTimer(tracker);
    });
  saveTrackers();
  renderTrackers();
});

setInterval(() => {
  renderTrackers();
  maybeNotifyDueTrackers();
}, 60 * 1000);

updateNotificationStatus();
renderTrackers();
renderIcons();
