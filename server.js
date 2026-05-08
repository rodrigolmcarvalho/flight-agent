const express = require("express");
const path = require("path");
const { execFile, execSync } = require("child_process");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const PYTHON = process.platform === "win32" ? "python" : "python3";
const SEARCH_SCRIPT = path.join(__dirname, "search.py");

// Install fli Python library at startup so it's available regardless of how
// Render launches the process. Try both known pip package names.
(function installPythonDeps() {
  const flags = ["--user", "--break-system-packages", ""];
  const pkgs  = ["fli", "flights"];
  for (const pkg of pkgs) {
    for (const flag of flags) {
      try {
        const cmd = `${PYTHON} -m pip install ${pkg} -q${flag ? " " + flag : ""}`;
        console.log("==> pip:", cmd);
        execSync(cmd, { stdio: "pipe", timeout: 60000 });
        // Verify the import works
        execSync(`${PYTHON} -c "import fli"`, { stdio: "pipe", timeout: 5000 });
        console.log(`==> fli installed via '${pkg}' (${flag || "no flag"})`);
        return;
      } catch (_) {}
    }
  }
  console.log("==> WARNING: could not install fli. Searches will return empty results.");
})();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "9" });
});

app.get("/api/test-python", async (req, res) => {
  const { exec } = require("child_process");
  const run = (label, cmd) => new Promise(resolve => {
    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ label, cmd, out: stdout.trim(), err: stderr.trim(), exitErr: err ? err.message : null });
    });
  });

  // Sequential pip installs to avoid race conditions
  const pipFli     = await run("pip install fli --user",     `${PYTHON} -m pip install fli --user -q 2>&1`);
  const pipFlights = await run("pip install flights --user", `${PYTHON} -m pip install flights --user -q 2>&1`);
  const pipFliBS   = await run("pip install fli --break-system-packages", `${PYTHON} -m pip install fli --break-system-packages -q 2>&1`);

  const checks = await Promise.all([
    run("python version",       `${PYTHON} --version`),
    run("pip list (fli-related)", `${PYTHON} -m pip list 2>/dev/null | grep -i -E 'fli|flight'`),
    run("import fli",           `${PYTHON} -c "import fli; print(fli.__version__ if hasattr(fli,'__version__') else 'imported ok')"`),
    run("Airport.CNF",          `${PYTHON} -c "from fli.models import Airport; print(Airport['CNF'] if 'CNF' in Airport._member_names_ else 'CNF NOT in enum')"`),
    run("Airport.SDU",          `${PYTHON} -c "from fli.models import Airport; print(Airport['SDU'] if 'SDU' in Airport._member_names_ else 'SDU NOT in enum')"`),
    run("Airport.GIG",          `${PYTHON} -c "from fli.models import Airport; print(Airport['GIG'] if 'GIG' in Airport._member_names_ else 'GIG NOT in enum')"`),
    run("BR airports in enum",  `${PYTHON} -c "from fli.models import Airport; br=[n for n in Airport._member_names_ if n in {'CNF','SDU','GIG','GRU','BSB','SSA','FOR','REC'}]; print('found:', br)"`),
  ]);

  res.json({ python: PYTHON, pipInstalls: [pipFli, pipFlights, pipFliBS], checks });
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

// Debug: run search.py and return raw stdout+stderr
app.get("/api/test-search", async (req, res) => {
  const { exec } = require("child_process");
  const origin = req.query.from || "CNF";
  const dest   = req.query.to   || "SDU";
  const date   = req.query.date || "2026-05-18";
  const cmd = `${PYTHON} ${SEARCH_SCRIPT} ${origin} ${dest} ${date}`;
  console.log("==> test-search:", cmd);
  exec(cmd, { timeout: 60000, maxBuffer: 1024*1024 }, (err, stdout, stderr) => {
    res.json({
      cmd,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
      exitErr: err ? err.message : null,
    });
  });
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
