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
  const isRoundTrip = req.body && req.body.type === "round_trip";
  console.log("==> Search type=" + (isRoundTrip ? "round_trip" : "one_way") + ":", JSON.stringify(req.body).slice(0, 150));
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

    // For round_trip: log the structure of the first flight group so we can see
    // how outbound/return legs are stored
    if (isRoundTrip && unique.length > 0) {
      const f0 = unique[0];
      const fi = Array.isArray(f0.flightInfo) ? f0.flightInfo : null;
      console.log("==> [RT] flightInfo:", fi ? "array["+fi.length+"]" : typeof f0.flightInfo);
      if (fi && fi[0]) {
        const itins = fi[0].itineraries;
        if (Array.isArray(itins)) itins.forEach((it,i) => console.log(`  itin[${i}] segs=${(it.segments||[]).length}`));
        else console.log("  no itineraries in flightInfo[0]; keys:", Object.keys(fi[0]));
        if (fi[1]) console.log("  flightInfo[1] segs:", (fi[1].segments||[]).length);
      }
      if (f0.slices) console.log("==> [RT] slices:", f0.slices.map((s,i)=>`slice[${i}] segs=${(s.segments||[]).length}`));

      // Find first Azul SDU direct round-trip flight and dump its COMPLETE pricingOptions
      const azulSDU = unique.find(f => getAirline(f) === "Azul" && getSegments(f).length === 1 &&
        (getSegments(f)[0].departure || {}).iataCode === "CNF");
      const dumpTarget = azulSDU || f0;
      const pricing = getPricing(dumpTarget);
      console.log(`==> [RT-DUMP] airline=${getAirline(dumpTarget)} dep=${getDepTime(dumpTarget)} pricingOptions.length=${pricing.length}`);
      pricing.forEach((p, i) => {
        console.log(`==> [RT-DUMP] pricingOptions[${i}] FULL:`, JSON.stringify(p));
      });
    }

    // Airline breakdown
    const byAirline = {}, byAirlineDirect = {};
    for (const f of unique) {
      const a = getAirline(f) || "?";
      byAirline[a] = (byAirline[a] || 0) + 1;
      const outDirect = getSegments(f).length === 1;
      const retSegs = getReturnSegments(f);
      const retDirect = retSegs.length === 0 || retSegs.length === 1;
      if (outDirect && retDirect) byAirlineDirect[a] = (byAirlineDirect[a] || 0) + 1;
    }
    console.log("==> By airline (all):", JSON.stringify(byAirline));
    console.log("==> By airline (direct):", JSON.stringify(byAirlineDirect));

    // Direct flights: outbound must have 1 segment; for round_trip, return leg too
    const direct = unique.filter(f => {
      if (getSegments(f).length !== 1) return false;
      if (isRoundTrip) {
        const ret = getReturnSegments(f);
        if (ret.length > 0 && ret.length !== 1) return false;
      }
      return true;
    });
    direct.sort((a, b) => getPrice(a) - getPrice(b));
    console.log("==> Direct:", direct.length);

    // Log ALL Azul direct flights: every pricingOption's numeric price fields
    const azulDirect = direct.filter(f => getAirline(f) === "Azul");
    console.log(`==> Azul direct: ${azulDirect.length}`);
    for (const f of azulDirect) {
      const opts = getPricing(f);
      console.log(`  dep=${getDepTime(f)} opts=${opts.length} computedMin=${getPrice(f)}`);
      for (const [i, p] of opts.entries()) {
        const pr = p.price && typeof p.price === "object" ? p.price : {};
        const priceNums = Object.fromEntries(Object.entries(pr).filter(([,v]) => typeof v === "number" && v > 0));
        const offerNums = Object.fromEntries(Object.entries(p).filter(([,v]) => typeof v === "number" && v > 0));
        console.log(`    [${i}] providerId=${p.providerId} price.*=${JSON.stringify(priceNums)} offer.*=${JSON.stringify(offerNums)} extracted=${extractPrice(p)}`);
      }
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
      requestId, tokens, isRoundTrip,
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

function getReturnSegments(f) {
  if (Array.isArray(f.flightInfo)) {
    const fi0 = f.flightInfo[0];
    if (fi0 && Array.isArray(fi0.itineraries) && fi0.itineraries[1]) return fi0.itineraries[1].segments || [];
    if (f.flightInfo[1]) return f.flightInfo[1].segments || [];
  }
  if (f.flightInfo && Array.isArray(f.flightInfo.itineraries) && f.flightInfo.itineraries[1])
    return f.flightInfo.itineraries[1].segments || [];
  if (f.slices && f.slices[1]) return f.slices[1].segments || [];
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

const PRICE_KEYS = ["baseFare","adultPrice","companyPrice","fare","amount","totalFare","total","grandTotal","totalAmount"];

function extractPrice(offer) {
  const pr = offer.price;
  const candidates = [];
  // Always check offer.price.* fields
  if (pr && typeof pr === "object") {
    for (const k of PRICE_KEYS) {
      const v = Number(pr[k]);
      if (v > 50) candidates.push(v);   // >50 excludes rates/flags; domestic fares start ~R$150
    }
  } else if (typeof pr === "number" && pr > 50) {
    candidates.push(pr);
  }
  // Always also check top-level offer.* fields (baseFare may live here for round-trip)
  for (const k of PRICE_KEYS) {
    const v = Number(offer[k]);
    if (v > 50) candidates.push(v);
  }
  return candidates.length ? Math.min(...candidates) : 0;
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
