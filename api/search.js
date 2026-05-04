const APIDEVOOS_KEY = process.env.APIDEVOOS_KEY;
const BASE_URL = "https://app.apidevoos.dev/api/v1/flights";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Use SSE stream endpoint and collect all events
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

    // Collect SSE events
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let flightGroups = [];
    let milesGroups = [];
    let tokens = {};
    let summary = {};
    let filters = {};
    let requestId = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; }, 28000);

    while (!timedOut) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const data = JSON.parse(dataStr);
            if (currentEvent === "search-initialized") {
              requestId = data.requestId || "";
              tokens = data.tokens || {};
            } else if (currentEvent === "flight-update") {
              const groups = data.newGroups || data.flightGroups || [];
              flightGroups = flightGroups.concat(groups);
            } else if (currentEvent === "filters-update") {
              filters = data.filters || data;
            } else if (currentEvent === "search-complete") {
              summary = data.summary || {};
              timedOut = false;
              clearTimeout(timeout);
              break;
            }
          } catch (e) { /* skip malformed */ }
        }
      }
      if (currentEvent === "search-complete") break;
    }

    clearTimeout(timeout);

    // Deduplicate flight groups by signature
    const seen = new Set();
    const uniqueFlights = [];
    for (const f of flightGroups) {
      const sig = f.flightSignature || f.humanSignature || JSON.stringify(f).slice(0, 50);
      if (!seen.has(sig)) {
        seen.add(sig);
        uniqueFlights.push(f);
      }
    }

    // Extract miles groups from flight offers
    const milesOffers = [];
    for (const f of uniqueFlights) {
      if (f.offers) {
        for (const offer of f.offers) {
          if (offer.pointsInfo || offer.milesInfo) {
            const info = offer.pointsInfo || offer.milesInfo;
            const dep = f.slices && f.slices[0] && f.slices[0].segments && f.slices[0].segments[0]
              ? f.slices[0].segments[0].departureAt || ""
              : f.departureDateTime || "";
            const segs = f.slices && f.slices[0] && f.slices[0].segments ? f.slices[0].segments : [];
            const arr = segs.length > 0 ? segs[segs.length - 1].arrivalAt || "" : f.arrivalDateTime || "";
            milesOffers.push({
              airline: f.airline || (f.validatingAirlineCodes && f.validatingAirlineCodes[0]) || "",
              departureAirport: f.origin || "",
              arrivalAirport: f.destination || "",
              departureDateTime: dep,
              arrivalDateTime: arr,
              pointsRequired: info.totalPoints || info.points || 0,
              pointsType: (info.pointsType || info.program || "").toLowerCase(),
              taxAmount: offer.taxes ? offer.taxes.amount || 0 : 0,
              totalCashEquivalent: ((info.totalPoints || 0) * 0.014) + (offer.taxes ? offer.taxes.amount || 0 : 0),
              providerId: offer.providerId || "",
              flightSignature: f.flightSignature || "",
            });
          }
        }
      }
    }

    // Sort flights by price
    uniqueFlights.sort((a, b) => {
      const pa = a.offers && a.offers[0] ? a.offers[0].total || 0 : 0;
      const pb = b.offers && b.offers[0] ? b.offers[0].total || 0 : 0;
      return pa - pb;
    });

    // Extract direct flights
    const directFlights = uniqueFlights.filter(f => {
      return f.slices && f.slices[0] && f.slices[0].segments && f.slices[0].segments.length === 1;
    });

    // Sort miles by cash equivalent
    milesOffers.sort((a, b) => a.totalCashEquivalent - b.totalCashEquivalent);

    return res.status(200).json({
      requestId,
      timedOut,
      tokens,
      summary: {
        totalFlights: uniqueFlights.length,
        totalDirectFlights: directFlights.length,
        totalMilesOffers: milesOffers.length,
        providers: summary.providers || [],
      },
      filters,
      flightGroups: uniqueFlights,
      directFlights,
      milesGroups: milesOffers,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
