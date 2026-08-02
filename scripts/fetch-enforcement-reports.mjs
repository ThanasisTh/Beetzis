#!/usr/bin/env node
// Pulls public Reddit search results and Google News RSS for keywords related
// to wild-camping / camper-van enforcement in Greece, tags each hit with a
// best-guess region from a small gazetteer, and writes the aggregate to
// data/enforcement-reports.json. Run on a schedule by
// .github/workflows/fetch-enforcement-reports.yml — see README for caveats
// (this is region-level signal, not proof about any specific beach).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "data", "enforcement-reports.json");

const USER_AGENT = "beetzis-camping-scout/1.0 (+https://github.com/ThanasisTh/Beetzis)";
const REQUEST_DELAY_MS = 700;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REPORTS = 150;

const GREEK_KEYWORDS = [
  "πρόστιμο κάμπινγκ",
  "πρόστιμο για κάμπινγκ",
  "παράνομο κάμπινγκ",
  "ελεύθερο κάμπινγκ πρόστιμο",
  "απαγόρευση κάμπινγκ παραλία",
  "καταυλισμός παραλία πρόστιμο",
  "τροχόσπιτο πρόστιμο παραλία",
  "τροχόσπιτο πρόστιμο",
  "κάμπερ πρόστιμο",
  "λιμενικό κάμπινγκ έλεγχος",
  "αστυνομία κάμπερ παραλία",
  "καταυλισμός τροχόσπιτα εκκένωση",
  "πρόστιμα camping παραλίες",
  "απαγόρευση κατασκήνωσης παραλία",
  "έλεγχοι ελεύθερο κάμπινγκ",
  "σύλληψη κάμπινγκ παραλία",
  "εκκένωση καταυλισμού παραλία",
  "πρόστιμο 300 ευρώ κάμπινγκ",
];

const ENGLISH_KEYWORDS = [
  "Greece wild camping fine",
  "Greece camper van fine beach",
  "Greece illegal camping police",
  "Greece beach camping crackdown",
  "Greece campervan ban beach",
  "Greece free camping police fine",
  "Greece motorhome fine beach",
  "Greece van life fine",
  "Greece camping law 2025",
  "Greece wild camping arrest",
  "Greece coast guard camping fine",
  "Greece beach camping eviction",
];

const KEYWORDS = [...GREEK_KEYWORDS, ...ENGLISH_KEYWORDS];

// Best-guess region tagging only — substring match against title+snippet.
// Not exhaustive; extend as needed.
const GAZETTEER = [
  { name: "Zakynthos", aliases: ["zakynthos", "zante", "ζάκυνθος", "ζακύνθου"] },
  { name: "Crete", aliases: ["crete", "κρήτη", "κρήτης", "chania", "χανιά", "rethymno", "ρέθυμνο", "heraklion", "ηράκλειο", "lasithi", "λασίθι", "elafonisi", "ελαφονήσι", "balos", "μπάλος"] },
  { name: "Peloponnese", aliases: ["peloponnese", "πελοπόννησο", "πελοποννήσου", "messinia", "μεσσηνία", "kalamata", "καλαμάτα", "pylos", "πύλο", "kyparissia", "κυπαρισσία", "voidokilia", "βοϊδοκοιλιά"] },
  { name: "Halkidiki", aliases: ["halkidiki", "chalkidiki", "χαλκιδική", "sithonia", "σιθωνία", "kassandra", "κασσάνδρα"] },
  { name: "Corfu", aliases: ["corfu", "κέρκυρα"] },
  { name: "Lefkada", aliases: ["lefkada", "λευκάδα"] },
  { name: "Kefalonia", aliases: ["kefalonia", "cephalonia", "κεφαλονιά"] },
  { name: "Cyclades", aliases: ["cyclades", "κυκλάδες", "paros", "πάρος", "naxos", "νάξος", "mykonos", "μύκονος", "santorini", "σαντορίνη", "milos", "μήλος", "antiparos", "αντίπαρος"] },
  { name: "Sporades", aliases: ["skiathos", "σκιάθος", "skopelos", "σκόπελος"] },
  { name: "Thasos", aliases: ["thasos", "θάσος"] },
  { name: "Evia", aliases: ["evia", "εύβοια"] },
  { name: "Andros", aliases: ["andros", "άνδρος"] },
];

