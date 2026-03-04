# Job Tracker Pro

A smart job search app with user accounts, resume matching, and fit scoring for US and India markets.

## Architecture
- **Backend**: Node.js + Express (`index.js`)
  - Authentication via Replit Auth (Google, GitHub, Apple, email/password) — `auth.js`
  - PostgreSQL database for users, saved jobs, and profiles — `db.js`
  - `GET /api/jobs` — queries Adzuna API with filters and negative keyword exclusion
  - `POST /api/parse-resume` — parses PDF/DOCX resumes server-side
  - `GET/POST /api/saved-jobs`, `DELETE /api/saved-jobs/:id` — database-backed saved jobs
  - `GET/POST /api/profile` — persists user resume profile across sessions
  - `GET /api/me` — returns current authenticated user
  - `GET /api/login`, `GET /api/logout`, `GET /api/callback` — Replit OIDC auth routes
- **Frontend**: 
  - `public/login.html` — split-screen login page; detects iframe (Replit webview) and opens login in new tab to avoid OIDC redirect being blocked
  - `public/app.html` — main app (protected, requires login)
  - Client-side scoring, deduplication, requirements matching, and gap analysis
- **PWA**: manifest.json, service worker (sw.js), SVG icons — installable on Android/iOS

## Database Tables
- `users` — Replit Auth managed (id, email, first_name, last_name, profile_image_url)
- `sessions` — Replit Auth session storage
- `saved_jobs` — user's saved jobs (title, company, location, url, fit_score, etc.)
- `user_profiles` — persisted resume data (detected_role, detected_skills, seniority, years_exp)

## Features
- User authentication (Google, GitHub, Apple, email/password)
- Drag-and-drop resume upload (PDF/DOCX) with auto-profile extraction
- "What are you looking for?" freeform input
- Keyword search input
- Country (US/India), location dropdown, remote toggle, salary filters
- Fit scoring (X/10) with explainable "Why this score?" modal
- Requirements matching (years, degrees, must-have skills)
- "Bridge the gap" coaching with specific resume bullet examples for 40+ skills
- Word-boundary skill matching (prevents false positives)
- Role-specific pro tips (Program Manager, Engineer, Data, Product, Leadership)
- Saved jobs persist in database (accessible from any device)
- Resume profile persists across sessions
- PWA support (installable on phones)
- Deduplication by title + company + location
- Hard-fail filtering ("Probably not a fit" section)

## Setup
1. PostgreSQL database with tables: users, sessions, saved_jobs, user_profiles
2. Secrets: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `SESSION_SECRET`, `DATABASE_URL`
3. Run `node index.js`

## User Journey
1. Visit app → see login page
2. Sign in with Google/GitHub/Apple/email
3. Upload resume or describe what you're looking for
4. Search and browse matched jobs with fit scores
5. Save interesting jobs
6. Log out and log back in — saved jobs and profile persist

## Dependencies
- express, multer, pdf-parse, mammoth, node-fetch, dotenv
- pg (PostgreSQL client)
- passport, openid-client, express-session, connect-pg-simple, memoizee (auth)
