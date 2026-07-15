require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

/* DW SECURITY 1 - CORS ALLOWLIST.
   app.use(cors()) allowed ANY website on the internet to call this API from a victim's
   browser. Restrict to our own origins. Override with ALLOWED_ORIGINS (comma separated). */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://app.docwealth.in,https://docwealth.in,https://www.docwealth.in")
  .split(",").map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    /* no Origin header = curl / server-to-server / same-origin navigation: allow */
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn("[DocWealth] blocked CORS origin:", origin);
    return callback(new Error("Origin not allowed"));
  },
}));
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

/* =====================================================================
   DW FIX - PORTAL LINK STORE NOW LIVES IN ZOHO CREATOR
   ---------------------------------------------------------------------
   Previously the store was portal-links.json inside __dirname, i.e. on Render's
   EPHEMERAL disk. Every redeploy (and every free-tier spin-down/rebuild) wiped it,
   so the server forgot each client's portal token and status, and /api/portal-status
   fell back to inventing "Open" for everybody.

   The store is now the Zoho Creator form set in ZOHO_PORTAL_LINKS_FORM, read through
   ZOHO_PORTAL_LINKS_REPORT. The local JSON file is kept only as a short-lived cache /
   offline fallback, so losing it is now harmless.
   ===================================================================== */
const PORTAL_STORE_PATH = path.join(process.env.DATA_DIR || __dirname, "portal-links.json");
const PORTAL_LINKS_FORM = process.env.ZOHO_PORTAL_LINKS_FORM || "";
const PORTAL_LINKS_REPORT = process.env.ZOHO_PORTAL_LINKS_REPORT || "";
const LINKS_TTL_MS = 60 * 1000;

let LINKS_CACHE = { at: 0, byKey: new Map(), idByKey: new Map() };

function readPortalStore() {
  try {
    return JSON.parse(fs.readFileSync(PORTAL_STORE_PATH, "utf8"));
  } catch {
    return { links: {} };
  }
}

function writePortalStore(store) {
  try {
    const tmp = PORTAL_STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, PORTAL_STORE_PATH);
  } catch (error) {
    console.error("[DocWealth] local cache write failed (harmless):", error.message);
  }
}

/* ---- access token cache: avoid a token round-trip on every request ---- */
let TOKEN_CACHE = { token: "", at: 0 };
const TOKEN_TTL_MS = 50 * 60 * 1000;

/* ---- map a Zoho Portal_Links record -> our internal shape ---- */
function portalLinkFromZoho(record) {
  return {
    clientId: creatorDisplayValue(record.Client_ID).trim(),
    portalToken: creatorDisplayValue(record.Portal_Token).trim(),
    portalLink: creatorDisplayValue(record.Portal_Link).trim(),
    portalStatus: creatorDisplayValue(record.Portal_Status).trim() || "Not Sent",
    lastSentAt: creatorDisplayValue(record.Last_Sent_At).trim(),
    submittedAt: creatorDisplayValue(record.Submitted_At).trim(),
    correctionRequestedAt: creatorDisplayValue(record.Correction_Requested_At).trim(),
  };
}

async function loadPortalIndex(force) {
  if (!force && Date.now() - LINKS_CACHE.at < LINKS_TTL_MS && LINKS_CACHE.byKey.size) return LINKS_CACHE;
  if (!PORTAL_LINKS_REPORT) throw new Error("ZOHO_PORTAL_LINKS_REPORT is not set");

  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(PORTAL_LINKS_REPORT)}?max_records=200`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json();

  /* an empty report answers 3100 or 9220 depending on API version: not an error */
  if (data && data.code && data.code !== 3000 && !zohoIsEmptyReport(data)) {
    throw new Error(JSON.stringify(data));
  }

  const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];
  const byKey = new Map();
  const idByKey = new Map();
  const byClient = new Map();     /* clientId -> newest record */
  const idByClient = new Map();   /* clientId -> newest row ID  */
  rows.forEach((row) => {
    const rec = portalLinkFromZoho(row);
    if (!rec.clientId || !rec.portalToken) return;
    const key = portalKey(rec.clientId, rec.portalToken);
    byKey.set(key, rec);
    idByKey.set(key, row.ID);
    /* Rows come newest-last from the report; keep the last seen per client. */
    byClient.set(rec.clientId, rec);
    idByClient.set(rec.clientId, row.ID);
  });

  LINKS_CACHE = { at: Date.now(), byKey, idByKey, byClient, idByClient };
  return LINKS_CACHE;
}

async function zohoUpsertPortalLink(rec) {
  if (!PORTAL_LINKS_FORM || !PORTAL_LINKS_REPORT) throw new Error("Portal_Links form/report env vars not set");

  const key = portalKey(rec.clientId, rec.portalToken);
  let recordId = null;
  try {
    const index = await loadPortalIndex();
    /* One portal row PER CLIENT. Match on clientId first so a NEW token updates the
       existing row instead of creating a duplicate (this is what produced 177 rows).
       Fall back to the exact clientId+token key for older data. */
    recordId = index.idByClient.get(rec.clientId) || index.idByKey.get(key) || null;
  } catch (error) {
    console.error("[DocWealth] portal index unavailable, will insert:", error.message);
  }

  const accessToken = await getAccessToken();
  const fields = {
    Client_ID: rec.clientId || "",
    Portal_Token: rec.portalToken || "",
    Portal_Link: rec.portalLink || "",
    Portal_Status: rec.portalStatus || "Not Sent",
    Last_Sent_At: rec.lastSentAt || "",
    Submitted_At: rec.submittedAt || "",
    Correction_Requested_At: rec.correctionRequestedAt || "",
  };

  const response = recordId
    ? await fetch(`${creatorUrl(PORTAL_LINKS_REPORT)}/${recordId}`, {
        method: "PATCH",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: fields }),
      })
    : await fetch(creatorFormUrl(PORTAL_LINKS_FORM), {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [fields] }),
      });

  const data = await response.json();
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));

  LINKS_CACHE.at = 0; /* invalidate so the next read sees the write */
  return data;
}

function portalKey(clientId, token) {
  return `${clientId || ""}::${token || ""}`;
}

function publicPortalRecord(record) {
  if (!record) return null;
  return {
    clientId: record.clientId || "",
    portalLink: record.portalLink || "",
    portalStatus: record.portalStatus || "Not Sent",
    lastSentAt: record.lastSentAt || "",
    submittedAt: record.submittedAt || "",
    correctionRequestedAt: record.correctionRequestedAt || "",
  };
}

async function upsertPortalRecord(payload, patch = {}) {
  const key = portalKey(payload.clientId, payload.portalToken);
  const existing = (await findPortalRecord(payload.clientId, payload.portalToken)) || {};
  const next = {
    ...existing,
    clientId: payload.clientId || existing.clientId || "",
    portalToken: payload.portalToken || existing.portalToken || "",
    portalLink: payload.portalLink || existing.portalLink || "",
    clientName: payload.clientName || existing.clientName || "",
    phone: payload.phone || existing.phone || "",
    email: payload.email || existing.email || "",
    portalStatus: existing.portalStatus || payload.portalStatus || "Not Sent",
    updatedAt: new Date().toISOString(),
    ...patch,
  };

  /* local cache first (instant, survives a Zoho hiccup within one boot) */
  const store = readPortalStore();
  store.links[key] = next;
  writePortalStore(store);

  /* durable write - this is the one that matters */
  try {
    await zohoUpsertPortalLink(next);
  } catch (error) {
    console.error("[DocWealth] ZOHO PORTAL LINK WRITE FAILED for", next.clientId, error.message);
  }
  return next;
}

async function findPortalRecord(clientId, token) {
  if (!clientId || !token) return null;
  const key = portalKey(clientId, token);
  try {
    const index = await loadPortalIndex();
    if (index.byKey.has(key)) return index.byKey.get(key);
  } catch (error) {
    console.error("[DocWealth] portal index read failed, falling back to local cache:", error.message);
    const store = readPortalStore();
    return store.links[key] || null;
  }
  /* Zoho answered but has no such record. Local cache may hold a write made this boot. */
  const store = readPortalStore();
  return store.links[key] || null;
}

async function getAccessToken() {
  if (TOKEN_CACHE.token && Date.now() - TOKEN_CACHE.at < TOKEN_TTL_MS) return TOKEN_CACHE.token;
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const response = await fetch(`https://accounts.zoho.in/oauth/v2/token?${params}`, { method: "POST" });
  const data = await response.json();

  if (!data.access_token) throw new Error(JSON.stringify(data));
  TOKEN_CACHE = { token: data.access_token, at: Date.now() };
  return data.access_token;
}

