const express = require("express");
const path = require("path");
const { execFile } = require("child_process");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const PYTHON = process.platform === "win32" ? "python" : "python3";
const SEARCH_SCRIPT = path.join(__dirname, "search.py");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "6" });
});

app.post("/api/search", async (req, res) => {
  const slices = (req.body && req.body.slices) || [];
  if (!slices.length) return res.status(400).json({ error: "No slices provided" });

  const { origin, destination, departureDate } = slices[0];
  if (!origin || !destination || !departureDate)
    return res.status(400).json({ error: "Missing origin/destination/date" });

  console.log(`==> Search ${origin}→${destination} ${departureDate}`);

  try {
    const flights = await runPython(origin, destination, departureDate);

    const byAirline = {};
    flights.forEach(f => { byAirline[f.airline] = (byAirline[f.airline] || 0) + 1; });
    console.log(`==> Results: ${flights.length} flights  airlines:`, JSON.stringify(byAirline));

    return res.json({
      requestId: "",
      tokens: {},
      summary: {
        totalFlights: flights.length,
        totalDirectFlights: flights.length,
        totalMilesOffers: 0,
      },
      directFlights: flights,
      milesGroups: [],
    });
  } catch (err) {
    console.log("==> Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log("Server running on port " + PORT));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function runPython(origin, dest, date) {
  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [SEARCH_SCRIPT, origin, dest, date],
      { timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) console.log("==> Python:", stderr.trim().slice(0, 400));
        if (err) {
          console.log("==> Python exit error:", err.message);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          console.log("==> JSON parse error:", e.message, "| stdout:", stdout.slice(0, 200));
          resolve([]);
        }
      }
    );
  });
}
