# Beetzis — Greece Camping Scout

A static, client-side map tool for scouting quiet, undeveloped beach camping
spots in Greece. No backend, no API keys, no build step — open `index.html`
or serve the folder statically.

## How it works

1. Pan/zoom the map to a stretch of Greek coastline (zoom ≥ 12 — roughly
   bay/town scale) and click **Scan visible area**.
2. The app sends one query to the public [Overpass API](https://overpass-api.de)
   (OpenStreetMap's data query service) for everything tagged in the visible
   bounding box:
   - `natural=beach` — candidate spots
   - `tourism=camp_site|hotel|guest_house|apartment|resort|hostel` — existing
     "discovered"/developed accommodation, used as an isolation reference
   - `highway=track|path|unclassified|service|residential` — access routes
   - `boundary=protected_area`, `leisure=nature_reserve` — protected zones
   - `place=city|town` — used to penalize proximity to real towns/cities;
     villages/hamlets are deliberately not queried for this since they don't
     count as "too developed" here
3. Each beach gets a score:
   - **Isolation**: distance to the nearest existing accommodation
     (>3 km → +50, 1–3 km → +30, 0.3–1 km → +10, closer → +0)
   - **Accessibility**: distance to the nearest track/path
     (≤0.3 km → +30, ≤1 km → +15, farther → +5)
   - Normalized to 0–100 and bucketed: **Prime** (≥70), **Possible** (40–69),
     **Unlikely** (<40)
   - Forced to **Unlikely** regardless of the computed score if either: 2+
     campsites/hotels sit within 1 km of the beach (a cluster of businesses,
     not just one), or a `place=town`/`place=city` node is within 1 km.
     Villages/hamlets don't trigger this.
   - Any beach whose point falls inside a mapped protected area/nature
     reserve is flagged **Restricted** regardless of score.
   - Any beach within a known camping-enforcement hotspot (see below) is
     flagged **Enforcement hotspot** and its normal score is overridden,
     unless it's already Restricted.
4. Click a marker for the breakdown and jump-off links to Google Maps / OSM.

## Data sources

Currently wired up (all free, no key required):

- **OpenStreetMap via Overpass API** — beaches, accommodation, tracks,
  protected areas. Live, queried on every scan.
- **`data/enforcement-hotspots.json`** — a manually curated, hand-researched
  list of areas with documented camping/camper-van enforcement (fines,
  ranger patrols, arrests), each with a source link. Reviewed by a human,
  not automated; refresh it by asking for another research pass, not by
  waiting for a script.
- **`data/enforcement-reports.json`** — generated automatically, weekly, by
  `.github/workflows/fetch-enforcement-reports.yml` running
  `scripts/fetch-enforcement-reports.mjs`. That script searches:
  - **Reddit's public search API** (`reddit.com/search.json`), and
  - **Google News RSS** (`news.google.com/rss/search`)

  for ~30 Greek- and English-language keywords (fines, arrests, crackdowns,
  camper-van bans, etc. — see the script for the full list), tags each hit
  with a best-guess Greek region from a small place-name gazetteer, and keeps
  only hits that (a) name a specific region/place from that gazetteer **and**
  (b) actually contain a camping-related term in the title/snippet — keyword
  search alone let through false positives like a Dutch motorhome-fire story
  (no Greek place mentioned) and a marijuana-farm bust tagged "Peloponnese"
  (no camping term at all). Deduped, sorted by date, committed automatically.
  It runs server-side inside the GitHub Actions runner specifically because
  browsers can't call most of these APIs directly (CORS, and some require
  auth entirely) — this is why it isn't just client-side JS like the rest of
  the app. The workflow can also be triggered manually from the repo's
  **Actions** tab if you want fresh data sooner than the weekly schedule.
- The frontend just fetches both JSON files as static assets alongside the
  rest of the site — no server, no keys, same-origin, so no CORS issues.

Not wired up, no true "social media" source is: X/Twitter and
Facebook/Instagram both require paid API access or a login to query, which
is incompatible with a free static site with no backend holding secrets —
Reddit and Google News were the realistic substitutes.

Ideas for future layers (from the original brainstorm, not yet built):

- **Sentinel-2 / Copernicus imagery** (via Sentinel Hub EO Browser) or
  Google/Bing satellite tiles, for visually confirming flat, shaded,
  vegetated ground near a candidate beach.
- **Corine Land Cover** — EU land-use classification, to pre-filter for
  "beaches, dunes, sand" and forest/scrub cover instead of built-up areas.
- **iOverlander / Park4Night / Campercontact exports** — crowdsourced
  camper-van spots, useful both as more "known" points to avoid and as
  candidate leads.
- **Wikiloc / AllTrails / Komoot** GPX tracks near the coast — often reveal
  hidden coves reachable on foot.
- **Windy / Meteoblue** wind data — sheltered vs. exposed bays matter a lot
  in the Cyclades/Aegean in summer (meltemi).
- **VIIRS night-lights** — low light pollution as a rough proxy for "off the
  beaten path."
- **Sea turtle nesting beach lists** (e.g. Kyparissia, Zakynthos, Crete) —
  hard-exclude even where OSM's protected-area tagging is incomplete.

## Known limitations

- **Heuristic, not authoritative.** The score is a rough proxy built from
  whatever OSM happens to have tagged. Always verify on the ground (or via
  satellite imagery) before relying on it.
- **Scan is viewport-only.** Isolation distance only considers development
  *within the currently scanned area* — scan a wide enough area around a
  candidate for the distance to mean anything.
- **OSM tagging is incomplete.** Missing `natural=beach` tags mean missed
  candidates; missing `boundary=protected_area` tags mean a restricted area
  could be scored as if it weren't. This tool does not know about land
  ownership, private property, or local bylaws.
- **Legal status.** Wild camping is illegal nationwide under
  [Law 5170/2025](https://nikana.gr/en/blog/7342/new-camping-law-in-greece-2025-rules-restrictions-and-penalties-for-camper-vehicles)
  (in force since January 2025) and refined by
  [Law 5209/2025](https://www.vanlifezone.com/journal/Updated_Greek_law_eases_camping_restrictions_but_stays_firm)
  (from July 2025): on-the-spot fines of €300 per person/vehicle, with the
  older [Law 4055/2012 amendment](https://www.cna.gr/greece/telos-sto-elefthero-kabingk-elegchi-syllipsis-ke-prostima-eos-3-000-evro/)
  allowing arrest and fines up to €3,000 for flagrant offenses. This tool is
  for scouting quiet spots, not a legal opinion.
- **Enforcement hotspots are curated, not comprehensive.** The 5 areas in
  `enforcement-hotspots.json` are ones I found specific, sourced reporting
  for — Sithonia, the Peloponnese coast generally, Zakynthos's turtle-nesting
  marine park, Crete's Elafonisi/Balos/Preveli, and Kyparissia Bay/Voidokilia.
  Being outside all five circles does **not** mean an area is
  enforcement-free — it means I didn't find documented reporting on it.
  Note also that "legally banned" and "actively enforced" are different
  things: Kyparissia Bay is legally protected turtle habitat but conservation
  groups report enforcement there has historically been weak, which is why
  it's flagged `low-but-illegal` rather than colored as an active hotspot.
- **Scraped reports are region-level, not beach-level.** The weekly Reddit/
  news pipeline tags hits with a broad region (e.g. "Crete", "Cyclades") via
  simple keyword matching, not real geocoding — it cannot tell you whether a
  specific scanned beach had police activity, only that something matching
  the keywords and mentioning that region showed up recently. Treat it as a
  prompt to go read the source, not as a verdict.

## Running it

No build step. Options:

- Open `index.html` directly in a browser.
- Or serve statically, e.g. `python3 -m http.server` from this folder, then
  visit `http://localhost:8000`.

Deployable as-is to GitHub Pages once the repo is public (or on a paid plan
for private Pages).