function creatorUrl(reportName) {
  return `${process.env.ZOHO_API_DOMAIN}/creator/v2.1/data/${process.env.ZOHO_ACCOUNT_OWNER}/${process.env.ZOHO_APP_LINK_NAME}/report/${reportName}`;
}

function creatorFormUrl(formName) {
  return `${process.env.ZOHO_API_DOMAIN}/creator/v2.1/data/${process.env.ZOHO_ACCOUNT_OWNER}/${process.env.ZOHO_APP_LINK_NAME}/form/${formName}`;
}

function creatorDisplayValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(creatorDisplayValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return value.zc_display_value || value.display_value || value.first_name || value.value || value.ID || "";
  }
  return "";
}

function portalRecordClientId(record) {
  return creatorDisplayValue(record && record.Client_ID).trim();
}

function parsePortalJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    return null;
  }
}

function normalizePortalData(portalJson) {
  if (!portalJson || typeof portalJson !== "object") return null;
  if (portalJson.sections && typeof portalJson.sections === "object") return portalJson.sections;
  return portalJson;
}

function creatorRecordTime(record) {
  return Date.parse((record && (record.Modified_Time || record.Created_Time || record.Added_Time)) || "") || Number((record && record.ID) || 0) || 0;
}

/* =====================================================================
   DW PHASE 1 - ADVISOR AUTHENTICATION
   ---------------------------------------------------------------------
   Previously the advisor "login" lived in the public HTML:
       EMPLOYEES = { 'DW001': { pass: 'docwealth2024', ... } }
   Anyone could read it with view-source:, and the API required no login at all.

   Now: advisors live in the Zoho `Advisors` form with a scrypt password hash.
   /api/login issues an HMAC-signed session token; advisor-only routes require it.
   Names are read from Zoho on every login, so editing Zoho changes the app.

   Uses only Node's built-in crypto - no npm install.
   ===================================================================== */
const ADVISORS_FORM = process.env.ZOHO_ADVISORS_FORM || "";
const ADVISORS_REPORT = process.env.ZOHO_ADVISORS_REPORT || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; /* 365 days */

/* Zoho returns a non-3000 code when a report is EMPTY, and the code differs by
   API version: 3100 and 9220 both mean "no records exist in this report".
   Treat them as an empty list, never as an error. */
function zohoIsEmptyReport(data) {
  if (!data || !data.code) return false;
  /* Zoho signals "nothing to return" with several different codes:
       3100 - no records (older API)
       9220 - "No records exist in this report."     (empty report)
       9280 - "No records found matching criteria."  (criteria search matched nothing)
     None of these is an error. 9280 in particular is the normal answer when we look up
     a client that does not exist yet - i.e. every time we create one. */
  return data.code === 3100 || data.code === 9220 || data.code === 9280;
}

/* ---- password hashing (scrypt) ---- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const expected = Buffer.from(parts[2], "hex");
    const actual = crypto.scryptSync(String(password), parts[1], 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (error) {
    return false;
  }
}

/* ---- session tokens: base64url(payload).hmac ---- */
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(str) { return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }

function signToken(payload) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    if (!SESSION_SECRET || !token) return null;
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expect, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(unb64u(body));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

/* ---- Zoho Advisors store ---- */
let ADVISOR_CACHE = { at: 0, byId: new Map(), idByAdvisor: new Map() };
const ADVISOR_TTL_MS = 60 * 1000;

