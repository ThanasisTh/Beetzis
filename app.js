const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MIN_SCAN_ZOOM = 12;

const map = L.map("map").setView([39.0742, 21.8243], 6);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const resultsLayer = L.layerGroup().addTo(map);
const devLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const protectedLayer = L.layerGroup().addTo(map);

const scanBtn = document.getElementById("scan-btn");
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");

scanBtn.addEventListener("click", runScan);

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

function processResults(elements) {
  const beaches = [];
  const devPoints = [];
  const tracks = [];
  const protectedRings = [];

  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.natural === "beach") {
      const center = elementCenter(el);
      if (center) beaches.push({ el, center });
    } else if (/^(camp_site|hotel|guest_house|apartment|resort|hostel)$/.test(tags.tourism || "")) {
      const center = elementCenter(el);
      if (center) devPoints.push({ el, center, isCampsite: tags.tourism === "camp_site" });
    } else if (/^(track|path|unclassified|service|residential)$/.test(tags.highway || "")) {
      if (el.geometry) tracks.push(el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
    } else if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve") {
      if (el.type === "way" && el.geometry) {
        protectedRings.push(el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
      } else if (el.type === "relation" && el.members) {
        for (const m of el.members) {
          if (m.geometry) protectedRings.push(m.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
        }
      }
    }
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
  for (const track of tracks) {
    L.polyline(track.map((p) => [p.lat, p.lng]), {
      color: "#6b6a63",
      weight: 1.5,
      dashArray: "2 4",
      opacity: 0.6,
    }).addTo(trackLayer);
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

  let prime = 0, possible = 0, unlikely = 0, restricted = 0;

  for (const beach of beaches) {
    const scored = scoreBeach(beach.center, devPoints, tracks, protectedRings);
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

    if (scored.bucket === "prime") prime++;
    else if (scored.bucket === "possible") possible++;
    else if (scored.bucket === "unlikely") unlikely++;
    else restricted++;
  }

  setStatus(
    `Found ${beaches.length} beach feature(s): ${prime} prime, ${possible} possible, ${unlikely} unlikely, ${restricted} restricted. (${devPoints.length} existing accommodations, ${tracks.length} access tracks, ${protectedRings.length} protected zones in view.)`
  );
}

function scoreBeach(center, devPoints, tracks, protectedRings) {
  const insideProtected = protectedRings.some((ring) => pointInRing(center, ring));
  if (insideProtected) {
    return { bucket: "restricted", color: "#c62828", label: "Restricted", nearestDevKm: null, nearestTrackKm: null };
  }

  let nearestDevKm = Infinity;
  for (const dp of devPoints) {
    const d = haversineKm(center, dp.center);
    if (d < nearestDevKm) nearestDevKm = d;
  }

  let nearestTrackKm = Infinity;
  for (const track of tracks) {
    for (const p of track) {
      const d = haversineKm(center, p);
      if (d < nearestTrackKm) nearestTrackKm = d;
    }
  }

  let points = 0;
  if (nearestDevKm > 3) points += 50;
  else if (nearestDevKm > 1) points += 30;
  else if (nearestDevKm > 0.3) points += 10;

  if (nearestTrackKm <= 0.3) points += 30;
  else if (nearestTrackKm <= 1) points += 15;
  else points += 5;

  const score = Math.round((points / 80) * 100);

  let bucket, color, label;
  if (score >= 70) {
    bucket = "prime"; color = "#2e7d32"; label = "Prime candidate";
  } else if (score >= 40) {
    bucket = "possible"; color = "#f9a825"; label = "Possible";
  } else {
    bucket = "unlikely"; color = "#9e9e9e"; label = "Unlikely";
  }

  return { bucket, color, label, score, nearestDevKm, nearestTrackKm };
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
  } else {
    body = `
      <p class="detail-title">${name} <span class="badge ${scored.bucket}">${scored.label} (${scored.score})</span></p>
      <p class="detail-row"><b>Nearest campsite/hotel:</b> ${isFinite(scored.nearestDevKm) ? scored.nearestDevKm.toFixed(2) + " km" : "none found in scanned area"}</p>
      <p class="detail-row"><b>Nearest track/path:</b> ${isFinite(scored.nearestTrackKm) ? scored.nearestTrackKm.toFixed(2) + " km" : "none found in scanned area"}</p>
    `;
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
