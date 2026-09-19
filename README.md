# AntiVenom Finder v4 — Setup Guide

## What's new in this version

- **Photo-guessing AI removed entirely.** It was never going to be reliable — see "Why the photo AI is gone" below. Identification is now **manual only**: pick from 8 illustrated snakes, or skip straight to finding a hospital.
- **8 snakes instead of 4** — India's most medically important venomous snakes: Indian Cobra, King Cobra, Common Krait, Banded Krait, Russell's Viper, Saw-scaled Viper, Bamboo Pit Viper, Hump-nosed Pit Viper.
- **Chatbot massively expanded** — ~60 curated Q&A entries (first aid, species facts, prevention, myths, app usage, emergency contacts) with a *scored* keyword matcher instead of exact-phrase matching, so it recognizes many more ways of asking the same question. See "About the chatbot" below for what this can and can't do.
- **3 new pages**: `about.html` (mission + the mortality statistic, verified against a real study), `precautions.html` (prevention tips), `contacts.html` (live hospital + doctor directory pulled from the database).
- **Doctor contacts** — hospitals can add doctor names/specialties/phone numbers from their dashboard; these show publicly on the Contacts page.
- **A real bug fix**: logging out of the hospital dashboard was calling `session.destroy()`, which wiped the *entire* login session — including an admin login open in another tab of the same browser (they shared one cookie). This is almost certainly what caused "hospitals not updating after approval" if you were testing hospital + admin panels side by side. Logout now only clears that specific login, not the whole session.
- **"+" branding** and a homepage statistic banner citing a real, cited mortality study.

## Why the photo AI is gone

You were right that it wasn't reliable — and it never could be. A trustworthy snake-species image classifier needs a model trained on a large, labeled photo dataset; anything less is a guess dressed up as analysis, which is actively dangerous for a medical-adjacent app. Rather than keep polishing something fundamentally unreliable, the fix is architectural: **manual selection by a human who saw the snake** is simply more trustworthy than any lightweight automated guess, so that's now the only identification path. All the "AI effort" went into the chatbot instead, where a large hand-curated dataset is a legitimate, honest approach (not a simulated capability).


## Security (passwords & secrets)

- **Hospital passwords** are stored only as **bcrypt hashes** (cost factor 12) in SQLite — never plain text.
- **Admin login** reads credentials from `.env`. The plain password is hashed with bcrypt at startup and compared with `bcrypt.compareSync`. Prefer setting `ADMIN_PASSWORD_HASH` only in production.
- **Session cookie** uses `httpOnly` + `sameSite=lax`. Set a strong `SESSION_SECRET` in production.
- **Login rate limiting**: max 10 attempts / 15 minutes per IP for admin and hospital login.
- **`.gitignore`** excludes `.env`, `node_modules/`, and `data/*.db`.

Setup:
```
cp .env.example .env
# edit .env with your admin username/password
npm install
npm start
```

Admin login: http://localhost:3000/admin-login.html  
Default local `.env` uses username `Codecrasher` (change before any public deploy).


## Step 1 — Unzip and open
Unzip `antivenom-finder.zip`, then in VS Code: File → Open Folder → select `antivenom-finder`.

## Step 2 — Install dependencies
Terminal → New Terminal, then:
```
npm install
```
Installs Express, bcryptjs, express-session. The database uses Node's built-in SQLite (`node:sqlite`) — nothing to compile. **Requires Node.js 22.5+** (`node -v` to check).

**Coming from an earlier version?** Delete `node_modules`, `package-lock.json`, and `data/antivenom.db`, then install fresh.

## Step 3 — Run it
```
npm start
```
```
AntiVenom Finder running at http://localhost:3000
Demo hospital login: govt.hospital@demo.local / demo1234
Admin panel: http://localhost:3000/admin-login.html (username: Codecrasher / password: Harman2008)
```

## Step 4 — Explore
- Public site: **http://localhost:3000**
- About / Precautions / Contacts: linked in the header and footer of every page
- Hospital login/register: **/hospital-login.html**
- Admin panel (you, the operator): **/admin-login.html** — change `ADMIN_PASSWORD` in `server.js` before showing this to anyone else