async function loadAdvisors(force) {
  if (!force && Date.now() - ADVISOR_CACHE.at < ADVISOR_TTL_MS && ADVISOR_CACHE.byId.size) return ADVISOR_CACHE;
  if (!ADVISORS_REPORT) throw new Error("ZOHO_ADVISORS_REPORT is not set");

  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(ADVISORS_REPORT)}?max_records=200`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json();
  if (data && data.code && data.code !== 3000 && !zohoIsEmptyReport(data)) throw new Error(JSON.stringify(data));

  const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];
  const byId = new Map();
  const idByAdvisor = new Map();
  rows.forEach((row) => {
    const advisorId = creatorDisplayValue(row.Advisor_ID).trim().toUpperCase();
    if (!advisorId) return;
    byId.set(advisorId, {
      advisorId,
      advisorName: creatorDisplayValue(row.Advisor_Name).trim(),
      passwordHash: creatorDisplayValue(row.Password_Hash).trim(),
      active: creatorDisplayValue(row.Active).trim(),
    });
    idByAdvisor.set(advisorId, row.ID);
  });
  ADVISOR_CACHE = { at: Date.now(), byId, idByAdvisor };
  return ADVISOR_CACHE;
}

async function upsertAdvisor(advisorId, fields) {
  if (!ADVISORS_FORM || !ADVISORS_REPORT) throw new Error("Advisors form/report env vars not set");
  const index = await loadAdvisors(true);
  const recordId = index.idByAdvisor.get(advisorId) || null;
  const accessToken = await getAccessToken();

  const response = recordId
    ? await fetch(`${creatorUrl(ADVISORS_REPORT)}/${recordId}`, {
        method: "PATCH",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: fields }),
      })
    : await fetch(creatorFormUrl(ADVISORS_FORM), {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [fields] }),
      });

  const data = await response.json();
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  ADVISOR_CACHE.at = 0;
  return data;
}

/* ---- middleware: advisor-only routes ---- */
function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: "login_required" });
  req.advisor = payload;
  next();
}

/* ---- one-time / repeat advisor setup, guarded by ADMIN_KEY ---- */
app.post("/api/advisor-setup", async (req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(500).json({ ok: false, error: "ADMIN_KEY not set" });
    const supplied = String(req.headers["x-admin-key"] || "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(ADMIN_KEY);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const advisorId = String((req.body && req.body.advisorId) || "").trim().toUpperCase();
    const advisorName = String((req.body && req.body.advisorName) || "").trim();
    const password = String((req.body && req.body.password) || "");
    if (!advisorId || !password) return res.status(400).json({ ok: false, error: "advisorId and password required" });
    if (password.length < 8) return res.status(400).json({ ok: false, error: "password must be at least 8 characters" });

    const fields = { Advisor_ID: advisorId, Password_Hash: hashPassword(password), Active: "Yes" };
    if (advisorName) fields.Advisor_Name = advisorName;
    await upsertAdvisor(advisorId, fields);
    res.json({ ok: true, advisorId, message: "Advisor saved. Password is stored hashed." });
  } catch (error) {
    console.error("[DocWealth] advisor-setup failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const advisorId = String((req.body && req.body.advisorId) || "").trim().toUpperCase();
    const password = String((req.body && req.body.password) || "");
    if (!advisorId || !password) return res.status(400).json({ ok: false, error: "missing_credentials" });

    const index = await loadAdvisors();
    const advisor = index.byId.get(advisorId);
    if (!advisor || !advisor.passwordHash) return res.status(401).json({ ok: false, error: "invalid_credentials" });
    if (advisor.active && advisor.active.toLowerCase() === "no") return res.status(403).json({ ok: false, error: "account_disabled" });
    if (!verifyPassword(password, advisor.passwordHash)) return res.status(401).json({ ok: false, error: "invalid_credentials" });

    const token = signToken({ sub: advisorId, name: advisor.advisorName || advisorId, exp: Date.now() + SESSION_TTL_MS });
    upsertAdvisor(advisorId, { Advisor_ID: advisorId, Last_Login: new Date().toISOString() }).catch(function () {});
    res.json({ ok: true, token, advisor: { id: advisorId, name: advisor.advisorName || advisorId } });
  } catch (error) {
    console.error("[DocWealth] login failed", error.message);
    res.status(500).json({ ok: false, error: "login_unavailable" });
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ ok: true, advisor: { id: req.advisor.sub, name: req.advisor.name } });
});

/* =====================================================================
   DW PHASE 2a - SHARED CLIENT RECORDS IN ZOHO
   ---------------------------------------------------------------------
   Client records are ~469 KB of JSON. Zoho multi-line fields cap at ~64 KB,
   so each record is stored as a FILE in a File-Upload field.

   Zoho quirk (confirmed in their docs): the Add/Update Records API cannot set a
   file-upload field. Every save is therefore two calls:
       1. upsert the row  (Client_ID, Client_Name, Updated_At, Updated_By, Version)
       2. POST the JSON   .../report/{report}/{recordId}/{field}/upload   (multipart)
   Reads mirror that:  find row -> GET .../{recordId}/{field}/download

   Concurrency: each row carries Version. A save must send the baseVersion it read.
   If they differ, another advisor saved in the meantime -> 409 with who/when,
   and the app warns instead of silently overwriting their work.
   ===================================================================== */
const CR_FORM = process.env.ZOHO_CLIENT_RECORDS_FORM || "";
const CR_REPORT = process.env.ZOHO_CLIENT_RECORDS_REPORT || "";
const CR_FILE_FIELD = process.env.ZOHO_CLIENT_RECORDS_FILE_FIELD || "Record_File";
/* How many historical rows to keep per client (newest first). 2 = current + one rollback. */
const CR_KEEP_VERSIONS = Math.max(1, Number(process.env.ZOHO_CLIENT_RECORDS_KEEP) || 2);
/* NOTE: skip_workflow is NOT a valid query parameter on these endpoints.
   Passing it returns {"code":1060,"description":"Invalid request parameter found - skip_workflow"}.
   It is only an optimisation, so it is omitted entirely. */

/* Zoho returns a file-upload field as an ARRAY of download URLs, e.g.
     ["/api/v2.1/<owner>/<app>/report/<report>/<id>/Record_File/download?filepath=1783616295998323_client_X.json"]
   The /download endpoint wants ONLY the filepath query value ("1783616295998323_client_X.json").
   Passing the whole URL returns {"code":3800,"message":"File path doesn't match for the provided record ID"}.
   An empty array means no file is attached. */
function crFilePathFromRow(row) {
  const raw = row && row[CR_FILE_FIELD];
  let entry = "";
  if (Array.isArray(raw)) entry = raw.length ? String(raw[raw.length - 1]) : "";
  else if (typeof raw === "string") entry = raw;
  if (!entry) return "";
  const match = entry.match(/[?&]filepath=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  /* already a bare filepath (no URL wrapper) */
  return entry.indexOf("/") === -1 ? entry : "";
}

function crRowToSummary(row) {
  return {
    clientId: creatorDisplayValue(row.Client_ID).trim(),
    clientName: creatorDisplayValue(row.Client_Name).trim(),
    updatedAt: creatorDisplayValue(row.Updated_At).trim(),
    updatedBy: creatorDisplayValue(row.Updated_By).trim(),
    version: Number(creatorDisplayValue(row.Version)) || 0,
    recordId: row.ID,
    /* /download REQUIRES ?filepath=<value>; without it Zoho answers
       {"code":3790,"message":"File path is mandatory..."} */
    filePath: crFilePathFromRow(row),
  };
}

async function crFetchRows(criteria) {
  if (!CR_REPORT) throw new Error("ZOHO_CLIENT_RECORDS_REPORT is not set");
  const accessToken = await getAccessToken();
  let url = `${creatorUrl(CR_REPORT)}?max_records=200`;
  if (criteria) url += `&criteria=${encodeURIComponent(criteria)}`;
  const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  const data = await response.json();
  if (data && data.code && data.code !== 3000 && !zohoIsEmptyReport(data)) throw new Error(JSON.stringify(data));
  const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];
  return rows;
}

/* Every save writes a NEW row and deletes the old one.
   Why: Zoho's upload API APPENDS to a file-upload field and enforces "Max file limit".
   Re-uploading into the same row fails with {"code":9750,"message":"File upload failed.
   The record already has maximum number of allowed uploads."} and Creator exposes no
   delete-file API. One file per row sidesteps this entirely, and keeping the previous
   row gives a free audit trail / rollback. */
async function crClientRows(clientId) {
  const rows = await crFetchRows(`Client_ID=="${String(clientId).replace(/"/g, "")}"`);
  return rows.map(crRowToSummary).sort((a, b) => b.version - a.version);
}

async function crFindRow(clientId) {
  const rows = await crClientRows(clientId);
  /* prefer the newest row that actually has a file attached */
  const withFile = rows.find((r) => r.filePath);
  return withFile || (rows.length ? rows[0] : null);
}

