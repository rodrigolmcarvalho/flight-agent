const express = require("express");
const app = express();
app.use(express.json());

const APIDEVOOS_KEY = process.env.APIDEVOOS_KEY;
const BASE_URL = "https://app.apidevoos.dev/api/v1/flights";
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Serve static files
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Flight search via SSE stream
app.post("/api/search", async (req, res) => {
  try {
    const upstream = await fetch(BASE_URL + "/stream", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + APIDEVOOS_KEY,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let flightGroups = [];
    let milesGroups = [];
    let tokens = {};
    let summary = {};
    let requestId = "";
    let currentEvent = "";

    const timeout = setTimeout(() => {
      reader.cancel();
    }, 25000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { currentEvent = ""; continue; }

          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);
              if (currentEvent === "search-initialized") {
                requestId = data.requestId || "";
                tokens = data.tokens || {};
              } else if (currentEvent === "flight-update") {
                const groups = data.newGroups || data.flightGroups || [];
                flightGroups = flightGroups.concat(groups);
              } else if (currentEvent === "search-complete") {
                summary = data.summary || {};
                clearTimeout(timeout);
                break;
              }
            } catch (e) { /* skip */ }
          }
        }

        if (currentEvent === "search-complete") break;
      }
    } catch (e) { /* timeout or stream end */ }

    clearTimeout(timeout);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const f of flightGroups) {
      const sig = f.flightSignature || f.humanSignature || (f.airline + getDepTime(f));
      if (!seen.has(sig)) { seen.add(sig); unique.push(f); }
    }

    // Direct flights
    const direct = unique.filter(f => {
      const segs = f.slices && f.slices[0] && f.slices[0].segments;
      return segs && segs.length === 1;
    });

    // Sort by price
    unique.sort((a, b) => getPrice(a) - getPrice(b));

    // Extract miles
    const miles = [];
    for (const f of unique) {
      if (!f.offers) continue;
      for (const offer of f.offers) {
        const info = offer.pointsInfo || offer.milesInfo;
        if (!info) continue;
        miles.push({
          airline: f.airline || (f.validatingAirlineCodes && f.validatingAirlineCodes[0]) || "",
          departureDateTime: getDepTime(f),
          arrivalDateTime: getArrTime(f),
          pointsRequired: info.totalPoints || info.points || 0,
          pointsType: (info.pointsType || info.program || "").toLowerCase(),
          taxAmount: offer.taxes ? (offer.taxes.amount || 0) : 0,
          totalCashEquivalent: ((info.totalPoints || 0) * 0.014) + (offer.taxes ? (offer.taxes.amount || 0) : 0),
          providerId: offer.providerId || "",
          flightSignature: f.flightSignature || "",
        });
      }
    }
    miles.sort((a, b) => a.totalCashEquivalent - b.totalCashEquivalent);

    return res.json({
      requestId, tokens,
      summary: {
        totalFlights: unique.length,
        totalDirectFlights: direct.length,
        totalMilesOffers: miles.length,
        providers: summary.providers || [],
      },
      flightGroups: unique,
      directFlights: direct,
      milesGroups: miles,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log("Server running on port " + PORT));

function getPrice(f) {
  if (f.offers && f.offers[0]) return f.offers[0].total || f.offers[0].price || 0;
  return f.price || f.total || f.totalPrice || 0;
}

function getDepTime(f) {
  if (f.slices && f.slices[0]) {
    const sl = f.slices[0];
    if (sl.segments && sl.segments[0]) return sl.segments[0].departureAt || "";
    return sl.departureAt || "";
  }
  return f.departureDateTime || f.departure || "";
}

function getArrTime(f) {
  if (f.slices && f.slices[0]) {
    const sl = f.slices[0];
    const segs = sl.segments || [];
    if (segs.length > 0) return segs[segs.length - 1].arrivalAt || "";
    return sl.arrivalAt || "";
  }
  return f.arrivalDateTime || f.arrival || "";
}
