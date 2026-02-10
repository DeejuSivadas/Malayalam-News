const path = require("path");
const fs = require("fs");
const express = require("express");
const Parser = require("rss-parser");
const cheerio = require("cheerio");

const app = express();
const parser = new Parser({ timeout: 15000 });

const PORT = process.env.PORT || 3000;
const CACHE_MS = 5 * 60 * 1000;
const SOURCES_PATH = path.join(__dirname, "sources.json");
const MAX_ARTICLE_DATE_FETCH = 50;
const ARTICLE_DATE_CONCURRENCY = 6;

let cache = {
  fetchedAt: 0,
  items: [],
};

function readSources() {
  const raw = fs.readFileSync(SOURCES_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.sources)) return [];
  return data.sources.filter((s) => s.enabled && s.url);
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function hasMalayalam(text) {
  return /[\u0D00-\u0D7F]/.test(text || "");
}

function isSpecificHeadline(text) {
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length < 12) return false;
  const words = cleaned.split(" ").filter(Boolean);
  return words.length >= 3;
}

function firstSentence(text) {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/(.+?[.!?])\s/);
  if (match) return match[1].trim();
  if (cleaned.length <= 200) return cleaned;
  return cleaned.slice(0, 200).trim() + "...";
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return "";
  }
}

function matchesAny(value, patterns) {
  if (!patterns || !patterns.length) return false;
  return patterns.some((p) => {
    const re = new RegExp(p, "i");
    return re.test(value);
  });
}