async function crDeleteRow(recordId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(CR_REPORT)}/${recordId}`, {
    method: "DELETE",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json().catch(function () { return null; });
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

/* Zoho's "add records" response shape varies by version, so we do NOT depend on it.
   Fast path: read the ID if it is there. Otherwise look the row up by the Version we
   just wrote (unique per client) - allowing a moment for the report index to catch up. */
function crExtractInsertedId(data) {
  const candidates = [];
  try {
    if (Array.isArray(data && data.data)) candidates.push(data.data[0]);
    if (Array.isArray(data && data.result)) candidates.push(data.result[0]);
    if (data && data.data && !Array.isArray(data.data)) candidates.push(data.data);
  } catch (error) { /* ignore */ }
  for (const c of candidates) {
    if (!c) continue;
    const id = (c.data && (c.data.ID || c.data.id)) || c.ID || c.id;
    if (id) return String(id);
  }
  return null;
}

async function crInsertRow(clientId, fields) {
  if (!CR_FORM) throw new Error("ZOHO_CLIENT_RECORDS_FORM is not set");
  const accessToken = await getAccessToken();
  const response = await fetch(creatorFormUrl(CR_FORM), {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [fields] }),
  });
  const data = await response.json();
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));

  const fast = crExtractInsertedId(data);
  if (fast) return fast;

  /* Fallback: find the row carrying the Version we just wrote. */
  const wanted = Number(fields.Version);
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await crClientRows(clientId);
    const hit = rows.find((r) => r.version === wanted);
    if (hit) return hit.recordId;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("insert succeeded but the new row could not be located");
}

/* Rows whose file upload never completed carry no filePath. They must never be treated
   as the newest good version, so remove them before writing. */
async function crPurgeFilelessRows(clientId) {
  const rows = await crClientRows(clientId);
  const orphans = rows.filter((r) => !r.filePath);
  for (const row of orphans) {
    await crDeleteRow(row.recordId).catch(function (error) {
      console.error("[DocWealth] could not delete fileless row", row.recordId, error.message);
    });
  }
  return orphans.length;
}

async function crUploadRecordFile(recordId, clientId, recordJson) {
  const accessToken = await getAccessToken();
  const form = new FormData();
  form.append("file", new Blob([recordJson], { type: "application/json" }), `client_${clientId}.json`);
  const response = await fetch(`${creatorUrl(CR_REPORT)}/${recordId}/${CR_FILE_FIELD}/upload`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });
  const data = await response.json().catch(function () { return null; });
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

async function crDownloadRecordFile(recordId, filePath) {
  if (!filePath) throw new Error("no record file attached to this client");
  const accessToken = await getAccessToken();
  const url = `${creatorUrl(CR_REPORT)}/${recordId}/${CR_FILE_FIELD}/download?filepath=${encodeURIComponent(filePath)}`;
  const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!response.ok) throw new Error("file download failed: HTTP " + response.status);

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("stored record is not valid JSON");
  }

  /* A Zoho error is itself valid JSON, e.g. {"code":3790,"message":"File path is mandatory..."}.
     Never hand that back to the app as though it were the client's record. */
  if (parsed && typeof parsed === "object" && parsed.code && (parsed.message || parsed.description) && !Object.prototype.hasOwnProperty.call(parsed, "fields")) {
    throw new Error("zoho download error: " + JSON.stringify(parsed));
  }
  return parsed;
}

/* =====================================================================
   CLIENT DOCUMENTS - REAL UPLOAD FROM THE DOCTOR PORTAL
   ---------------------------------------------------------------------
   Until now the portal's "Secure Document Vault" only recorded file.name and
   file.size and showed a "Document Uploaded" toast. It never read the file's
   contents (no FileReader, no FormData) and /api/portal-submit sent only JSON.
   Every client's documents stayed on their own laptop.

   Now the portal base64-encodes each file and POSTs it here. One Zoho row per file.
   Authenticated with the same clientId+portalToken guard as /api/portal-submit.

   5 MB cap: base64 inflates by ~33%, so 5 MB of file is ~6.7 MB of JSON - safely
   inside the 25 MB body limit and kind to a 512 MB free-tier Render instance.
   ===================================================================== */
const DOCS_FORM = process.env.ZOHO_CLIENT_DOCS_FORM || "";
const DOCS_REPORT = process.env.ZOHO_CLIENT_DOCS_REPORT || "";
const DOCS_FILE_FIELD = process.env.ZOHO_CLIENT_DOCS_FILE_FIELD || "Doc_File";
/* Zoho reserves "Section", so the field it actually created is "Section1".
   Writing to "Section" was silently ignored and the column stayed blank. */
const DOCS_SECTION_FIELD = process.env.ZOHO_CLIENT_DOCS_SECTION_FIELD || "Section1";
const DOC_MAX_BYTES = 5 * 1024 * 1024;
const DOC_ALLOWED_EXT = ["pdf","jpg","jpeg","png","webp","doc","docx","xls","xlsx","csv"];

/* Zoho sometimes answers with an empty body or an HTML error page. Calling .json() on that
   throws "Unexpected end of JSON input" and hides what actually went wrong. Always read the
   text first and report the HTTP status plus a snippet. */
async function zohoJson(response, what) {
  const text = await response.text();
  if (!text || !text.trim()) {
    throw new Error(`${what}: Zoho returned an empty body (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what}: Zoho returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

function docFilePathFromRow(row) {
  const raw = row && row[DOCS_FILE_FIELD];
  let entry = "";
  if (Array.isArray(raw)) entry = raw.length ? String(raw[raw.length - 1]) : "";
  else if (typeof raw === "string") entry = raw;
  if (!entry) return "";
  const match = entry.match(/[?&]filepath=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return entry.indexOf("/") === -1 ? entry : "";
}

function docRowToSummary(row) {
  return {
    recordId: row.ID,
    clientId: creatorDisplayValue(row.Client_ID).trim(),
    section: creatorDisplayValue(row[DOCS_SECTION_FIELD]).trim(),
    documentType: creatorDisplayValue(row.Document_Type).trim(),
    fileName: creatorDisplayValue(row.File_Name).trim(),
    uploadedAt: creatorDisplayValue(row.Uploaded_At).trim(),
    hasFile: !!docFilePathFromRow(row),
    filePath: docFilePathFromRow(row),
  };
}

async function docFetchRows(criteria) {
  if (!DOCS_REPORT) throw new Error("ZOHO_CLIENT_DOCS_REPORT is not set");
  const accessToken = await getAccessToken();
  let url = `${creatorUrl(DOCS_REPORT)}?max_records=200`;
  if (criteria) url += `&criteria=${encodeURIComponent(criteria)}`;
  const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  const data = await zohoJson(response, "docs list");
  if (data && data.code && data.code !== 3000 && !zohoIsEmptyReport(data)) throw new Error(JSON.stringify(data));
  return (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];
}

async function docInsertRow(fields) {
  if (!DOCS_FORM) throw new Error("ZOHO_CLIENT_DOCS_FORM is not set");
  const accessToken = await getAccessToken();
  const response = await fetch(creatorFormUrl(DOCS_FORM), {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [fields] }),
  });
  const data = await zohoJson(response, "docs insert");
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  const id = crExtractInsertedId(data);
  if (id) return id;
  /* fall back to locating the row we just wrote */
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await docFetchRows(`Client_ID=="${String(fields.Client_ID).replace(/"/g, "")}"`);
    const hit = rows.map(docRowToSummary).find((r) => r.fileName === fields.File_Name && r.uploadedAt === fields.Uploaded_At);
    if (hit) return hit.recordId;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("document row created but could not be located");
}

async function docUploadFile(recordId, fileName, buffer, mimeType) {
  const accessToken = await getAccessToken();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), fileName);
  const response = await fetch(`${creatorUrl(DOCS_REPORT)}/${recordId}/${DOCS_FILE_FIELD}/upload`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });
  const data = await zohoJson(response, "docs file upload");
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

