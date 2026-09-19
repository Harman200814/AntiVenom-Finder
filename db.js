// db.js
// Sets up a real SQLite database (a single file: data/antivenom.db).
// SQLite needs no separate server/install — perfect for a hackathon demo,
// but it's a real relational database, not a JSON file pretending to be one.
//
// This uses Node.js's own built-in `node:sqlite` module (available from
// Node 22.5+) instead of the third-party `better-sqlite3` package. The
// built-in version needs no native compilation step, so it can't fail to
// install the way better-sqlite3 sometimes does on machines without C++
// build tools set up.

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (err) {
  console.error(
    "This app needs Node.js version 22.5 or newer (for its built-in database support).\n" +
    "Please install the latest LTS version from https://nodejs.org and try again.\n" +
    "(Your current Node: " + process.version + ")"
  );
  process.exit(1);
}
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

// Ensure data/ exists — zip extracts sometimes omit empty folders, which
// causes "unable to open database" when SQLite tries to create the file.
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("Created data/ folder for the SQLite database.");
  } catch (err) {
    console.error(
      "Could not create the data/ folder next to server.js.\n" +
      "Make sure you have write permission in the project folder.\n" +
      "Error: " + err.message
    );
    process.exit(1);
  }
}

const dbPath = path.join(dataDir, "antivenom.db");
let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  console.error(
    "Unable to open database at:\n  " + dbPath + "\n\n" +
    "Common fixes:\n" +
    "  1. Run npm start from the project root (the folder that contains server.js and db.js).\n" +
    "  2. Ensure the data/ folder is writable (not read-only).\n" +
    "  3. Delete data/antivenom.db if it is corrupted, then start again.\n" +
    "  4. Use Node.js 22.5+ (you have " + process.version + ").\n\n" +
    "Error: " + err.message
  );
  process.exit(1);
}

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS hospitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  phone TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' — set only by the site operator via /admin.html
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS antivenoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS inventory (
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id),
  antivenom_id INTEGER NOT NULL REFERENCES antivenoms(id),
  quantity INTEGER DEFAULT 0,
  available INTEGER DEFAULT 0,
  last_updated TEXT,
  PRIMARY KEY (hospital_id, antivenom_id)
);

-- Every AI-assisted identification + hospital search the public does gets
-- logged here. This is the "data from users about snakes and bites" you
-- asked about — it's what a future Administrator (blueprint Section 4C)
-- would use for regional statistics.
CREATE TABLE IF NOT EXISTS bite_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  ai_species TEXT,
  ai_category TEXT,
  ai_confidence INTEGER,
  user_lat REAL,
  user_lng REAL,
  notes TEXT,
  contact_phone TEXT
);

-- Doctors a hospital chooses to list publicly on the Contacts page.
CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id),
  name TEXT NOT NULL,
  specialty TEXT,
  phone TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- Migration safety net ----------
// If a database from an older version of this app exists (with a `verified`
// column instead of `status`), add `status` alongside it rather than erroring.
const hospitalColumns = db.prepare("PRAGMA table_info(hospitals)").all().map((c) => c.name);
if (!hospitalColumns.includes("status")) {
  db.exec("ALTER TABLE hospitals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (hospitalColumns.includes("verified")) {
    db.exec("UPDATE hospitals SET status = CASE WHEN verified = 1 THEN 'approved' ELSE 'pending' END");
  }
}

// Ensure newer antivenom categories exist even on older databases
const ensureAntivenom = db.prepare(
  "INSERT OR IGNORE INTO antivenoms (name, category) VALUES (?, ?)"
);
[
  ["Polyvalent ASV — Cobra group", "Cobra"],
  ["Polyvalent ASV — Krait group", "Krait"],
  ["Polyvalent ASV — Viper group", "Viper"],
  ["King Cobra monovalent ASV", "KingCobra"],
  ["Pit Viper / supportive ASV stock", "PitViper"],
].forEach(([name, category]) => ensureAntivenom.run(name, category));

// For every hospital, ensure inventory rows exist for all antivenom types
const allHospitals = db.prepare("SELECT id FROM hospitals").all();
const allAntivenoms = db.prepare("SELECT id FROM antivenoms").all();
const ensureInv = db.prepare(
  `INSERT OR IGNORE INTO inventory (hospital_id, antivenom_id, quantity, available, last_updated)
   VALUES (?, ?, 0, 0, ?)`
);
const nowIso = new Date().toISOString();
allHospitals.forEach((h) => {
  allAntivenoms.forEach((a) => ensureInv.run(h.id, a.id, nowIso));
});

