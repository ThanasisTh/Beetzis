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
3. Each beach gets a score:
   - **Isolation**: distance to the nearest existing accommodation
     (>3 km → +50, 1–3 km → +30, 0.3–1 km → +10, closer → +0)
   - **Accessibility**: distance to the nearest track/path
     (≤0.3 km → +30, ≤1 km → +15, farther → +5)
   - Normalized to 0–100 and bucketed: **Prime** (≥70), **Possible** (40–69),
     **Unlikely** (<40)
   - Any beach whose point falls inside a mapped protected area/nature
     reserve is flagged **Restricted** regardless of score.
4. Click a marker for the breakdown and jump-off links to Google Maps / OSM.

## Data sources

Currently wired up (all free, no key required):

- **OpenStreetMap via Overpass API** — beaches, accommodation, tracks,
  protected areas. This is the only live data source right now; everything
  else below is a documented idea, not yet implemented.

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
- **Legal status.** Wild camping (pitching a tent outside a licensed site) is
  technically illegal in Greece under Law 392/1976, though enforcement varies
  by area. This tool is for scouting quiet spots, not a legal opinion.

## Running it

No build step. Options:

- Open `index.html` directly in a browser.
- Or serve statically, e.g. `python3 -m http.server` from this folder, then
  visit `http://localhost:8000`.

Deployable as-is to GitHub Pages once the repo is public (or on a paid plan
for private Pages).