async function docDeleteRow(recordId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(DOCS_REPORT)}/${recordId}`, {
    method: "DELETE",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json().catch(function () { return null; });
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

/* =====================================================================
   CLIENT REPORTS - advisor-generated PDFs stored in Zoho
   ---------------------------------------------------------------------
   When an advisor generates a report PDF in DocWealth.html, a copy of the finished
   blob is uploaded here so every advisor can see that client's reports from any
   machine. Same one-row-per-file pattern as Client Docs. Advisor-authenticated.
   ===================================================================== */
const REPORTS_FORM = process.env.ZOHO_CLIENT_REPORTS_FORM || "";
const REPORTS_REPORT = process.env.ZOHO_CLIENT_REPORTS_REPORT || "";
const REPORTS_FILE_FIELD = process.env.ZOHO_CLIENT_REPORTS_FILE_FIELD || "Report_File";
const REPORT_MAX_BYTES = 13 * 1024 * 1024;   /* 10 MB file -> ~13.3 MB base64; body limit is 25 MB */

function repFilePathFromRow(row) {
  const raw = row && row[REPORTS_FILE_FIELD];
  let entry = "";
  if (Array.isArray(raw)) entry = raw.length ? String(raw[raw.length - 1]) : "";
  else if (typeof raw === "string") entry = raw;
  if (!entry) return "";
  const match = entry.match(/[?&]filepath=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return entry.indexOf("/") === -1 ? entry : "";
}

function repRowToSummary(row) {
  return {
    recordId: row.ID,
    clientId: creatorDisplayValue(row.Client_ID).trim(),
    reportName: creatorDisplayValue(row.Report_Name).trim(),
    reportType: creatorDisplayValue(row.Report_Type).trim(),
    generatedBy: creatorDisplayValue(row.Generated_By).trim(),
    generatedAt: creatorDisplayValue(row.Generated_At).trim(),
    filePath: repFilePathFromRow(row),
  };
}

async function repFetchRows(criteria) {
  if (!REPORTS_REPORT) throw new Error("ZOHO_CLIENT_REPORTS_REPORT is not set");
  const accessToken = await getAccessToken();
  let url = `${creatorUrl(REPORTS_REPORT)}?max_records=200`;
  if (criteria) url += `&criteria=${encodeURIComponent(criteria)}`;
  const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  const data = await zohoJson(response, "reports list");
  if (data && data.code && data.code !== 3000 && !zohoIsEmptyReport(data)) throw new Error(JSON.stringify(data));
  return (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];
}

async function repInsertRow(fields) {
  if (!REPORTS_FORM) throw new Error("ZOHO_CLIENT_REPORTS_FORM is not set");
  const accessToken = await getAccessToken();
  const response = await fetch(creatorFormUrl(REPORTS_FORM), {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [fields] }),
  });
  const data = await zohoJson(response, "reports insert");
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  const id = crExtractInsertedId(data);
  if (id) return id;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await repFetchRows(`Client_ID=="${String(fields.Client_ID).replace(/"/g, "")}"`);
    const hit = rows.map(repRowToSummary).find((r) => r.reportName === fields.Report_Name && r.generatedAt === fields.Generated_At);
    if (hit) return hit.recordId;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("report row created but could not be located");
}

async function repUploadFile(recordId, fileName, buffer) {
  const accessToken = await getAccessToken();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);
  const response = await fetch(`${creatorUrl(REPORTS_REPORT)}/${recordId}/${REPORTS_FILE_FIELD}/upload`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });
  const data = await zohoJson(response, "report file upload");
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