## About the chatbot — honest scope
It has ~60 curated topics (first aid steps, all 8 snakes, prevention, common myths, app usage, emergency numbers) and a scoring matcher that recognizes many phrasings of each — noticeably better coverage than the old exact-keyword version. But a hand-written dataset, however large, is not the same as a real language model that can handle truly open-ended conversation — no rule-based system can honestly claim to answer "100,000 types of questions." If a question falls outside its topics, it says so and points to Help or a hospital, rather than guessing. To make it a genuine open-domain assistant later, swap `getBotReply()` in `public/js/chatbot.js` for a call to an AI API — the rest of the chat UI doesn't need to change.

## About the snake images — real photos vs. illustrations
All 8 snakes use **original SVG illustrations**, not photographs, and that's a deliberate choice, not a shortcut: this project has no licensed photo source, and embedding photos scraped from the internet into a redistributable app is a real legal/ethical problem, not just a technical one. Each illustration is designed to highlight the snake's most identifying features (hood shape, banding, color).

**If you have rights to real reference photos** (e.g. your own photos, or ones with a compatible license like Wikimedia Commons CC-BY/CC0 images), it's a small change:
1. Save the images to `public/images/snakes/<key>.jpg` (keys are in `SNAKE_OPTIONS` in `public/js/icons.js` — e.g. `cobra.jpg`, `kingcobra.jpg`)
2. In `public/js/app.js`, in `renderSnakeGrid()`, swap the `${ICONS[opt.icon]}` line for an `<img src="images/snakes/${opt.key}.jpg">` tag when `opt.photo` is set.
The data structure already has a `photo` field per snake ready for this.

## The mortality statistic
"58,000+ deaths per year" is from Suraweera et al., *"Trends in snakebite deaths in India from 2000 to 2019,"* eLife, 2020 — a nationally representative mortality study analyzing over 600,000 verbal autopsies (the most rigorous estimate available; other studies range roughly 46,000–64,000/year depending on methodology and years covered). It appears on the homepage and About page with its source cited, since an unsourced statistic would undercut exactly the trustworthiness you asked for.

## How hospital approval works
1. Hospital registers → status **pending**, can log in immediately and prepare inventory + doctor contacts, but is **not** in public search yet.
2. You review it at `/admin-login.html` → `/admin.html`.
3. **Approve** → appears in public search and the Contacts directory, marked "✔ Verified". **Reject** → stays hidden. Reversible any time from the same panel.

If a hospital doesn't seem to update after you approve it: the public search only reflects new data on the *next* search — it doesn't live-poll. Click "Find Hospitals" again (or reload the Contacts page) after approving.

## Where your data lives
`data/antivenom.db` — SQLite, five tables: `hospitals` (with `status`: pending/approved/rejected), `antivenoms`, `inventory`, `bite_reports`, and `doctors`. Open it with **DB Browser for SQLite** to inspect directly.

## ⚠️ Before showing this to anyone else
Copy `.env.example` to `.env` and set `ADMIN_USERNAME`, `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`), and optionally `SESSION_SECRET`. Never commit `.env` to a public repository.

## Project structure
```
antivenom-finder/
  server.js                       -> backend: auth, admin approval, search, doctors, directory
  db.js                           -> database setup + demo data seeding
  data/antivenom.db               -> the actual database (created on first run)
  public/index.html               -> main flow: identify (manual) -> location -> hospitals
  public/about.html               -> mission + mortality statistic
  public/precautions.html         -> prevention tips
  public/contacts.html            -> live hospital + doctor directory
  public/help.html                -> first-aid & app-usage FAQ
  public/hospital-login.html      -> hospital login
  public/hospital-register.html   -> hospital registration (starts pending)
  public/hospital-dashboard.html  -> protected inventory + doctor contact management
  public/admin-login.html         -> site operator login
  public/admin.html               -> site operator approval panel
  public/js/app.js                -> main flow logic + map
  public/js/icons.js              -> SVG illustrations + 8-snake data
  public/js/chatbot.js            -> ~60-entry Q&A dataset + scored matcher
  public/js/auth.js               -> hospital login/register logic
  public/js/dashboard.js          -> hospital dashboard + doctor management
  public/js/admin.js              -> admin panel logic
  public/css/style.css            -> all styling
```

## To stop the server
Terminal → `Ctrl + C`.

If anything errors, copy the exact red text and send it to me.
