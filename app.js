const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MIN_SCAN_ZOOM = 12;
const DEFAULT_CENTER = [39.0742, 21.8243];
const DEFAULT_ZOOM = 6;

const map = L.map("map").setView(DEFAULT_CENTER, DEFAULT_ZOOM);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// Center on the user's location at scan-ready zoom, if they grant permission.
// Falls back to the default Greece-wide view otherwise (denied, unsupported,
// times out, etc.) — the browser's permission prompt is triggered by this
// call itself, no custom UI needed.
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], MIN_SCAN_ZOOM);
      setStatus(`Centered on your location — click Scan to check this area.`);
    },
    (err) => {
      console.warn("Geolocation unavailable:", err.message);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

const resultsLayer = L.layerGroup().addTo(map);
const devLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const protectedLayer = L.layerGroup().addTo(map);
const townLayer = L.layerGroup().addTo(map);
const forestLayer = L.layerGroup().addTo(map);
const excludedForestLayer = L.layerGroup().addTo(map);

const scanBtn = document.getElementById("scan-btn");
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const reportsListEl = document.getElementById("reports-list");
const reportsUpdatedEl = document.getElementById("reports-updated");

scanBtn.addEventListener("click", runScan);

let hotspots = [];

async function loadStaticData() {
  try {
    const res = await fetch("data/enforcement-hotspots.json");
    const json = await res.json();
    hotspots = json.hotspots || [];
  } catch (err) {
    console.error("Failed to load enforcement hotspots", err);
  }

  try {
    const res = await fetch("data/enforcement-reports.json");
    const json = await res.json();
    renderReports(json);
  } catch (err) {
    console.error("Failed to load enforcement reports", err);
    reportsUpdatedEl.textContent = "Couldn't load report data.";
  }
}

function renderReports(json) {
  const reports = json.reports || [];
  reportsUpdatedEl.textContent = json.generated_at
    ? `Last updated ${new Date(json.generated_at).toLocaleDateString()} · ${reports.length} report(s)`
    : "Not generated yet — runs weekly via GitHub Actions (or trigger it manually from the repo's Actions tab).";

  if (!reports.length) {
    reportsListEl.innerHTML = '<p class="hint">No reports collected yet.</p>';
    return;
  }

  reportsListEl.innerHTML = reports
    .slice(0, 20)
    .map((r) => {
      const date = r.published ? new Date(r.published).toLocaleDateString() : "undated";
      const region = r.region ? `<span class="report-region">${r.region}</span>` : "";
      return `
        <div class="report-row">
          <a href="${r.link}" target="_blank" rel="noopener">${r.title}</a>
          <div class="report-meta">${r.source} · ${date} ${region}</div>
        </div>
      `;
    })
    .join("");
}

loadStaticData();

function setStatus(msg) {
  statusEl.textContent = msg;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Ray-casting point-in-polygon on a simple [{lat,lng}, ...] ring.
function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Approximate area of a lat/lng ring in km², via the shoelace formula on an
// equirectangular projection centered at the ring's own latitude — accurate
// enough at the sub-km scale these forest patches are checked at.
function ringAreaKm2(ring) {
  if (ring.length < 3) return 0;
  const latRad = (ring[0].lat * Math.PI) / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(latRad);

  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    const x1 = p1.lng * kmPerDegLng, y1 = p1.lat * kmPerDegLat;
    const x2 = p2.lng * kmPerDegLng, y2 = p2.lat * kmPerDegLat;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// Heuristic only: fraction of a ring's own vertices that have a mapped
// fence/wall/hedge vertex within proximityKm. Fence ways rarely share exact
// geometry with the forest polygon they enclose, so this approximates
// "traces most of the boundary" rather than requiring an exact match. It
// will miss unfenced private land entirely, and can be fooled by a fence
// that happens to run alongside the forest without enclosing it.
function ringFenceCoverage(ring, fenceSegments, proximityKm) {
  if (!fenceSegments.length) return 0;
  let nearCount = 0;
  for (const point of ring) {
    const isNear = fenceSegments.some((segment) =>
      segment.some((fp) => haversineKm(point, fp) <= proximityKm)
    );
    if (isNear) nearCount++;
  }
  return nearCount / ring.length;
}

const HIGHWAY_LABELS = {
  track: "dirt track",
  path: "footpath (foot traffic only, not for vehicles)",
  unclassified: "minor road",
  service: "service road",
  residential: "residential street",
};

// grade1 = solid/often paved ... grade5 = unmaintained, soft natural surface.
// Only meaningful on highway=track.
const TRACKTYPE_LABELS = {
  grade1: "solid, often paved",
  grade2: "mostly solid, some unpaved sections",
  grade3: "mixed solid/soft surface",
  grade4: "mostly unpaved, soft in places",
  grade5: "unmaintained, natural surface",
};

function describeTrack(track) {
  if (!track) return "none found in scanned area";
  const parts = [HIGHWAY_LABELS[track.highway] || track.highway];
  if (track.tracktype && TRACKTYPE_LABELS[track.tracktype]) {
    parts.push(TRACKTYPE_LABELS[track.tracktype]);
  }
  if (track.surface) parts.push(`surface: ${track.surface}`);
  if (track.name) parts.push(`"${track.name}"`);
  if (PRIVATE_ACCESS_VALUES.has(track.access)) parts.push(`⚠ access=${track.access}`);
  return parts.join(", ");
}

function wayCentroid(geometry) {
  const lat = geometry.reduce((s, p) => s + p.lat, 0) / geometry.length;
  const lng = geometry.reduce((s, p) => s + p.lon, 0) / geometry.length;
  return { lat, lng };
}

function elementCenter(el) {
  if (el.type === "node") return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  if (el.geometry && el.geometry.length) return wayCentroid(el.geometry);
  return null;
}

function buildQuery(bounds) {
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  return `
[out:json][timeout:25];
(
  way["natural"="beach"](${bbox});
  node["natural"="beach"](${bbox});
  node["tourism"~"^(camp_site|hotel|guest_house|apartment|resort|hostel)$"](${bbox});
  way["tourism"~"^(camp_site|hotel|guest_house|apartment|resort|hostel)$"](${bbox});
  way["highway"~"^(track|path|unclassified|service|residential)$"](${bbox});
  way["boundary"="protected_area"](${bbox});
  way["leisure"="nature_reserve"](${bbox});
  relation["boundary"="protected_area"](${bbox});
  node["place"~"^(city|town)$"](${bbox});
  way["natural"="wood"](${bbox});
  way["landuse"="forest"](${bbox});
  relation["natural"="wood"](${bbox});
  relation["landuse"="forest"](${bbox});
  way["barrier"~"^(fence|wall|hedge)$"](${bbox});
);
out geom;
`;
}

async function runScan() {
  const zoom = map.getZoom();
  if (zoom < MIN_SCAN_ZOOM) {
    setStatus(`Zoom in further first (current zoom ${zoom}, need ≥ ${MIN_SCAN_ZOOM}) — the visible area is too large for one scan.`);
    return;
  }

  resultsLayer.clearLayers();
  devLayer.clearLayers();
  trackLayer.clearLayers();
  protectedLayer.clearLayers();
  townLayer.clearLayers();
  forestLayer.clearLayers();
  excludedForestLayer.clearLayers();
  detailsEl.innerHTML = '<h2>Details</h2><p class="hint">Click a beach marker for its score breakdown.</p>';

  scanBtn.disabled = true;
  setStatus("Querying OpenStreetMap (Overpass API)...");

  try {
    const query = buildQuery(map.getBounds());
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
    const data = await res.json();
    processResults(data.elements);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}. Overpass is a shared public service — wait a moment and try a smaller area.`);
  } finally {
    scanBtn.disabled = false;
  }
}

const FENCE_PROXIMITY_KM = 0.03; // ~30m: how close a fence vertex must be to count as "on" the forest boundary
const FENCE_ENCLOSURE_RATIO = 0.5; // fraction of a forest ring's vertices that must be fence-adjacent to call it "likely fenced"
const PRIVATE_ACCESS_VALUES = new Set(["private", "no", "permit", "customers"]);

function processResults(elements) {
  const beaches = [];
  const devPoints = [];
  const tracks = [];
  const protectedRings = [];
  const towns = [];
  const rawForestRings = []; // { ring, access }
  const fenceSegments = [];

  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.natural === "beach") {
      const center = elementCenter(el);
      if (center) beaches.push({ el, center });
    } else if (/^(camp_site|hotel|guest_house|apartment|resort|hostel)$/.test(tags.tourism || "")) {
      const center = elementCenter(el);
      if (center) devPoints.push({ el, center, isCampsite: tags.tourism === "camp_site" });
    } else if (/^(track|path|unclassified|service|residential)$/.test(tags.highway || "")) {
      if (el.geometry) {
        tracks.push({
          points: el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
          highway: tags.highway,
          surface: tags.surface || null,
          tracktype: tags.tracktype || null,
          access: tags.access || null,
          name: tags.name || null,
        });
      }
    } else if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve") {
      if (el.type === "way" && el.geometry) {
        protectedRings.push(el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
      } else if (el.type === "relation" && el.members) {
        for (const m of el.members) {
          if (m.geometry) protectedRings.push(m.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
        }
      }
    } else if (/^(city|town)$/.test(tags.place || "")) {
      const center = elementCenter(el);
      if (center) towns.push({ el, center });
    } else if (tags.natural === "wood" || tags.landuse === "forest") {
      if (el.type === "way" && el.geometry) {
        rawForestRings.push({ ring: el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })), access: tags.access });
      } else if (el.type === "relation" && el.members) {
        for (const m of el.members) {
          if (m.geometry) rawForestRings.push({ ring: m.geometry.map((p) => ({ lat: p.lat, lng: p.lon })), access: tags.access });
        }
      }
    } else if (/^(fence|wall|hedge)$/.test(tags.barrier || "")) {
      if (el.geometry) fenceSegments.push(el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
    }
  }

  // Split forest patches into usable (count toward shade score) and
  // excluded (tagged private, or ringed closely enough by mapped fencing
  // that it's likely enclosed private/fenced land) — see ringFenceCoverage.
  const forestRings = [];
  const excludedForestRings = []; // { ring, reason }
  for (const { ring, access } of rawForestRings) {
    if (PRIVATE_ACCESS_VALUES.has(access)) {
      excludedForestRings.push({ ring, reason: `access=${access}` });
      continue;
    }
    const fenceCoverage = ringFenceCoverage(ring, fenceSegments, FENCE_PROXIMITY_KM);
    if (fenceCoverage >= FENCE_ENCLOSURE_RATIO) {
      excludedForestRings.push({ ring, reason: "likely fenced" });
      continue;
    }
    forestRings.push(ring);
  }

  // Draw context layers.
  for (const ring of protectedRings) {
    L.polygon(ring.map((p) => [p.lat, p.lng]), {
      color: "#c62828",
      weight: 1,
      fillOpacity: 0.12,
      dashArray: "4 4",
    }).addTo(protectedLayer);
  }
  for (const ring of forestRings) {
    L.polygon(ring.map((p) => [p.lat, p.lng]), {
      color: "#2e7d32",
      weight: 1,
      fillOpacity: 0.15,
    }).addTo(forestLayer);
  }
  for (const { ring, reason } of excludedForestRings) {
    L.polygon(ring.map((p) => [p.lat, p.lng]), {
      color: "#8d6e63",
      weight: 1,
      fillOpacity: 0.15,
      dashArray: "1 5",
    })
      .bindTooltip(`Excluded from shade score — ${reason}`)
      .addTo(excludedForestLayer);
  }
  for (const track of tracks) {
    const isPrivate = PRIVATE_ACCESS_VALUES.has(track.access);
    const isFootOnly = track.highway === "path";
    L.polyline(track.points.map((p) => [p.lat, p.lng]), {
      color: isPrivate ? "#c62828" : isFootOnly ? "#8d6e63" : "#6b6a63",
      weight: isFootOnly ? 1 : 1.5,
      dashArray: isFootOnly ? "1 4" : "2 4",
      opacity: 0.6,
    })
      .bindTooltip(describeTrack(track))
      .addTo(trackLayer);
  }
  for (const dp of devPoints) {
    L.circleMarker([dp.center.lat, dp.center.lng], {
      radius: 3,
      color: "#2b2a27",
      fillColor: "#2b2a27",
      fillOpacity: 0.8,
      weight: 1,
    })
      .bindTooltip(dp.el.tags.name || (dp.isCampsite ? "Campsite" : "Hotel/accommodation"))
      .addTo(devLayer);
  }
  for (const town of towns) {
    L.circleMarker([town.center.lat, town.center.lng], {
      radius: 5,
      color: "#4a4a4a",
      fillColor: "#ffffff",
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(`${town.el.tags.name || "Town"} (${town.el.tags.place})`)
      .addTo(townLayer);
  }

  let prime = 0, possible = 0, unlikely = 0, restricted = 0, enforcement = 0;

  for (const beach of beaches) {
    let scored = scoreBeach(beach.center, devPoints, tracks, protectedRings, towns, forestRings);
    const hotspotMatches = matchHotspots(beach.center, hotspots);
    scored = applyEnforcementOverlay(scored, hotspotMatches);

    const marker = L.circleMarker([beach.center.lat, beach.center.lng], {
      radius: 9,
      color: "#222",
      weight: 1,
      fillColor: scored.color,
      fillOpacity: 0.85,
    }).addTo(resultsLayer);

    const { body, links } = buildDetailHtml(beach, scored);
    marker.bindPopup(`${body}${links}`);
    marker.on("click", () => showDetails(beach, scored));

    if (scored.bucket === "enforcement") enforcement++;
    else if (scored.bucket === "prime") prime++;
    else if (scored.bucket === "possible") possible++;
    else if (scored.bucket === "unlikely") unlikely++;
    else restricted++;
  }

  setStatus(
    `Found ${beaches.length} beach feature(s): ${prime} prime, ${possible} possible, ${unlikely} unlikely, ${restricted} restricted, ${enforcement} enforcement hotspot(s). (${devPoints.length} existing accommodations, ${tracks.length} access tracks, ${protectedRings.length} protected zones, ${towns.length} towns/cities, ${forestRings.length} usable forest/wood areas, ${excludedForestRings.length} excluded as private/fenced.)`
  );
}

function matchHotspots(center, hotspotList) {
  return hotspotList.filter((h) => haversineKm(center, { lat: h.lat, lng: h.lon }) <= h.radius_km);
}

function applyEnforcementOverlay(scored, matches) {
  if (!matches.length) return scored;

  const active = matches.filter((m) => m.enforcement_level === "high" || m.enforcement_level === "medium");
  const passive = matches.filter((m) => m.enforcement_level === "low-but-illegal");
  const result = { ...scored, hotspotMatches: matches };

  if (scored.bucket !== "restricted" && active.length) {
    result.bucket = "enforcement";
    result.color = "#e65100";
    result.label = "Enforcement hotspot";
  } else if (passive.length) {
    result.legalNote = true;
  }

  return result;
}

const TOWN_RADIUS_KM = 1;
const CLUSTER_RADIUS_KM = 1;
const MAX_POINTS = 100; // 50 isolation + 30 access + 20 shade
const FOREST_SEARCH_RADIUS_KM = 1;
const DENSE_FOREST_KM2 = 0.3; // needed for full shade credit
const MODERATE_FOREST_KM2 = 0.1; // needed for partial shade credit

function scoreBeach(center, devPoints, tracks, protectedRings, towns, forestRings) {
  const insideProtected = protectedRings.some((ring) => pointInRing(center, ring));
  if (insideProtected) {
    return { bucket: "restricted", color: "#c62828", label: "Restricted", nearestDevKm: null, nearestTrackKm: null };
  }

  let nearestDevKm = Infinity;
  for (const dp of devPoints) {
    const d = haversineKm(center, dp.center);
    if (d < nearestDevKm) nearestDevKm = d;
  }

  const nearbyDevCount = devPoints.filter((dp) => haversineKm(center, dp.center) <= CLUSTER_RADIUS_KM).length;

  let nearestTownKm = Infinity;
  for (const town of towns) {
    const d = haversineKm(center, town.center);
    if (d < nearestTownKm) nearestTownKm = d;
  }

  let nearestTrackKm = Infinity;
  let nearestTrack = null;
  for (const track of tracks) {
    for (const p of track.points) {
      const d = haversineKm(center, p);
      if (d < nearestTrackKm) {
        nearestTrackKm = d;
        nearestTrack = track;
      }
    }
  }

  // Distance to the nearest forest/wood patch, plus how much forest area
  // actually sits within range — a sliver of mapped trees shouldn't score
  // the same as real, substantial tree cover. nearestForestKm is 0 if the
  // beach point itself falls inside a patch; otherwise the distance to its
  // nearest mapped edge (approximated by its nearest vertex). Only patches
  // within FOREST_SEARCH_RADIUS_KM count toward the area total.
  let nearestForestKm = Infinity;
  let nearbyForestAreaKm2 = 0;
  for (const ring of forestRings) {
    let ringDistKm = 0;
    if (!pointInRing(center, ring)) {
      ringDistKm = Infinity;
      for (const p of ring) {
        const d = haversineKm(center, p);
        if (d < ringDistKm) ringDistKm = d;
      }
    }
    if (ringDistKm < nearestForestKm) nearestForestKm = ringDistKm;
    if (ringDistKm <= FOREST_SEARCH_RADIUS_KM) nearbyForestAreaKm2 += ringAreaKm2(ring);
  }

  let points = 0;
  if (nearestDevKm > 3) points += 50;
  else if (nearestDevKm > 1) points += 30;
  else if (nearestDevKm > 0.3) points += 10;

  if (nearestTrackKm <= 0.3) points += 30;
  else if (nearestTrackKm <= 1) points += 15;
  else points += 5;

  // Full/partial shade credit now requires both proximity AND enough nearby
  // forest area — being 100m from a tiny mapped tree-line no longer counts
  // the same as being 100m from an actual forest.
  if (nearestForestKm <= 0.2 && nearbyForestAreaKm2 >= DENSE_FOREST_KM2) points += 20;
  else if (nearestForestKm <= 0.5 && nearbyForestAreaKm2 >= MODERATE_FOREST_KM2) points += 10;
  else if (nearestForestKm <= 1 && nearbyForestAreaKm2 > 0) points += 5;

  const score = Math.round((points / MAX_POINTS) * 100);

  let bucket, color, label;
  if (score >= 70) {
    bucket = "prime"; color = "#2e7d32"; label = "Prime candidate";
  } else if (score >= 40) {
    bucket = "possible"; color = "#f9a825"; label = "Possible";
  } else {
    bucket = "unlikely"; color = "#9e9e9e"; label = "Unlikely";
  }

  // Force "too developed" regardless of the isolation/access score: either
  // multiple businesses cluster nearby, or an actual town/city (not a
  // village — those are fine) is within range.
  let developedReason = null;
  if (nearbyDevCount >= 2) {
    developedReason = `${nearbyDevCount} campsites/hotels within ${CLUSTER_RADIUS_KM} km`;
  } else if (nearestTownKm <= TOWN_RADIUS_KM) {
    developedReason = `within ${TOWN_RADIUS_KM} km of a town/city`;
  }
  if (developedReason && bucket !== "unlikely") {
    bucket = "unlikely"; color = "#9e9e9e"; label = "Unlikely";
  }

  return {
    bucket, color, label, score,
    nearestDevKm, nearestTrackKm, nearestTrack, nearestForestKm, nearbyForestAreaKm2,
    nearbyDevCount, nearestTownKm, developedReason,
  };
}

function buildDetailHtml(beach, scored) {
  const name = beach.el.tags.name ? beach.el.tags.name : "Unnamed beach";
  const lat = beach.center.lat.toFixed(5);
  const lng = beach.center.lng.toFixed(5);

  let body;
  if (scored.bucket === "restricted") {
    body = `
      <p class="detail-title">${name} <span class="badge restricted">Restricted</span></p>
      <p class="detail-row">Falls inside a mapped protected area / nature reserve. Avoid camping here.</p>
    `;
  } else if (scored.bucket === "enforcement") {
    body = `
      <p class="detail-title">${name} <span class="badge enforcement">Enforcement hotspot</span></p>
      <p class="detail-row">Isolation/access score was ${scored.score}, but this falls within an area with reported active camping enforcement — see below.</p>
    `;
  } else {
    body = `
      <p class="detail-title">${name} <span class="badge ${scored.bucket}">${scored.label} (${scored.score})</span></p>
      <p class="detail-row"><b>Nearest campsite/hotel:</b> ${isFinite(scored.nearestDevKm) ? scored.nearestDevKm.toFixed(2) + " km" : "none found in scanned area"}</p>
      <p class="detail-row"><b>Nearest track/path:</b> ${isFinite(scored.nearestTrackKm) ? scored.nearestTrackKm.toFixed(2) + " km" : "none found in scanned area"} ${scored.nearestTrack ? `— ${describeTrack(scored.nearestTrack)}` : ""}</p>
      <p class="detail-row"><b>Nearest forest/shade:</b> ${scored.nearestForestKm === 0 ? "right on it" : isFinite(scored.nearestForestKm) ? scored.nearestForestKm.toFixed(2) + " km" : "none found in scanned area"} ${scored.nearbyForestAreaKm2 > 0 ? `(${scored.nearbyForestAreaKm2.toFixed(2)} km² of forest within ${FOREST_SEARCH_RADIUS_KM} km)` : ""}</p>
      ${scored.developedReason ? `<p class="detail-row"><b>Marked unlikely:</b> ${scored.developedReason}.</p>` : ""}
    `;
  }

  if (scored.hotspotMatches && scored.hotspotMatches.length) {
    body += scored.hotspotMatches
      .map(
        (h) => `
      <p class="detail-row hotspot-note"><b>⚠ ${h.name}</b> <span class="badge-inline">${h.enforcement_level}</span><br>
      ${h.note}
      ${h.sources.map((s, i) => `<a href="${s}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}
      </p>
    `
      )
      .join("");
  }

  const links = `
    <div class="detail-links">
      <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">Google Maps</a>
      <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}" target="_blank" rel="noopener">OpenStreetMap</a>
    </div>
  `;

  return { body, links };
}

function showDetails(beach, scored) {
  const { body, links } = buildDetailHtml(beach, scored);
  detailsEl.innerHTML = `<h2>Details</h2>${body}${links}`;
}