async function repDeleteRow(recordId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(REPORTS_REPORT)}/${recordId}`, {
    method: "DELETE",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json().catch(function () { return null; });
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

/* ---- advisor uploads a generated report PDF ---- */
app.post("/api/client-report", requireAuth, async (req, res) => {
  try {
    if (!REPORTS_FORM) return res.status(500).json({ ok: false, error: "ZOHO_CLIENT_REPORTS_FORM is not set in Render" });
    if (!REPORTS_REPORT) return res.status(500).json({ ok: false, error: "ZOHO_CLIENT_REPORTS_REPORT is not set in Render" });
    const payload = req.body || {};
    const clientId = String(payload.clientId || "").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "missing_client_id" });

    const base64 = String(payload.dataBase64 || "");
    if (!base64) return res.status(400).json({ ok: false, error: "missing_file" });
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) return res.status(400).json({ ok: false, error: "empty_file" });
    if (buffer.length > REPORT_MAX_BYTES) return res.status(413).json({ ok: false, error: "file_too_large", maxBytes: REPORT_MAX_BYTES });

    let fileName = String(payload.fileName || "report.pdf").trim().slice(0, 200);
    if (!/\.pdf$/i.test(fileName)) fileName += ".pdf";
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 100) || "report.pdf";

    const advisorId = (req.advisor && req.advisor.sub) || "";
    const advisorName = (req.advisor && req.advisor.name) || advisorId;
    const generatedAt = new Date().toISOString();

    const recordId = await repInsertRow({
      Client_ID: clientId,
      Report_Name: fileName,
      Report_Type: String(payload.reportType || "").slice(0, 200),
      Generated_By: `${advisorName} (${advisorId})`,
      Generated_At: generatedAt,
    });

    try {
      await repUploadFile(recordId, safeName, buffer);
    } catch (error) {
      await repDeleteRow(recordId).catch(function () {});
      throw error;
    }

    res.json({ ok: true, recordId, fileName, generatedAt, size: buffer.length });
  } catch (error) {
    console.error("[DocWealth] client-report upload failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: list a client's reports ---- */
app.get("/api/client-reports/:clientId", requireAuth, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    const rows = await repFetchRows(`Client_ID=="${clientId.replace(/"/g, "")}"`);
    const reports = rows.map(repRowToSummary)
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
      .map(function (r) { delete r.filePath; return r; });
    res.json({ ok: true, clientId, reports });
  } catch (error) {
    console.error("[DocWealth] client-reports list failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: download one report ---- */
app.get("/api/client-report/:recordId/download", requireAuth, async (req, res) => {
  try {
    const recordId = String(req.params.recordId || "").trim();
    const rows = await repFetchRows(null);
    const row = rows.find((r) => String(r.ID) === recordId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    const filePath = repFilePathFromRow(row);
    if (!filePath) return res.status(404).json({ ok: false, error: "no_file" });

    const accessToken = await getAccessToken();
    const url = `${creatorUrl(REPORTS_REPORT)}/${recordId}/${REPORTS_FILE_FIELD}/download?filepath=${encodeURIComponent(filePath)}`;
    const upstream = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!upstream.ok) return res.status(502).json({ ok: false, error: "zoho_download_failed" });

    const fileName = creatorDisplayValue(row.Report_Name).trim() || "report.pdf";
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch (error) {
    console.error("[DocWealth] client-report download failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: delete one report ---- */
app.delete("/api/client-report/:recordId", requireAuth, async (req, res) => {
  try {
    await repDeleteRow(String(req.params.recordId || "").trim());
    res.json({ ok: true });
  } catch (error) {
    console.error("[DocWealth] client-report delete failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- the doctor portal uploads a file (no advisor login; client token guards it) ---- *//* ---- the doctor portal uploads a file (no advisor login; client token guards it) ---- */
app.post("/api/portal-upload", async (req, res) => {
  try {
    if (!DOCS_FORM) return res.status(500).json({ ok: false, error: "ZOHO_CLIENT_DOCS_FORM is not set in Render" });
    if (!DOCS_REPORT) return res.status(500).json({ ok: false, error: "ZOHO_CLIENT_DOCS_REPORT is not set in Render" });
    const payload = req.body || {};
    const clientId = String(payload.clientId || "");
    const portalToken = String(payload.portalToken || "");

    const existing = await findPortalRecord(clientId, portalToken);
    if (!existing) {
      console.warn("[DocWealth] rejected portal-upload for unregistered client:", clientId);
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const fileName = String(payload.fileName || "").trim().slice(0, 200);
    const base64 = String(payload.dataBase64 || "");
    if (!fileName || !base64) return res.status(400).json({ ok: false, error: "missing_file" });

    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (DOC_ALLOWED_EXT.indexOf(ext) === -1) return res.status(400).json({ ok: false, error: "file_type_not_allowed" });

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) return res.status(400).json({ ok: false, error: "empty_file" });
    if (buffer.length > DOC_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: "file_too_large", maxBytes: DOC_MAX_BYTES });
    }

    /* Zoho can be fussy about spaces and brackets in a file name. Keep the original in the
       File_Name field for the advisor to read; upload the bytes under a safe name. */
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 100) || ("document." + ext);

    const uploadedAt = new Date().toISOString();
    const docFields = {
      Client_ID: clientId,
      Document_Type: String(payload.documentType || "").slice(0, 200),
      File_Name: fileName,
      Uploaded_At: uploadedAt,
    };
    docFields[DOCS_SECTION_FIELD] = String(payload.section || "").slice(0, 200);
    const recordId = await docInsertRow(docFields);

    try {
      await docUploadFile(recordId, safeName, buffer, payload.mimeType);
    } catch (error) {
      await docDeleteRow(recordId).catch(function () {});   /* never leave a fileless row */
      throw error;
    }

    res.json({ ok: true, recordId, fileName, uploadedAt, size: buffer.length });
  } catch (error) {
    console.error("[DocWealth] portal-upload failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: list a client's documents ---- */
app.get("/api/client-docs/:clientId", requireAuth, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    const rows = await docFetchRows(`Client_ID=="${clientId.replace(/"/g, "")}"`);
    const documents = rows.map(docRowToSummary)
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
      .map(function (d) { delete d.filePath; return d; });
    res.json({ ok: true, clientId, documents });
  } catch (error) {
    console.error("[DocWealth] client-docs list failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: download one document ---- */
app.get("/api/client-doc/:recordId/download", requireAuth, async (req, res) => {
  try {
    const recordId = String(req.params.recordId || "").trim();
    const rows = await docFetchRows(null);
    const row = rows.find((r) => String(r.ID) === recordId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    const filePath = docFilePathFromRow(row);
    if (!filePath) return res.status(404).json({ ok: false, error: "no_file" });

    const accessToken = await getAccessToken();
    const url = `${creatorUrl(DOCS_REPORT)}/${recordId}/${DOCS_FILE_FIELD}/download?filepath=${encodeURIComponent(filePath)}`;
    const upstream = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!upstream.ok) return res.status(502).json({ ok: false, error: "zoho_download_failed" });

    const fileName = creatorDisplayValue(row.File_Name).trim() || "document";
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch (error) {
    console.error("[DocWealth] client-doc download failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- advisor: delete one document ---- */
app.delete("/api/client-doc/:recordId", requireAuth, async (req, res) => {
  try {
    await docDeleteRow(String(req.params.recordId || "").trim());
    res.json({ ok: true });
  } catch (error) {
    console.error("[DocWealth] client-doc delete failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- list every client (shared workspace: all advisors see all clients) ---- */
app.get("/api/clients", requireAuth, async (req, res) => {
  try {
    const rows = await crFetchRows(null);
    /* several rows may exist per client (version history) - surface only the newest */
    const newest = new Map();
    rows.map(crRowToSummary).filter((c) => c.clientId).forEach((c) => {
      const seen = newest.get(c.clientId);
      if (!seen || c.version > seen.version) newest.set(c.clientId, c);
    });
    const clients = Array.from(newest.values());
    clients.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ ok: true, clients });
  } catch (error) {
    console.error("[DocWealth] /api/clients failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- fetch one full client record ---- */
app.get("/api/client/:clientId", requireAuth, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "missing_client_id" });
    const row = await crFindRow(clientId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    if (!row.filePath) return res.status(404).json({ ok: false, error: "no_record_file" });
    const record = await crDownloadRecordFile(row.recordId, row.filePath);
    res.json({ ok: true, clientId, version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy, record });
  } catch (error) {
    console.error("[DocWealth] GET /api/client failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- save a client record (optimistic locking on Version) ---- */
app.post("/api/client/:clientId", requireAuth, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "missing_client_id" });

    const body = req.body || {};
    const record = body.record;
    if (!record || typeof record !== "object") return res.status(400).json({ ok: false, error: "missing_record" });

    const baseVersion = Number(body.baseVersion);
    await crPurgeFilelessRows(clientId);          /* clear any half-written row first */
    const rows = await crClientRows(clientId);
    const existing = rows.length ? rows[0] : null;

    /* stale-edit guard: someone else saved since this advisor loaded the record */
    if (existing && Number.isFinite(baseVersion) && existing.version !== baseVersion) {
      return res.status(409).json({
        ok: false,
        error: "conflict",
        currentVersion: existing.version,
        updatedBy: existing.updatedBy,
        updatedAt: existing.updatedAt,
      });
    }

    const nextVersion = (existing ? existing.version : 0) + 1;
    const advisorId = (req.advisor && req.advisor.sub) || "";
    const advisorName = (req.advisor && req.advisor.name) || advisorId;
    const clientName = String(body.clientName || record.clientName || "").trim();
    const updatedBy = `${advisorName} (${advisorId})`;

    /* 1. write a brand-new row (one file per row - see crClientRows) */
    const recordId = await crInsertRow(clientId, {
      Client_ID: clientId,
      Client_Name: clientName,
      Updated_At: new Date().toISOString(),
      Updated_By: updatedBy,
      Version: nextVersion,
    });

    /* 2. attach the record file. If this fails, remove the empty row so the client's
          previous good version stays the newest - never leave a fileless row on top. */
    try {
      await crUploadRecordFile(recordId, clientId, JSON.stringify(record));
    } catch (error) {
      await crDeleteRow(recordId).catch(function () {});
      throw error;
    }

    /* 3. only now prune older rows, keeping CR_KEEP_VERSIONS newest */
    const stale = rows.slice(CR_KEEP_VERSIONS - 1);
    for (const row of stale) {
      await crDeleteRow(row.recordId).catch(function (error) {
        console.error("[DocWealth] could not delete old row", row.recordId, error.message);
      });
    }

    res.json({ ok: true, clientId, version: nextVersion, updatedBy });
  } catch (error) {
    console.error("[DocWealth] POST /api/client failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* Zoho Documents report is the truth for "did this client submit?".
   Used to self-heal a portal link whose status was never marked Submitted. */
const ZOHO_SUBMIT_CACHE = new Map();
const ZOHO_SUBMIT_TTL_MS = 60 * 1000;

/* Build an ISO timestamp SAFELY.
   creatorRecordTime() falls back to the numeric Zoho record ID (e.g. 301419000000031007)
   when the record carries no Modified_Time. That number is far outside the valid JS Date
   range (+/-8.64e15 ms), so new Date(id).toISOString() throws RangeError: Invalid time value.
   It is fine for SORTING (as the original code uses it) but must never be turned into a Date. */
function submissionTimestamp(record) {
  const raw = record && (record.Modified_Time || record.Created_Time || record.Added_Time);
  const parsed = Date.parse(raw || "");
  if (Number.isFinite(parsed)) {
    try {
      return new Date(parsed).toISOString();
    } catch (error) {
      /* fall through */
    }
  }
  return new Date().toISOString();
}

async function zohoLatestSubmission(clientId) {
  if (!clientId) return null;
  const hit = ZOHO_SUBMIT_CACHE.get(clientId);
  if (hit && Date.now() - hit.at < ZOHO_SUBMIT_TTL_MS) return hit.value;

  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(process.env.ZOHO_DOCUMENTS_REPORT)}?max_records=200`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const zohoResponse = await response.json();
  if (zohoResponse && zohoResponse.code && zohoResponse.code !== 3000) return null;

  const records = Array.isArray(zohoResponse.data) ? zohoResponse.data : [];
  const matches = records
    .filter((record) => portalRecordClientId(record) === clientId && normalizePortalData(parsePortalJson(record.Portal_JSON)))
    .sort((a, b) => creatorRecordTime(b) - creatorRecordTime(a));

  const latest = matches[0] || null;
  const value = latest ? submissionTimestamp(latest) : null;
  ZOHO_SUBMIT_CACHE.set(clientId, { at: Date.now(), value });
  return value;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "DocWealth backend is running" });
});

app.get("/api/zoho-test", requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`${creatorUrl(process.env.ZOHO_CLIENTS_REPORT)}?max_records=200`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const data = await response.json();
    res.json({ ok: true, zohoResponse: data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* DW FIX: this route already authorizes safely via the clientId+token pair
   (findPortalRecord below), same as /api/portal-status and /api/portal-submit.
   requireAuth here was blocking the CLIENT-facing correction form (which has
   no advisor login) from ever fetching the client's own previously-submitted
   answers — every request came back 401 before it even checked the token. */
app.get("/api/portal-data", async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    const token = String(req.query.token || "").trim();
    if (!clientId || !token) {
  return res.status(400).json({ ok: false, error: "missing_params" });
}
    const portalRecord = await findPortalRecord(clientId, token);
    if (!portalRecord) {
  return res.status(404).json({ ok: false, error: "portal_not_found" });
}
    const accessToken = await getAccessToken();
    const response = await fetch(`${creatorUrl(process.env.ZOHO_DOCUMENTS_REPORT)}?max_records=200`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const zohoResponse = await response.json();
    if (zohoResponse && zohoResponse.code && zohoResponse.code !== 3000) {
      return res.status(400).json({ ok: false, zohoResponse });
    }

    const records = Array.isArray(zohoResponse.data) ? zohoResponse.data : [];
    const matches = records
      .map((record) => ({
        record,
        portalData: normalizePortalData(parsePortalJson(record.Portal_JSON)),
      }))
      .filter((entry) => portalRecordClientId(entry.record) === clientId && entry.portalData)
      .sort((a, b) => creatorRecordTime(b.record) - creatorRecordTime(a.record));

    const latest = matches[0] || null;
    if (!latest) return res.json({ ok: true, portalData: null });

    res.json({
      ok: true,
      portalData: latest.portalData,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- one-time cleanup: keep ONLY the given client IDs, delete all other rows ----
   Used to remove dead test-client rows (bomu, TEST-999, etc.) from Portal_Links and
   the portal-submission form. The keep-list is passed in the request body and must be
   non-empty, so an accidental empty list can never wipe everything. */
async function purgeRowsNotInList(reportLink, clientIdFieldReader, keepIds) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(reportLink)}?max_records=500`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json();
  const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];

  const keep = new Set(keepIds);
  const toDelete = rows.filter((row) => !keep.has(clientIdFieldReader(row))).map((row) => row.ID);

  let deleted = 0, failed = 0;
  for (const id of toDelete) {
    try {
      const r = await fetch(`${creatorUrl(reportLink)}/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const d = await r.json().catch(() => null);
      if (d && d.code && d.code !== 3000) { failed++; } else { deleted++; }
    } catch (e) { failed++; }
  }
  return { totalRows: rows.length, kept: rows.length - toDelete.length, deleted, failed };
}

app.post("/api/keep-only-clients", requireAuth, async (req, res) => {
  try {
    const keepIds = Array.isArray(req.body && req.body.keepClientIds)
      ? req.body.keepClientIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!keepIds.length) {
      return res.status(400).json({ ok: false, error: "keepClientIds must be a non-empty list" });
    }

    const results = {};
    /* Portal_Links */
    results.portalLinks = await purgeRowsNotInList(
      PORTAL_LINKS_REPORT,
      (row) => portalLinkFromZoho(row).clientId,
      keepIds
    );
    /* portal-submission form */
    if (process.env.ZOHO_DOCUMENTS_REPORT) {
      results.submissions = await purgeRowsNotInList(
        process.env.ZOHO_DOCUMENTS_REPORT,
        (row) => portalRecordClientId(row),
        keepIds
      );
    }

    LINKS_CACHE = { at: 0, byKey: new Map(), idByKey: new Map(), byClient: new Map(), idByClient: new Map() };
    if (ZOHO_SUBMIT_CACHE.clear) ZOHO_SUBMIT_CACHE.clear();
    res.json({ ok: true, keptClientIds: keepIds, results });
  } catch (error) {
    console.error("[DocWealth] keep-only-clients failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- one-time cleanup: remove duplicate portal-submission rows, keep newest per client ---- */
app.post("/api/portal-submissions-dedupe", requireAuth, async (req, res) => {
  try {
    const REP = process.env.ZOHO_DOCUMENTS_REPORT;
    if (!REP) return res.status(500).json({ ok: false, error: "ZOHO_DOCUMENTS_REPORT is not set" });
    const accessToken = await getAccessToken();
    const response = await fetch(`${creatorUrl(REP)}?max_records=500`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const data = await response.json();
    const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];

    /* group by client, newest-last (report returns oldest-first) */
    const byClient = {};
    rows.forEach((row) => {
      const cid = portalRecordClientId(row) || "(blank)";
      (byClient[cid] = byClient[cid] || []).push(row.ID);
    });

    const toDelete = [];
    Object.keys(byClient).forEach((cid) => {
      byClient[cid].slice(0, -1).forEach((id) => toDelete.push(id));   /* keep newest */
    });

    let deleted = 0, failed = 0;
    for (const id of toDelete) {
      try {
        const r = await fetch(`${creatorUrl(REP)}/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        const d = await r.json().catch(() => null);
        if (d && d.code && d.code !== 3000) { failed++; } else { deleted++; }
      } catch (e) { failed++; }
    }
    ZOHO_SUBMIT_CACHE.clear && ZOHO_SUBMIT_CACHE.clear();
    res.json({ ok: true, totalRows: rows.length, kept: Object.keys(byClient).length, deleted, failed });
  } catch (error) {
    console.error("[DocWealth] portal-submissions dedupe failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ---- one-time cleanup: remove duplicate Portal_Links rows, keep newest per client ---- */
app.post("/api/portal-links-dedupe", requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`${creatorUrl(PORTAL_LINKS_REPORT)}?max_records=500`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const data = await response.json();
    const rows = (!zohoIsEmptyReport(data) && Array.isArray(data.data)) ? data.data : [];

    /* group row IDs by client; the report returns oldest-first, so the LAST is newest */
    const byClient = {};
    rows.forEach((row) => {
      const rec = portalLinkFromZoho(row);
      const cid = rec.clientId || "(blank)";
      (byClient[cid] = byClient[cid] || []).push(row.ID);
    });

    const toDelete = [];
    Object.keys(byClient).forEach((cid) => {
      const ids = byClient[cid];
      ids.slice(0, -1).forEach((id) => toDelete.push(id));   /* keep the last (newest) */
    });

    let deleted = 0, failed = 0;
    for (const id of toDelete) {
      try {
        const r = await fetch(`${creatorUrl(PORTAL_LINKS_REPORT)}/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        const d = await r.json().catch(() => null);
        if (d && d.code && d.code !== 3000) { failed++; } else { deleted++; }
      } catch (e) { failed++; }
    }

    LINKS_CACHE = { at: 0, byKey: new Map(), idByKey: new Map(), byClient: new Map(), idByClient: new Map() };
    res.json({ ok: true, totalRows: rows.length, kept: Object.keys(byClient).length, deleted, failed });
  } catch (error) {
    console.error("[DocWealth] portal-links dedupe failed", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/client-link", requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
    const record = await upsertPortalRecord(payload);
    res.json({ ok: true, portal: publicPortalRecord(record) });
  } catch (error) {
    console.error("[DocWealth] client-link failed", error.message);
    res.status(500).json({ ok: false, error: "Could not save the portal link. Please try again." });
  }
});

app.post("/api/portal-sent", requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
    const existing = await findPortalRecord(payload.clientId, payload.portalToken);
    const nextStatus = existing && existing.portalStatus === "Needs Correction" ? "Needs Correction" : "Sent";
    const record = await upsertPortalRecord(payload, { portalStatus: nextStatus, lastSentAt: new Date().toISOString() });
    res.json({ ok: true, portal: publicPortalRecord(record) });
  } catch (error) {
    console.error("[DocWealth] portal-sent failed", error.message);
    res.status(500).json({ ok: false, error: "Could not update the portal status. Please try again." });
  }
});

app.post("/api/request-correction", requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
    const record = await upsertPortalRecord(payload, { portalStatus: "Needs Correction", correctionRequestedAt: new Date().toISOString() });
    res.json({ ok: true, portal: publicPortalRecord(record) });
  } catch (error) {
    console.error("[DocWealth] request-correction failed", error.message);
    res.status(500).json({ ok: false, error: "Could not request a correction. Please try again." });
  }
});

/* THE BUG: the old fallback answered {ok:true,status:"Open"} for EVERY unknown client -
   including fabricated ones - and the advisor app wrote that over each client's real status.
   Now: unknown => 404 (the frontend keeps whatever it knows). Known but not yet marked
   submitted => ask the Zoho Documents report, and self-heal. */
app.get("/api/portal-status", async (req, res) => {
 try {
  const clientId = String(req.query.clientId || "").trim();
  const token = String(req.query.token || "").trim();
  if (!clientId || !token) return res.status(400).json({ ok: false, error: "missing_params" });

  const record = await findPortalRecord(clientId, token);
  if (!record) {
  return res.status(404).json({ ok: false, error: "portal_not_found" });
}
  const status = record.portalStatus || "Not Sent";

  if (status !== "Submitted" && status !== "Locked" && status !== "Needs Correction") {
    try {
      const submittedAt = await zohoLatestSubmission(clientId);
      if (submittedAt) {
        const healed = await upsertPortalRecord(
          { clientId, portalToken: token, portalLink: record.portalLink },
          { portalStatus: "Submitted", submittedAt }
        );
        return res.json({ ok: true, status: "Submitted", portal: publicPortalRecord(healed) });
      }
    } catch (error) {
      console.error("[DocWealth] zoho submission lookup failed", error.message);
    }
  }

  res.json({ ok: true, status, portal: publicPortalRecord(record) });
 } catch (error) {
   console.error("[DocWealth] portal-status failed", error.message);
   res.status(500).json({ ok: false, error: "status_check_failed" });
 }
});

app.post("/api/portal-submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const clientId = payload.clientId || "";
    const portalToken = payload.portalToken || "";
    const existing = await findPortalRecord(clientId, portalToken);

    /* DW SECURITY 2 - AUTHENTICATE THE SUBMISSION.
       Previously any anonymous POST with an arbitrary clientId/portalToken was written
       straight into Zoho. Only accept a clientId+token pair the advisor app has registered. */
    if (!existing) {
      console.warn("[DocWealth] rejected portal-submit for unregistered client:", clientId);
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    if (existing.portalStatus === "Submitted" || existing.portalStatus === "Locked") {
      return res.status(409).json({ ok: false, error: "Portal already submitted. Planner must request correction before client can resubmit." });
    }

    const accessToken = await getAccessToken();
    const submissionFields = {
      Client_ID: clientId,
      Section_Name: "Full Portal",
      Document_Type: "Portal JSON",
      Submission_Status: "Pending Review",
      Planner_Notes: "",
      Portal_JSON: JSON.stringify(payload.portalData || {}, null, 2),
    };

    /* ONE submission row per client. Previously every submit INSERTED a new row, so a
       client who submitted (or the app re-saved) many times left dozens of rows behind.
       Now: find this client's existing row and UPDATE it; only insert if none exists. */
    let existingRowId = null;
    try {
      const rep = process.env.ZOHO_DOCUMENTS_REPORT;
      if (rep) {
        const listResp = await fetch(`${creatorUrl(rep)}?max_records=200`, {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        const listData = await listResp.json();
        const rows = (!zohoIsEmptyReport(listData) && Array.isArray(listData.data)) ? listData.data : [];
        /* rows come oldest-first; keep the newest existing row for this client */
        rows.forEach((row) => {
          if (portalRecordClientId(row) === clientId) existingRowId = row.ID;
        });
      }
    } catch (e) {
      console.error("[DocWealth] could not check for an existing submission row:", e.message);
    }

    let data;
    if (existingRowId) {
      const response = await fetch(`${creatorUrl(process.env.ZOHO_DOCUMENTS_REPORT)}/${existingRowId}`, {
        method: "PATCH",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: submissionFields }),
      });
      data = await response.json().catch(() => null);
    } else {
      const response = await fetch(creatorFormUrl(process.env.ZOHO_DOCUMENTS_FORM), {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [submissionFields] }),
      });
      data = await response.json();
    }
    if (data && data.code && data.code !== 3000) return res.status(400).json({ ok: false, zohoResponse: data });

    if (clientId && portalToken) await upsertPortalRecord(payload, { portalStatus: "Submitted", submittedAt: new Date().toISOString() });
    res.json({ ok: true, zohoResponse: data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`DocWealth backend running on http://localhost:${PORT}`);
});