// ---------- Seed demo data (only if the database is empty) ----------
const antivenomCount = db.prepare("SELECT COUNT(*) AS c FROM antivenoms").get().c;

if (antivenomCount === 0) {
  const insertAntivenom = db.prepare("INSERT INTO antivenoms (name, category) VALUES (?, ?)");
  const antivenoms = [
    ["Polyvalent ASV — Cobra group", "Cobra"],
    ["Polyvalent ASV — Krait group", "Krait"],
    ["Polyvalent ASV — Viper group", "Viper"],
    ["King Cobra monovalent ASV", "KingCobra"],
    ["Pit Viper / supportive ASV stock", "PitViper"],
  ];
  const antivenomIds = {};
  antivenoms.forEach(([name, category]) => {
    const info = insertAntivenom.run(name, category);
    antivenomIds[category] = info.lastInsertRowid;
  });

  const insertHospital = db.prepare(`
    INSERT INTO hospitals (name, address, lat, lng, phone, email, password_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
  `);
  const insertInventory = db.prepare(`
    INSERT INTO inventory (hospital_id, antivenom_id, quantity, available, last_updated)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Demo login for every seeded hospital: password is "demo1234"
  const demoHash = bcrypt.hashSync("demo1234", 12);

  const demoHospitals = [
    {
      name: "Government Hospital (Demo)",
      address: "Civil Lines, Ludhiana",
      lat: 30.9010, lng: 75.8573,
      phone: "+911615550101",
      email: "govt.hospital@demo.local",
      password_hash: demoHash,
      stock: { Cobra: [12, 1, -10], Krait: [8, 1, -10], Viper: [5, 1, -400], KingCobra: [2, 1, -30], PitViper: [4, 1, -60] },
    },
    {
      name: "City Medical Centre (Demo)",
      address: "Model Town, Ludhiana",
      lat: 30.9130, lng: 75.8480,
      phone: "+911615550102",
      email: "city.medical@demo.local",
      password_hash: demoHash,
      stock: { Cobra: [7, 1, -20], Krait: [0, 0, -1100], Viper: [3, 1, -20], KingCobra: [0, 0, -2000], PitViper: [2, 1, -40] },
    },
    {
      name: "Community Health Centre (Demo)",
      address: "Ferozepur Road, Ludhiana",
      lat: 30.8700, lng: 75.8200,
      phone: "+911615550103",
      email: "chc.ferozepur@demo.local",
      password_hash: demoHash,
      stock: { Cobra: [0, 0, -3000], Krait: [6, 1, -60], Viper: [0, 0, -3000], KingCobra: [1, 1, -120], PitViper: [0, 0, -3000] },
    },
    {
      name: "District Hospital (Demo)",
      address: "Sarabha Nagar, Ludhiana",
      lat: 30.8950, lng: 75.8100,
      phone: "+911615550104",
      email: "district.hospital@demo.local",
      password_hash: demoHash,
      stock: { Cobra: [4, 1, -90], Krait: [4, 1, -90], Viper: [9, 1, -90], KingCobra: [0, 0, -500], PitViper: [5, 1, -50] },
    },
  ];

  demoHospitals.forEach((h) => {
    const info = insertHospital.run(
      h.name, h.address, h.lat, h.lng, h.phone, h.email, h.password_hash
    );
    const hospitalId = info.lastInsertRowid;
    Object.entries(h.stock).forEach(([category, [quantity, available, minsAgo]]) => {
      insertInventory.run(
        hospitalId,
        antivenomIds[category],
        quantity,
        available,
        new Date(Date.now() + minsAgo * 60000).toISOString()
      );
    });
  });

  console.log("Seeded demo database with 4 approved demo hospitals (login password for all: demo1234)");

  // A couple of demo doctor contacts so the Contacts page has content immediately.
  const firstHospitalId = db.prepare("SELECT id FROM hospitals ORDER BY id LIMIT 1").get().id;
  const secondHospitalId = db.prepare("SELECT id FROM hospitals ORDER BY id LIMIT 1 OFFSET 1").get().id;
  const insertDoctor = db.prepare("INSERT INTO doctors (hospital_id, name, specialty, phone) VALUES (?, ?, ?, ?)");
  insertDoctor.run(firstHospitalId, "Dr. A. Sharma (Demo)", "Emergency Medicine", "+911615550111");
  insertDoctor.run(secondHospitalId, "Dr. R. Kaur (Demo)", "Toxicology", "+911615550112");
}

module.exports = db;