// A hit must mention one of these to count as actually being about camping —
// keyword search alone lets in false positives (e.g. a motorhome-fire story
// in the Netherlands, matched only because "τροχόσπιτο" appeared).
const CAMPING_TERMS = [
  "camping", "camper", "campervan", "camper van", "motorhome", "caravan",
  "wild camp", "campsite", "camp site", "rv park", "vanlife", "van life",
  "κάμπινγκ", "κάμπερ", "καταυλισμ", "κατασκήνωσ", "τροχόσπιτ", "σκηνή", "σκηνές",
];

function mentionsCamping(text) {
  const lower = text.toLowerCase();
  return CAMPING_TERMS.some((t) => lower.includes(t));
}

function createTimeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function fetchJson(url) {
  const { signal, cleanup } = createTimeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    cleanup();
  }
}

async function fetchText(url) {
  const { signal, cleanup } = createTimeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    cleanup();
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const description = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1];
    if (!title || !link) continue;
    items.push({
      title: decodeEntities(title).trim(),
      link: decodeEntities(link).trim(),
      published: pubDate ? new Date(pubDate).toISOString() : null,
      snippet: description ? decodeEntities(description).replace(/<[^>]+>/g, "").trim() : "",
    });
  }
  return items;
}

function matchRegion(text) {
  const lower = text.toLowerCase();
  for (const entry of GAZETTEER) {
    if (entry.aliases.some((alias) => lower.includes(alias))) return entry.name;
  }
  return null;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRedditResults(keyword) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&limit=10`;
  try {
    const data = await fetchJson(url);
    const children = data?.data?.children || [];
    return children.map((c) => {
      const d = c.data;
      const title = d.title || "";
      return {
        source: "reddit",
        title,
        link: `https://www.reddit.com${d.permalink}`,
        published: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        snippet: d.selftext ? d.selftext.slice(0, 300) : "",
        keyword,
        region: matchRegion(`${title} ${d.selftext || ""}`),
      };
    });
  } catch (err) {
    console.error(`[reddit] "${keyword}" failed: ${err.message}`);
    return [];
  }
}

async function fetchGoogleNewsResults(keyword, lang) {
  const hl = lang === "el" ? "el" : "en";
  const ceid = lang === "el" ? "GR:el" : "GR:en";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=${hl}&gl=GR&ceid=${ceid}`;
  try {
    const xml = await fetchText(url);
    const items = parseRssItems(xml);
    return items.map((item) => ({
      source: "google-news",
      title: item.title,
      link: item.link,
      published: item.published,
      snippet: item.snippet,
      keyword,
      region: matchRegion(`${item.title} ${item.snippet}`),
    }));
  } catch (err) {
    console.error(`[google-news] "${keyword}" failed: ${err.message}`);
    return [];
  }
}

async function main() {
  const allReports = [];

  for (const keyword of GREEK_KEYWORDS) {
    allReports.push(...(await fetchRedditResults(keyword)));
    await delay(REQUEST_DELAY_MS);
    allReports.push(...(await fetchGoogleNewsResults(keyword, "el")));
    await delay(REQUEST_DELAY_MS);
  }

  for (const keyword of ENGLISH_KEYWORDS) {
    allReports.push(...(await fetchRedditResults(keyword)));
    await delay(REQUEST_DELAY_MS);
    allReports.push(...(await fetchGoogleNewsResults(keyword, "en")));
    await delay(REQUEST_DELAY_MS);
  }

  const seen = new Set();
  const deduped = [];
  for (const report of allReports) {
    if (!report.link || seen.has(report.link)) continue;
    seen.add(report.link);
    deduped.push(report);
  }

  // Only keep hits that (a) name a specific Greek region/place and (b) are
  // actually about camping — not just any article that loosely matched one
  // of the search keywords (e.g. a marijuana-farm story tagged "Peloponnese"
  // has no camping term and gets dropped; a motorhome story with no Greek
  // place mentioned gets dropped too).
  const relevant = deduped.filter(
    (r) => r.region && mentionsCamping(`${r.title} ${r.snippet}`)
  );

  relevant.sort((a, b) => {
    if (!a.published && !b.published) return 0;
    if (!a.published) return 1;
    if (!b.published) return -1;
    return new Date(b.published) - new Date(a.published);
  });

  const trimmed = relevant.slice(0, MAX_REPORTS);

  const output = {
    generated_at: new Date().toISOString(),
    keywords_used: KEYWORDS,
    reports: trimmed,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(
    `Wrote ${trimmed.length} reports (from ${allReports.length} raw hits, ${deduped.length} deduped, ${relevant.length} region+camping relevant) to ${OUTPUT_PATH}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
