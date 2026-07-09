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
  "https://dabbadisidduprakash.github.io,https://docwealth.in,https://www.docwealth.in")
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
  rows.forEach((row) => {
    const rec = portalLinkFromZoho(row);
    if (!rec.clientId || !rec.portalToken) return;
    const key = portalKey(rec.clientId, rec.portalToken);
    byKey.set(key, rec);
    idByKey.set(key, row.ID);
  });

  LINKS_CACHE = { at: Date.now(), byKey, idByKey };
  return LINKS_CACHE;
}

async function zohoUpsertPortalLink(rec) {
  if (!PORTAL_LINKS_FORM || !PORTAL_LINKS_REPORT) throw new Error("Portal_Links form/report env vars not set");

  const key = portalKey(rec.clientId, rec.portalToken);
  let recordId = null;
  try {
    const index = await loadPortalIndex();
    recordId = index.idByKey.get(key) || null;
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
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; /* 30 days */

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
const SKIP_WF = 'skip_workflow=["schedules","form_workflow"]';

function crRowToSummary(row) {
  return {
    clientId: creatorDisplayValue(row.Client_ID).trim(),
    clientName: creatorDisplayValue(row.Client_Name).trim(),
    updatedAt: creatorDisplayValue(row.Updated_At).trim(),
    updatedBy: creatorDisplayValue(row.Updated_By).trim(),
    version: Number(creatorDisplayValue(row.Version)) || 0,
    recordId: row.ID,
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

async function crFindRow(clientId) {
  const rows = await crFetchRows(`Client_ID=="${String(clientId).replace(/"/g, "")}"`);
  if (!rows.length) return null;
  return crRowToSummary(rows[0]);
}

async function crUpsertRow(clientId, fields) {
  const accessToken = await getAccessToken();
  const existing = await crFindRow(clientId);
  if (existing) {
    const response = await fetch(`${creatorUrl(CR_REPORT)}/${existing.recordId}?${SKIP_WF}`, {
      method: "PATCH",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: fields }),
    });
    const data = await response.json();
    if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
    return existing.recordId;
  }
  if (!CR_FORM) throw new Error("ZOHO_CLIENT_RECORDS_FORM is not set");
  const response = await fetch(`${creatorFormUrl(CR_FORM)}?${SKIP_WF}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [fields] }),
  });
  const data = await response.json();
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));

  /* Prefer the ID Zoho returns from the insert. Re-querying by criteria can briefly
     miss a just-created row while the report index catches up. */
  let newId = null;
  try {
    const first = Array.isArray(data.data) ? data.data[0] : null;
    newId = (first && ((first.data && first.data.ID) || first.ID)) || null;
  } catch (error) {
    newId = null;
  }
  if (newId) return newId;

  const created = await crFindRow(clientId);
  if (!created) throw new Error("record created but not found in report");
  return created.recordId;
}

async function crUploadRecordFile(recordId, clientId, recordJson) {
  const accessToken = await getAccessToken();
  const form = new FormData();
  form.append("file", new Blob([recordJson], { type: "application/json" }), `client_${clientId}.json`);
  const response = await fetch(`${creatorUrl(CR_REPORT)}/${recordId}/${CR_FILE_FIELD}/upload?${SKIP_WF}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });
  const data = await response.json().catch(function () { return null; });
  if (data && data.code && data.code !== 3000) throw new Error(JSON.stringify(data));
  return true;
}

async function crDownloadRecordFile(recordId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${creatorUrl(CR_REPORT)}/${recordId}/${CR_FILE_FIELD}/download`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!response.ok) throw new Error("file download failed: HTTP " + response.status);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("stored record is not valid JSON");
  }
}

/* ---- list every client (shared workspace: all advisors see all clients) ---- */
app.get("/api/clients", requireAuth, async (req, res) => {
  try {
    const rows = await crFetchRows(null);
    const clients = rows.map(crRowToSummary).filter((c) => c.clientId);
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
    const record = await crDownloadRecordFile(row.recordId);
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
    const existing = await crFindRow(clientId);

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

    const recordId = await crUpsertRow(clientId, {
      Client_ID: clientId,
      Client_Name: clientName,
      Updated_At: new Date().toISOString(),
      Updated_By: `${advisorName} (${advisorId})`,
      Version: nextVersion,
    });

    await crUploadRecordFile(recordId, clientId, JSON.stringify(record));
    res.json({ ok: true, clientId, version: nextVersion, updatedBy: `${advisorName} (${advisorId})` });
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

app.get("/api/portal-data", requireAuth, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    const token = String(req.query.token || "").trim();
    if (!clientId || !token) return res.status(401).json({ ok: false, error: "unauthorized" });

    const portalRecord = await findPortalRecord(clientId, token);
    if (!portalRecord) return res.status(401).json({ ok: false, error: "unauthorized" });

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

app.post("/api/client-link", requireAuth, async (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const record = await upsertPortalRecord(payload);
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/portal-sent", requireAuth, async (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const existing = await findPortalRecord(payload.clientId, payload.portalToken);
  const nextStatus = existing && existing.portalStatus === "Needs Correction" ? "Needs Correction" : "Sent";
  const record = await upsertPortalRecord(payload, { portalStatus: nextStatus, lastSentAt: new Date().toISOString() });
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/request-correction", requireAuth, async (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const record = await upsertPortalRecord(payload, { portalStatus: "Needs Correction", correctionRequestedAt: new Date().toISOString() });
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

/* THE BUG: the old fallback answered {ok:true,status:"Open"} for EVERY unknown client -
   including fabricated ones - and the advisor app wrote that over each client's real status.
   Now: unknown => 401 (the frontend keeps whatever it knows). Known but not yet marked
   submitted => ask the Zoho Documents report, and self-heal. */
app.get("/api/portal-status", async (req, res) => {
  const clientId = String(req.query.clientId || "").trim();
  const token = String(req.query.token || "").trim();
  if (!clientId || !token) return res.status(400).json({ ok: false, error: "missing_params" });

  const record = await findPortalRecord(clientId, token);
  if (!record) return res.status(401).json({ ok: false, error: "unauthorized" });

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
    const response = await fetch(creatorFormUrl(process.env.ZOHO_DOCUMENTS_FORM), {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: [
          {
            Client_ID: clientId,
            Section_Name: "Full Portal",
            Document_Type: "Portal JSON",
            Submission_Status: "Pending Review",
            Planner_Notes: "",
            Portal_JSON: JSON.stringify(payload.portalData || {}, null, 2),
          },
        ],
      }),
    });

    const data = await response.json();
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
