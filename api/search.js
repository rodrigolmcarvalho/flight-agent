const APIDEVOOS_KEY = process.env.APIDEVOOS_KEY;
const BASE_URL = "https://app.apidevoos.dev/api/v1/flights";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Use the simple search endpoint first
    const upstream = await fetch(BASE_URL + "/search", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + APIDEVOOS_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    const data = await upstream.json();

    // If we got flight groups directly, return them
    if (data.flightGroups && data.flightGroups.length > 0) {
      return res.status(200).json(enrichResponse(data));
    }

    // If search is async (returns token), poll for results
    if (data.requestId || data.tokens) {
      const requestId = data.requestId;
      const maxAttempts = 8;
      const delay = ms => new Promise(r => setTimeout(r, ms));

      for (let i = 0; i < maxAttempts; i++) {
        await delay(2500);
        try {
          const pollRes = await fetch(BASE_URL + "/search/" + requestId, {
            headers: {
              "Authorization": "Bearer " + APIDEVOOS_KEY,
              "Accept": "application/json",
            },
          });
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            if (pollData.flightGroups && pollData.flightGroups.length > 0) {
              return res.status(200).json(enrichResponse(pollData));
            }
            if (pollData.status === "completed" || pollData.completed) {
              return res.status(200).json(enrichResponse(pollData));
            }
          }
        } catch(e) { /* continue polling */ }
      }

      // Return whatever we have after polling
      return res.status(200).json(enrichResponse(data));
    }

    return res.status(200).json(enrichResponse(data));

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function enrichResponse(data) {
  const flights = data.flightGroups || data.flights || data.flightOffers || [];

  // Separate direct flights
  const directFlights = flights.filter(f => {
    const segs = f.slices && f.slices[0] && f.slices[0].segments;
    return segs && segs.length === 1;
  });

  // Sort by price
  flights.sort((a, b) => {
    const pa = getPrice(a);
    const pb = getPrice(b);
    return pa - pb;
  });

  // Extract miles offers
  const milesGroups = [];
  for (const f of flights) {
    if (!f.offers) continue;
    for (const offer of f.offers) {
      const info = offer.pointsInfo || offer.milesInfo;
      if (!info) continue;
      const dep = getDepTime(f);
      const arr = getArrTime(f);
      milesGroups.push({
        airline: f.airline || (f.validatingAirlineCodes && f.validatingAirlineCodes[0]) || "",
        departureAirport: f.origin || (f.slices && f.slices[0] && f.slices[0].origin) || "",
        arrivalAirport: f.destination || (f.slices && f.slices[0] && f.slices[0].destination) || "",
        departureDateTime: dep,
        arrivalDateTime: arr,
        pointsRequired: info.totalPoints || info.points || 0,
        pointsType: (info.pointsType || info.program || "").toLowerCase(),
        taxAmount: offer.taxes ? (offer.taxes.amount || 0) : 0,
        totalCashEquivalent: ((info.totalPoints || 0) * 0.014) + (offer.taxes ? (offer.taxes.amount || 0) : 0),
        providerId: offer.providerId || "",
        flightSignature: f.flightSignature || f.humanSignature || "",
      });
    }
  }

  milesGroups.sort((a, b) => a.totalCashEquivalent - b.totalCashEquivalent);

  return {
    requestId: data.requestId || "",
    timedOut: false,
    tokens: data.tokens || {},
    summary: {
      totalFlights: flights.length,
      totalDirectFlights: directFlights.length,
      totalMilesOffers: milesGroups.length,
    },
    flightGroups: flights,
    directFlights,
    milesGroups,
  };
}

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
