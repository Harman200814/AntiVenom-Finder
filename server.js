// server.js
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

// ---------- Load .env (no extra dependency) ----------
function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

const db = require("./db");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------- Admin credentials (never hard-code secrets in source) ----------
// Prefer ADMIN_PASSWORD_HASH (bcrypt). If only ADMIN_PASSWORD is set, it is
// hashed once at startup and the plain value is not kept in a named constant
// used for comparison.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "Codecrasher";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  require("crypto").randomBytes(32).toString("hex");

let adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || null;
if (!adminPasswordHash && process.env.ADMIN_PASSWORD) {
  adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
  // Do not retain the plain password on process.env for the rest of the run
  delete process.env.ADMIN_PASSWORD;
}
if (!adminPasswordHash) {
  console.warn(
    "WARNING: No ADMIN_PASSWORD or ADMIN_PASSWORD_HASH in .env — admin login disabled until you set one."
  );
}

// Bcrypt cost for new hospital password hashes
const BCRYPT_ROUNDS = 12;

// ---------- Simple in-memory rate limit for login endpoints ----------
const loginAttempts = new Map(); // key -> { count, resetAt }
function rateLimitLogin(key, maxAttempts = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    loginAttempts.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > maxAttempts) {
    return false;
  }
  return true;
}

