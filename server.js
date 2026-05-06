const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());

const APIDEVOOS_KEY = process.env.APIDEVOOS_KEY;
const BASE_URL = "https://app.apidevoos.dev/api/v1/flights";
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", key: APIDEVOOS_KEY ? "set" : "missing", version: "4" });
});

app.post("/api/search", async (req, res) => {
  console.log("==> Search:", JSON.stringify(req.body).slice(0, 150));
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
    let tokens = {};
    let summary = {};
    let requestId = "";
    let currentEvent = "";
    let done = false;

    const timeout = setTimeout(() => {
      done = true;
      reader.cancel().catch(() => {});
    }, 25000);

    while (!done) {
      let chunk;
      try { chunk = await reader.read(); } catch(e) { break; }
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
            } else if (currentEvent === "flight-update") {
              const groups = data.newGroups || data.flightGroups || [];
              flightGroups = flightGroups.concat(groups);
              if (flightGroups.length === groups.length && groups.length > 0) {
                console.log("==> First flight-update keys:", Object.keys(data));
                console.log("==> First group keys:", Object.keys(groups[0]));
                console.log("==> First pricingOptions raw:", JSON.stringify(groups[0].pricingOptions || groups[0].offers || []).slice(0, 800));
              }
              console.log("==> Flight update, total:", flightGroups.length);
            } else if (currentEvent === "search-complete") {
              summary = data.summary || {};
              clearTimeout(timeout);
              done = true;
              break;
            }
          } catch(e) {}
        }
      }
    }

    clearTimeout(timeout);
    console.log("==> Final count:", flightGroups.length);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const f of flightGroups) {
      const sig = f.signature || f.humanSignature || f.flightSignature || JSON.stringify(f).slice(0, 80);
      if (!seen.has(sig)) { seen.add(sig); unique.push(f); }
    }

    // Sort by price
    unique.sort((a, b) => getPrice(a) - getPrice(b));

    // Direct flights (1 segment)
    const direct = unique.filter(f => getSegments(f).length === 1);

    // Extract miles
    const miles = [];
    for (const f of unique) {
      const pricing = f.pricingOptions || f.offers || [];
      for (const p of pricing) {
        const pts = p.miles || p.points || p.totalMiles || p.totalPoints || p.milesAmount ||
          (p.pointsInfo && (p.pointsInfo.totalPoints || p.pointsInfo.miles || p.pointsInfo.points)) ||
          (p.loyalty && (p.loyalty.points || p.loyalty.miles));
        if (!pts) continue;
        const prog = (p.program || p.milesProgram || p.pointsType || p.loyaltyProgram || p.provider || p.type || "").toLowerCase();
        miles.push({
          airline: getAirline(f),
          departureDateTime: getDepDateTime(f),
          arrivalDateTime: getArrDateTime(f),
          pointsRequired: pts,
          pointsType: prog,
          taxAmount: p.taxes || p.taxAmount || 0,
          totalCashEquivalent: (pts * 0.014) + (p.taxes || p.taxAmount || 0),
          providerId: p.provider || p.providerId || "",
          flightSignature: f.signature || "",
        });
      }
    }
    miles.sort((a, b) => a.totalCashEquivalent - b.totalCashEquivalent);

    console.log("==> Direct:", direct.length, "Miles:", miles.length);
    if (direct.length > 0) {
      console.log("==> First direct dep:", getDepTime(direct[0]), "airline:", getAirline(direct[0]));
    }

    return res.json({
      requestId, tokens,
      summary: {
        totalFlights: unique.length,
        totalDirectFlights: direct.length,
        totalMilesOffers: miles.length,
      },
      flightGroups: unique,
      directFlights: direct,
      milesGroups: miles,
    });

  } catch(err) {
    console.log("==> Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log("Server running on port " + PORT));

// ─── HELPERS com estrutura real da API ───────────────────────────────────────
function getSegments(f) {
  if (Array.isArray(f.flightInfo) && f.flightInfo[0])
    return f.flightInfo[0].segments || [];
  if (f.flightInfo && f.flightInfo.itineraries && f.flightInfo.itineraries[0])
    return f.flightInfo.itineraries[0].segments || [];
  if (f.slices && f.slices[0]) return f.slices[0].segments || [];
  return [];
}

function getDepTime(f) {
  const segs = getSegments(f);
  if (segs.length > 0 && segs[0].departure) {
    return segs[0].departure.time || (segs[0].departure.dateTime || "").slice(11, 16) || "";
  }
  return "";
}

function getDepDateTime(f) {
  const segs = getSegments(f);
  if (segs.length > 0 && segs[0].departure) {
    return segs[0].departure.dateTime || "";
  }
  return "";
}

function getArrDateTime(f) {
  const segs = getSegments(f);
  if (segs.length > 0) {
    const last = segs[segs.length - 1];
    return (last.arrival && last.arrival.dateTime) ? last.arrival.dateTime : "";
  }
  return "";
}

function getArrTime(f) {
  const segs = getSegments(f);
  if (segs.length > 0) {
    const last = segs[segs.length - 1];
    if (last.arrival) {
      return last.arrival.time || (last.arrival.dateTime || "").slice(11, 16) || "";
    }
  }
  return "";
}

function getAirline(f) {
  const segs = getSegments(f);
  if (segs.length > 0 && segs[0].marketingCarrier) {
    const code = segs[0].marketingCarrier.code || "";
    const map = { "AD": "Azul", "G3": "Gol", "LA": "LATAM", "JJ": "LATAM" };
    return map[code] || code;
  }
  return f.airline || "";
}

function getPrice(f) {
  const p = f.pricingOptions || f.offers || [];
  if (p.length > 0) {
    const p0 = p[0];
    return p0.totalPrice || p0.total || p0.price || p0.amount ||
           p0.grandTotal || p0.totalAmount || p0.fare || p0.totalFare || 0;
  }
  return f.price || f.total || f.totalPrice || f.amount || 0;
}
