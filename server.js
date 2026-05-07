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
                console.log("==> First pricingOptions raw:", JSON.stringify(groups[0].pricingOptions || []));
              console.log("==> First offers raw:", JSON.stringify(groups[0].offers || []));
              }
              console.log("==> Flight update, total:", flightGroups.length);
            } else if (currentEvent === "search-complete") {
              summary = data.summary || {};
              console.log("==> search-complete keys:", Object.keys(data));
              const scStr = JSON.stringify(data);
              if (/mile|point|reward|smiles|azul/i.test(scStr)) {
                console.log("==> search-complete miles/points data:", scStr.slice(0, 800));
              }
              clearTimeout(timeout);
              done = true;
              break;
            } else if (currentEvent) {
              console.log("==> Unknown SSE event:", currentEvent, JSON.stringify(data).slice(0, 300));
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

    // Airline breakdown: total vs direct
    const totalByAirline = {}, directByAirline = {};
    for (const f of unique) {
      const a = getAirline(f) || "?";
      totalByAirline[a] = (totalByAirline[a]||0) + 1;
      if (getSegments(f).length === 1) directByAirline[a] = (directByAirline[a]||0) + 1;
    }
    console.log("==> By airline total:", JSON.stringify(totalByAirline));
    console.log("==> By airline direct:", JSON.stringify(directByAirline));

    // Full raw pricingOptions dump for first Gol and Azul flight
    const golFlight  = unique.find(f => getAirline(f) === "Gol");
    const azulFlight = unique.find(f => getAirline(f) === "Azul");
    for (const [name, fl] of [["Gol", golFlight], ["Azul", azulFlight]]) {
      if (!fl) { console.log(`==> ${name}: not found in results`); continue; }
      const pricing = getPricing(fl);
      console.log(`==> ${name}: segs=${getSegments(fl).length} pricingOpts=${pricing.length} computedPrice=${getPrice(fl)}`);
      // Log complete raw pricingOptions so cabin class / fare type fields are visible
      console.log(`==> ${name} pricingOptions RAW:`, JSON.stringify(fl.pricingOptions || []));
      console.log(`==> ${name} offers RAW:`, JSON.stringify(fl.offers || []));
      const mileKeys = Object.keys(fl).filter(k => /mile|point|reward|smiles|azul|loyalty/i.test(k));
      console.log(`    miles-related keys: ${mileKeys.length ? mileKeys.join(",") : "(none)"}`);
    }

    // Azul departure times — check if early morning flights are in API response
    const azulDeps = unique
      .filter(f => getAirline(f) === "Azul" && getSegments(f).length === 1)
      .map(f => getDepTime(f))
      .sort();
    console.log("==> Azul direct departure times:", azulDeps.length ? azulDeps : "(none)");

    // Sort by price
    unique.sort((a, b) => getPrice(a) - getPrice(b));

    // Direct flights (1 segment)
    const direct = unique.filter(f => getSegments(f).length === 1);

    // Extract miles
    const miles = [];
    for (const f of unique) {
      const pricing = getPricing(f);
      for (const p of pricing) {
        // Real API: pointsInfo lives inside offer.price, not directly on the offer
        const priceObj = p.price && typeof p.price === "object" ? p.price : {};
        const info = priceObj.pointsInfo || p.pointsInfo || p.milesInfo || {};
        const pts = info.totalPoints || info.points || info.miles ||
          p.miles || p.points || p.totalMiles || p.totalPoints || 0;
        if (!pts) continue;
        const prog = (info.pointsType || info.program ||
          p.providerId || p.program || p.pointsType || "").toLowerCase();
        // Taxes come as an array [{code, amount}] inside offer.price.taxes
        const taxAmt = Array.isArray(priceObj.taxes)
          ? priceObj.taxes.reduce((s, t) => s + (t.amount || 0), 0)
          : (typeof p.taxes === "object" && p.taxes ? (p.taxes.amount || 0) : (p.taxes || p.taxAmount || 0));
        miles.push({
          airline: getAirline(f),
          departureDateTime: getDepDateTime(f),
          arrivalDateTime: getArrDateTime(f),
          pointsRequired: pts,
          pointsType: prog,
          taxAmount: taxAmt,
          totalCashEquivalent: (pts * 0.014) + taxAmt,
          providerId: p.providerId || priceObj.source || prog,
          flightSignature: f.signature || "",
        });
      }
    }
    miles.sort((a, b) => a.totalCashEquivalent - b.totalCashEquivalent);
    console.log("==> Direct:", direct.length, "Miles found:", miles.length);
    if (miles.length === 0 && unique.length > 0) {
      console.log("==> No miles found. Checking first 2 pricing options for any points-like keys:");
      for (const f of unique.slice(0, 2)) {
        for (const p of getPricing(f).slice(0, 2)) {
          const keys = Object.keys(p).join(",");
          const prKeys = p.price && typeof p.price === "object" ? Object.keys(p.price).join(",") : "n/a";
          console.log(`  pricing keys: [${keys}] price keys: [${prKeys}]`);
          console.log(`  full opt:`, JSON.stringify(p));
        }
      }
    }
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

function getPricing(f) {
  const opts = [];
  if (f.pricingOptions && f.pricingOptions.length) opts.push(...f.pricingOptions);
  if (f.offers && f.offers.length) opts.push(...f.offers);
  return opts;
}

// Returns false only if the option is explicitly non-economy (business/first/premium).
// Unknown cabin class → included (conservative — don't over-filter).
function isEconomyOpt(opt) {
  const NON_ECO = /business|executiv|first|premium|suite/i;
  for (const key of ["cabinClass","cabin","fareClass","class","fareType","service","cabinType","productClass","fareFamily"]) {
    const v = opt[key];
    if (v && NON_ECO.test(String(v))) return false;
  }
  return true;
}

function extractPrice(offer) {
  const pr = offer.price;
  if (pr && typeof pr === "object") {
    // Livelo's price.total = baseFare + R$3100 platform fee — use baseFare (actual ticket cost)
    if (offer.providerId === "livelo") {
      return pr.baseFare || pr.adultPrice || pr.companyPrice || pr.total || 0;
    }
    return pr.total || pr.baseFare || pr.grandTotal || pr.amount ||
           pr.totalAmount || pr.fare || pr.totalFare || 0;
  }
  if (typeof pr === "number" && pr > 0) return pr;
  return offer.totalPrice || offer.total || offer.totalAmount ||
         offer.amount || offer.grandTotal || offer.fare || 0;
}

function getBookingUrl(f) {
  const all = getPricing(f);
  const eco = all.filter(isEconomyOpt);
  const pool = eco.length > 0 ? eco : all;
  pool.sort((a, b) => extractPrice(a) - extractPrice(b));
  for (const o of pool) {
    if (o.booking && o.booking.bookingUrl) return o.booking.bookingUrl;
  }
  return null;
}

function getPrice(f) {
  const all = getPricing(f);
  if (all.length > 0) {
    const eco = all.filter(isEconomyOpt);
    const pool = eco.length > 0 ? eco : all; // fallback: use all if nothing passes economy filter
    const prices = pool.map(extractPrice).filter(x => x > 0);
    return prices.length > 0 ? Math.min(...prices) : 0;
  }
  return f.price || f.total || f.totalPrice || f.amount || 0;
}