app.use(express.json({ limit: "100kb" }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      httpOnly: true,
      sameSite: "lax",
      // secure: true  // enable when serving over HTTPS
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers ----------
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function freshnessStatus(available, quantity, lastUpdated) {
  if (!available || quantity <= 0) return "red";
  const ageHours = (Date.now() - new Date(lastUpdated).getTime()) / 36e5;
  return ageHours <= 1 ? "green" : "yellow";
}

function publicHospital(h) {
  return {
    id: h.id,
    name: h.name,
    address: h.address,
    lat: h.lat,
    lng: h.lng,
    phone: h.phone,
    email: h.email,
    status: h.status, // 'pending' | 'approved' | 'rejected'
  };
}

function requireAuth(req, res, next) {
  if (!req.session.hospitalId) return res.status(401).json({ error: "Not logged in" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: "Admin login required" });
  next();
}

// ============ PUBLIC: antivenom categories ============
app.get("/api/antivenoms", (req, res) => {
  res.json(db.prepare("SELECT * FROM antivenoms").all());
});

// ============ PUBLIC: trust-strip stats (real counts, not fabricated) ============
app.get("/api/stats", (req, res) => {
  const approvedHospitals = db.prepare("SELECT COUNT(*) c FROM hospitals WHERE status = 'approved'").get().c;
  const antivenomTypes = db.prepare("SELECT COUNT(*) c FROM antivenoms").get().c;
  const reportsLogged = db.prepare("SELECT COUNT(*) c FROM bite_reports").get().c;
  res.json({ approvedHospitals, antivenomTypes, reportsLogged });
});

// ============ PUBLIC: hospital search (approved hospitals only) ============
// body: { category, lat, lng }
app.post("/api/hospitals/search", (req, res) => {
  const { category, lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  const rows = db
    .prepare(
      `SELECT h.*, i.quantity, i.available, i.last_updated
       FROM hospitals h
       LEFT JOIN antivenoms a ON a.category = ?
       LEFT JOIN inventory i ON i.hospital_id = h.id AND i.antivenom_id = a.id
       WHERE h.status = 'approved'`
    )
    .all(category);

  const results = rows.map((h) => ({
    id: h.id,
    name: h.name,
    address: h.address,
    phone: h.phone,
    lat: h.lat,
    lng: h.lng,
    verified: true, // only approved hospitals reach this endpoint at all
    distanceKm: Number(distanceKm(lat, lng, h.lat, h.lng).toFixed(1)),
    quantity: h.quantity || 0,
    available: !!h.available,
    lastUpdated: h.last_updated,
    status: freshnessStatus(h.available, h.quantity || 0, h.last_updated),
  }));

  results.sort((a, b) => a.distanceKm - b.distanceKm);
  res.json(results);
});

// ============ PUBLIC: submit a bite report (user data about the incident) ============
app.post("/api/bite-reports", (req, res) => {
  const { ai_species, ai_category, ai_confidence, lat, lng, notes, phone } = req.body;
  const stmt = db.prepare(`
    INSERT INTO bite_reports (ai_species, ai_category, ai_confidence, user_lat, user_lng, notes, contact_phone)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ai_species || null,
    ai_category || null,
    ai_confidence || null,
    typeof lat === "number" ? lat : null,
    typeof lng === "number" ? lng : null,
    notes || null,
    phone || null
  );
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ============ HOSPITAL AUTH ============
app.post("/api/hospital/register", (req, res) => {
  const { name, address, lat, lng, phone, email, password } = req.body;
  if (!name || !email || !password || typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Name, email, password, and location are required." });
  }
  const existing = db.prepare("SELECT id FROM hospitals WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "An account with this email already exists." });

  const password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  // Every new registration starts 'pending' — it will NOT appear in public
  // search results until the site operator approves it from /admin.html.
  // This is what keeps fake/unverified hospital data out of public view.
  const info = db
    .prepare(
      `INSERT INTO hospitals (name, address, lat, lng, phone, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(name, address || "", lat, lng, phone || "", email, password_hash);

  const antivenoms = db.prepare("SELECT id FROM antivenoms").all();
  const insertInv = db.prepare(
    "INSERT INTO inventory (hospital_id, antivenom_id, quantity, available, last_updated) VALUES (?, ?, 0, 0, ?)"
  );
  antivenoms.forEach((a) => insertInv.run(info.lastInsertRowid, a.id, new Date().toISOString()));

  req.session.hospitalId = info.lastInsertRowid;
  const hospital = db.prepare("SELECT * FROM hospitals WHERE id = ?").get(info.lastInsertRowid);
  res.json(publicHospital(hospital));
});

app.post("/api/hospital/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimitLogin("hospital:" + ip)) {
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }
  const { email, password } = req.body || {};
  const hospital = db.prepare("SELECT * FROM hospitals WHERE email = ?").get(email);
  if (!hospital || !bcrypt.compareSync(password || "", hospital.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.hospitalId = hospital.id;
  res.json(publicHospital(hospital));
});

app.post("/api/hospital/logout", (req, res) => {
  delete req.session.hospitalId;
  res.json({ ok: true });
});

app.get("/api/hospital/me", (req, res) => {
  if (!req.session.hospitalId) return res.status(401).json({ error: "Not logged in" });
  const hospital = db.prepare("SELECT * FROM hospitals WHERE id = ?").get(req.session.hospitalId);
  if (!hospital) return res.status(401).json({ error: "Not logged in" });
  res.json(publicHospital(hospital));
});

// ============ PUBLIC: hospital directory + doctor contacts (for the Contacts page) ============
app.get("/api/directory", (req, res) => {
  const hospitals = db
    .prepare("SELECT id, name, address, phone, lat, lng FROM hospitals WHERE status = 'approved' ORDER BY name")
    .all();
  const doctors = db
    .prepare(
      `SELECT d.id, d.name, d.specialty, d.phone, h.name AS hospital_name, h.id AS hospital_id
       FROM doctors d JOIN hospitals h ON h.id = d.hospital_id
       WHERE h.status = 'approved' ORDER BY h.name`
    )
    .all();
  res.json({ hospitals, doctors });
});

// ============ HOSPITAL DASHBOARD (auth required) ============
app.get("/api/hospital/inventory", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.category, a.name, i.quantity, i.available, i.last_updated
       FROM antivenoms a
       LEFT JOIN inventory i ON i.antivenom_id = a.id AND i.hospital_id = ?`
    )
    .all(req.session.hospitalId);
  res.json(rows);
});

app.post("/api/hospital/inventory", requireAuth, (req, res) => {
  const { category, quantity, available } = req.body;
  const antivenom = db.prepare("SELECT id FROM antivenoms WHERE category = ?").get(category);
  if (!antivenom) return res.status(400).json({ error: "Unknown antivenom category." });

  db.prepare(
    `INSERT INTO inventory (hospital_id, antivenom_id, quantity, available, last_updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hospital_id, antivenom_id)
     DO UPDATE SET quantity = excluded.quantity, available = excluded.available, last_updated = excluded.last_updated`
  ).run(req.session.hospitalId, antivenom.id, Number(quantity), available ? 1 : 0, new Date().toISOString());

  res.json({ ok: true });
});

// ============ HOSPITAL: manage doctor contacts (auth required) ============
app.get("/api/hospital/doctors", requireAuth, (req, res) => {
  const doctors = db.prepare("SELECT * FROM doctors WHERE hospital_id = ? ORDER BY id DESC").all(req.session.hospitalId);
  res.json(doctors);
});

app.post("/api/hospital/doctors", requireAuth, (req, res) => {
  const { name, specialty, phone } = req.body;
  if (!name) return res.status(400).json({ error: "Doctor name is required." });
  const info = db
    .prepare("INSERT INTO doctors (hospital_id, name, specialty, phone) VALUES (?, ?, ?, ?)")
    .run(req.session.hospitalId, name, specialty || "", phone || "");
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete("/api/hospital/doctors/:id", requireAuth, (req, res) => {
  const doctor = db.prepare("SELECT * FROM doctors WHERE id = ?").get(req.params.id);
  if (!doctor || doctor.hospital_id !== req.session.hospitalId) {
    return res.status(404).json({ error: "Doctor not found." });
  }
  db.prepare("DELETE FROM doctors WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ============ ADMIN (site operator) — approve/reject hospital registrations ============
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimitLogin("admin:" + ip)) {
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }
  const { username, password } = req.body || {};
  if (!adminPasswordHash) {
    return res.status(503).json({ error: "Admin login is not configured on this server." });
  }
  const userOk = typeof username === "string" && username === ADMIN_USERNAME;
  const passOk =
    typeof password === "string" &&
    password.length > 0 &&
    bcrypt.compareSync(password, adminPasswordHash);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

app.get("/api/admin/hospitals", requireAdmin, (req, res) => {
  const hospitals = db
    .prepare("SELECT id, name, address, lat, lng, phone, email, status, created_at FROM hospitals ORDER BY created_at DESC")
    .all();
  res.json(hospitals);
});

app.post("/api/admin/hospitals/:id/status", requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Status must be pending, approved, or rejected." });
  }
  const hospital = db.prepare("SELECT id FROM hospitals WHERE id = ?").get(req.params.id);
  if (!hospital) return res.status(404).json({ error: "Hospital not found." });
  db.prepare("UPDATE hospitals SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`AntiVenom Finder running at http://localhost:${PORT}`);
  console.log(`Demo hospital login: govt.hospital@demo.local / demo1234`);
  console.log(`Admin panel: http://localhost:${PORT}/admin-login.html`);
  console.log(`Admin username: ${ADMIN_USERNAME} (password from .env, stored as bcrypt hash in memory)`);
});