function parseDateFromText(text) {
  if (!text) return "";
  const cleaned = normalizeWhitespace(text);
  const monthPattern =
    "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

  const patterns = [
    new RegExp(`${monthPattern}\\s+\\d{1,2},?\\s+\\d{4}`, "i"),
    new RegExp(`\\d{1,2}\\s+${monthPattern}\\s+\\d{4}`, "i"),
    /\b\d{4}[-/]\d{2}[-/]\d{2}\b/,
  ];

  for (const re of patterns) {
    const match = cleaned.match(re);
    if (match) {
      const date = new Date(match[0]);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return "";
}

function parseDateFromUrl(url) {
  if (!url) return "";
  const match = url.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (!match) return "";
  const [_, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function extractPublishedTimeFromHtml(html) {
  const $ = cheerio.load(html);
  const candidates = [
    'meta[property="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
    'meta[name="publish_date"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
  ];

  for (const selector of candidates) {
    const content = $(selector).attr("content");
    if (content) {
      const parsed = new Date(content);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      const fallback = parseDateFromText(content);
      if (fallback) return fallback;
    }
  }

  const timeEl = $("time[datetime]").first();
  if (timeEl.length) {
    const val = timeEl.attr("datetime");
    if (val) {
      const parsed = new Date(val);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      const fallback = parseDateFromText(val);
      if (fallback) return fallback;
    }
  }

  // Try JSON-LD (very common on news sites)
  const ldJson = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get()
    .filter(Boolean);

  for (const raw of ldJson) {
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (node && typeof node === "object") {
          const date =
            node.datePublished ||
            node.dateCreated ||
            (node.mainEntity && node.mainEntity.datePublished);
          if (date) {
            const d = new Date(date);
            if (!Number.isNaN(d.getTime())) return d.toISOString();
            const fallback = parseDateFromText(date);
            if (fallback) return fallback;
          }
        }
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  return "";
}

async function runWithConcurrency(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function enrichArticleDates(items) {
  const missing = items.filter((i) => !i.pubDate && i.link);
  const toFetch = missing.slice(0, MAX_ARTICLE_DATE_FETCH);
  await runWithConcurrency(toFetch, ARTICLE_DATE_CONCURRENCY, async (item) => {
    try {
      const html = await fetchHtml(item.link);
      const pubDate = extractPublishedTimeFromHtml(html);
      if (pubDate) item.pubDate = pubDate;
    } catch {
      // Ignore individual failures to keep the batch moving
    }
  });
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "MalayalamHeadlinesPWA/1.0 (+https://localhost)",
      "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const xml = await res.text();
  return parser.parseString(xml);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "MalayalamHeadlinesPWA/1.0 (+https://localhost)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}

function extractFromHtml(source, html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  const maxItems = source.maxItems || 12;
  const includePatterns = source.includePatterns || [];
  const excludePatterns = source.excludePatterns || [];
  const titleExcludeKeywords = source.titleExcludeKeywords || [];

  $("a[href]").each((_, el) => {
    if (items.length >= maxItems) return;
    const href = $(el).attr("href");
    const abs = toAbsoluteUrl(href, source.url);
    if (!abs) return;
    if (includePatterns.length && !matchesAny(abs, includePatterns)) return;
    if (excludePatterns.length && matchesAny(abs, excludePatterns)) return;
    if (seen.has(abs)) return;

    const title = normalizeWhitespace($(el).text());
    if (title.length < 15 || title.length > 180) return;
    if (!hasMalayalam(title) || !isSpecificHeadline(title)) return;
    if (
      titleExcludeKeywords.length &&
      titleExcludeKeywords.some((kw) =>
        title.toLowerCase().includes(kw.toLowerCase())
      )
    ) {
      return;
    }

    const parent = $(el).closest("article, li, div");
    let summary = normalizeWhitespace(parent.find("p").first().text());
    if (summary && summary.length < 10) summary = "";
    if (summary && summary === title) summary = "";

    let pubDate = "";
    const timeEl = parent.find("time").first();
    if (timeEl.length) {
      pubDate =
        timeEl.attr("datetime") ||
        normalizeWhitespace(timeEl.text()) ||
        "";
    }
    if (pubDate) {
      const parsed = new Date(pubDate);
      pubDate = Number.isNaN(parsed.getTime())
        ? parseDateFromText(pubDate)
        : parsed.toISOString();
    } else {
      pubDate = parseDateFromText(parent.text());
    }
    if (!pubDate) {
      pubDate = parseDateFromUrl(abs);
    }

    seen.add(abs);
    items.push({
      title,
      link: abs,
      source: source.name,
      pubDate,
      summary: firstSentence(summary),
    });
  });

  return items;
}

async function loadHeadlines() {
  const sources = readSources();
  const fetchedAt = Date.now();
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      if (source.type === "rss") {
        const feed = await fetchFeed(source.url);
        return (feed.items || [])
          .map((item) => {
            const description =
              item.contentSnippet || item.content || item.summary || "";
            const clean = stripHtml(description);
            return {
              title: (item.title || "").trim(),
              link: item.link || "",
              source: source.name,
              pubDate: item.isoDate || item.pubDate || parseDateFromUrl(item.link || ""),
              summary: firstSentence(clean),
              discoveredAt: fetchedAt,
            };
          })
          .filter(
            (item) =>
              item.title &&
              hasMalayalam(item.title) &&
              isSpecificHeadline(item.title)
          );
      }

      if (source.type === "html") {
        const html = await fetchHtml(source.url);
        return extractFromHtml(source, html).map((item) => ({
          ...item,
          discoveredAt: fetchedAt,
        }));
      }

      return [];
    })
  );

  const items = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((i) => i.title)
    .map((item) => {
      if (!item.pubDate) {
        item.pubDate = parseDateFromUrl(item.link || "");
      }
      const parsed = item.pubDate ? new Date(item.pubDate) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        item.pubDate = parsed.toISOString();
      } else {
        item.pubDate = "";
      }
      return item;
    });

  await enrichArticleDates(items);

  // Final safety: if still missing, try link-based date one last time.
  for (const item of items) {
    if (!item.pubDate && item.link) {
      item.pubDate = parseDateFromUrl(item.link);
    }
  }

  items.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    if (da && db) return db - da;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return (b.discoveredAt || 0) - (a.discoveredAt || 0);
  });

  return items;
}

app.get("/api/headlines", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const isFresh = Date.now() - cache.fetchedAt < CACHE_MS;

    if (!force && isFresh) {
      return res.json({
        updatedAt: cache.fetchedAt,
        items: cache.items,
        cached: true,
      });
    }

    const items = await loadHeadlines();
    cache = { fetchedAt: Date.now(), items };
    res.json({ updatedAt: cache.fetchedAt, items, cached: false });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch headlines",
      message: err.message,
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
