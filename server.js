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
  res.json({ status: "ok", key: APIDEVOOS_KEY ? "set" : "missing", version: "5" });
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
            } else if (currentEvent === "search-complete") {
              clearTimeout(timeout);
              done = true;
              break;
            }
          } catch(e) {}
        }
      }
    }

    clearTimeout(timeout);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const f of flightGroups) {
      const sig = f.signature || f.humanSignature || f.flightSignature || JSON.stringify(f).slice(0, 80);
      if (!seen.has(sig)) { seen.add(sig); unique.push(f); }
    }
    console.log("==> Collected:", flightGroups.length, "Unique:", unique.length);

    // Log first flight's raw pricingOptions for price debugging
    if (unique.length > 0) {
      const f0 = unique[0];
      console.log("==> flightInfo type:", Array.isArray(f0.flightInfo) ? "array[" + f0.flightInfo.length + "]" : typeof f0.flightInfo);
      console.log("==> First flight pricingOptions RAW:", JSON.stringify(getPricing(f0)).slice(0, 600));
    }

    // Airline breakdown
    const byAirline = {}, byAirlineDirect = {};
    for (const f of unique) {
      const a = getAirline(f) || "?";
      byAirline[a] = (byAirline[a] || 0) + 1;
      if (getSegments(f).length === 1) byAirlineDirect[a] = (byAirlineDirect[a] || 0) + 1;
    }
    console.log("==> By airline (all):", JSON.stringify(byAirline));
    console.log("==> By airline (direct):", JSON.stringify(byAirlineDirect));

    // Direct flights only (1 segment), sorted by price
    const direct = unique.filter(f => getSegments(f).length === 1);
    direct.sort((a, b) => getPrice(a) - getPrice(b));
    console.log("==> Direct:", direct.length);

    // Log every pricingOption for first Azul and first Gol direct flight
    for (const airline of ["Azul", "Gol"]) {
      const fl = direct.find(f => getAirline(f) === airline);
      if (!fl) { console.log(`==> ${airline}: no direct found`); continue; }
      const opts = getPricing(fl);
      console.log(`==> ${airline} dep=${getDepTime(fl)} opts=${opts.length} computedMin=${getPrice(fl)}`);
      opts.forEach((p, i) => {
        const pr = p.price && typeof p.price === "object" ? p.price : {};
        console.log(`    [${i}] providerId=${p.providerId} baseFare=${pr.baseFare} total=${pr.total} adultPrice=${pr.adultPrice} extracted=${extractPrice(p)}`);
      });
    }

    // Miles from all flights
    const miles = [];
    for (const f of unique) {
      for (const p of getPricing(f)) {
        const priceObj = p.price && typeof p.price === "object" ? p.price : {};
        const info = priceObj.pointsInfo || p.pointsInfo || p.milesInfo || {};
        const pts = info.totalPoints || info.points || info.miles ||
          p.miles || p.points || p.totalMiles || p.totalPoints || 0;
        if (!pts) continue;
        const prog = (info.pointsType || info.program ||
          p.providerId || p.program || p.pointsType || "").toLowerCase();
        // Domestic airport taxes are at most ~R$150. Any individual item > R$200
        // is a platform fee (e.g. Livelo BOARDING ~R$3100) — exclude it.
        const taxAmt = Array.isArray(priceObj.taxes)
          ? priceObj.taxes.filter(t => (t.amount || 0) <= 200).reduce((s, t) => s + (t.amount || 0), 0)
          : Math.min(typeof p.taxes === "object" && p.taxes ? (p.taxes.amount || 0) : (p.taxes || p.taxAmount || 0), 200);
        const segs = getSegments(f);
        const dep = segs.length > 0 && segs[0].departure ? (segs[0].departure.time || "") : "";
        const lastSeg = segs[segs.length - 1];
        const arr = lastSeg && lastSeg.arrival ? (lastSeg.arrival.time || "") : "";
        miles.push({
          airline: getAirline(f),
          departure: dep,
          arrival: arr,
          pointsRequired: pts,
          pointsType: prog,
          taxAmount: taxAmt,
          cashEquivalent: Math.round(pts * 0.014 + taxAmt),
          providerId: p.providerId || priceObj.source || prog,
        });
      }
    }
    miles.sort((a, b) => a.cashEquivalent - b.cashEquivalent);
    console.log("==> Miles:", miles.length);

    return res.json({
      requestId, tokens,
      summary: { totalFlights: unique.length, totalDirectFlights: direct.length, totalMilesOffers: miles.length },
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getSegments(f) {
  if (Array.isArray(f.flightInfo) && f.flightInfo[0])
    return f.flightInfo[0].segments || [];
  if (f.flightInfo && f.flightInfo.itineraries && f.flightInfo.itineraries[0])
    return f.flightInfo.itineraries[0].segments || [];
  if (f.slices && f.slices[0]) return f.slices[0].segments || [];
  return [];
}

function getAirline(f) {
  const segs = getSegments(f);
  if (segs.length > 0 && segs[0].marketingCarrier) {
    const code = segs[0].marketingCarrier.code || "";
    return { "AD":"Azul", "G3":"Gol", "LA":"LATAM", "JJ":"LATAM" }[code] || code;
  }
  return f.airline || "";
}

function getPricing(f) {
  const opts = [];
  if (f.pricingOptions && f.pricingOptions.length) opts.push(...f.pricingOptions);
  if (f.offers && f.offers.length) opts.push(...f.offers);
  return opts;
}

function extractPrice(offer) {
  const pr = offer.price;
  if (pr && typeof pr === "object") {
    // baseFare is always the real ticket cost — for Livelo price.total adds a ~R$3100
    // platform fee on top, so we must prefer baseFare regardless of providerId.
    return pr.baseFare || pr.adultPrice || pr.companyPrice ||
           pr.total || pr.grandTotal || pr.amount || pr.totalAmount || pr.fare || pr.totalFare || 0;
  }
  if (typeof pr === "number" && pr > 0) return pr;
  return offer.totalPrice || offer.total || offer.totalAmount ||
         offer.amount || offer.grandTotal || offer.fare || 0;
}

function getPrice(f) {
  const all = getPricing(f);
  if (all.length === 0) return f.price || f.total || f.totalPrice || f.amount || 0;
  const prices = all.map(extractPrice).filter(x => x > 0);
  return prices.length > 0 ? Math.min(...prices) : 0;
}

function getDepTime(f) {
  const segs = getSegments(f);
  if (segs.length > 0 && segs[0].departure)
    return segs[0].departure.time || (segs[0].departure.dateTime || "").slice(11, 16) || "";
  return "";
}
