const headlinesEl = document.getElementById("headlines");
const lastUpdatedEl = document.getElementById("lastUpdated");
const cacheStatusEl = document.getElementById("cacheStatus");
const refreshBtn = document.getElementById("refreshBtn");
const template = document.getElementById("cardTemplate");
const updateBanner = document.getElementById("updateBanner");
const updateNowBtn = document.getElementById("updateNowBtn");
const updateDismissBtn = document.getElementById("updateDismissBtn");
const sourceFilter = document.getElementById("sourceFilter");

const VERSION_KEY = "mh_app_version";
let allItems = [];

function formatTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ml-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatAge(pubDate) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function render(items) {
  headlinesEl.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No headlines yet. Add RSS URLs in sources.json and refresh.";
    headlinesEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const node = template.content.cloneNode(true);
    node.querySelector(".source").textContent = item.source || "Unknown";
    node.querySelector(".time").textContent = formatAge(item.pubDate);
    node.querySelector(".headline").textContent = item.title;
    node.querySelector(".summary").textContent = item.summary || "";
    const link = node.querySelector(".link");
    if (item.link) {
      link.href = item.link;
      link.style.display = "inline";
    } else {
      link.style.display = "none";
    }
    headlinesEl.appendChild(node);
  });
}

function updateSourceFilter(items) {
  const sources = Array.from(
    new Set(items.map((i) => i.source).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  const current = sourceFilter.value;
  sourceFilter.innerHTML = `<option value="__all__">All sources</option>`;
  sources.forEach((source) => {
    const option = document.createElement("option");
    option.value = source;
    option.textContent = source;
    sourceFilter.appendChild(option);
  });
  if (current && sources.includes(current)) {
    sourceFilter.value = current;
  }
}

function applyFilter() {
  const selected = sourceFilter.value;
  if (!selected || selected === "__all__") {
    render(allItems);
    return;
  }
  render(allItems.filter((i) => i.source === selected));
}

async function loadHeadlines(force = false) {
  lastUpdatedEl.textContent = "Updating...";
  cacheStatusEl.textContent = "";
  try {
    const res = await fetch(`/api/headlines${force ? "?force=1" : ""}`);
    if (!res.ok) throw new Error("Network error");
    const data = await res.json();
    allItems = data.items || [];
    updateSourceFilter(allItems);
    applyFilter();
    lastUpdatedEl.textContent = `Updated ${formatTime(data.updatedAt)}`;
    cacheStatusEl.textContent = data.cached ? "(cached)" : "";

    if (data.version) {
      const current = localStorage.getItem(VERSION_KEY);
      if (current && current !== data.version) {
        updateBanner.classList.remove("hidden");
      } else {
        updateBanner.classList.add("hidden");
      }
      localStorage.setItem(VERSION_KEY, data.version);
    }
  } catch (err) {
    lastUpdatedEl.textContent = "Failed to update";
    cacheStatusEl.textContent = "Check server logs";
  }
}

refreshBtn.addEventListener("click", () => loadHeadlines(true));
sourceFilter.addEventListener("change", applyFilter);
updateNowBtn.addEventListener("click", () => {
  updateBanner.classList.add("hidden");
  window.location.reload(true);
});
updateDismissBtn.addEventListener("click", () => {
  updateBanner.classList.add("hidden");
});

loadHeadlines(true);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
