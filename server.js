const express = require("express");
const path = require("path");
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

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", key: APIDEVOOS_KEY ? "set" : "missing", version: "3" });
});

// Flight search
app.post("/api/search", async (req, res) => {
  console.log("==> Search request:", JSON.stringify(req.body).slice(0, 150));

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

    console.log("==> Upstream status:", upstream.status);

    if (!upstream.ok) {
      const err = await upstream.text();
      console.log("==> Upstream error:", err.slice(0, 200));
      return res.status(upstream.status).json({ error: err });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let flightGroups = [];
    let tokens = {};
    let summary = {};
    let requestId = "";
    let currentEvent = "";
    let done = false;

    const timeout = setTimeout(() => {
      console.log("==> Timeout reached, returning partial results");
      done = true;
      reader.cancel().catch(() => {});
    }, 25000);

    while (!done) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch(e) {
        break;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
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
              console.log("==> Search initialized, requestId:", requestId);
            } else if (currentEvent === "flight-update") {
              const groups = data.newGroups || data.flightGroups || [];
              flightGroups = flightGroups.concat(groups);
              console.log("==> Flight update, total so far:", flightGroups.length);
            } else if (currentEvent === "search-complete") {
              summary = data.summary || {};
              console.log("==> Search complete, total flights:", flightGroups.length);
              clearTimeout(timeout);
              done = true;
              break;
            }
          } catch (e) { /* skip */ }
        }
      }
    }

    clearTimeout(timeout);
    console.log("==> Final flight count:", flightGroups.length);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const f of flightGroups) {
      const sig = f.flightSignature || f.humanSignature || (f.airline + getDepTime(f));
      if (!seen.has(sig)) { seen.add(sig); unique.push(f); }
    }

    const direct = unique.filter(f => {
      const segs = f.slices && f.slices[0] && f.slices[0].segments;
      return segs && segs.length === 1;
    });

    unique.sort((a, b) => getPrice(a) - getPrice(b));

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
    console.log("==> Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Static files AFTER API routes
app.use(express.static(path.join(__dirname, "public")));

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
