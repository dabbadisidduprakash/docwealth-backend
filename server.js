require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
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

  /* 3100 = "no records found" on an empty report; treat as empty, not an error */
  if (data && data.code && data.code !== 3000 && data.code !== 3100) {
    throw new Error(JSON.stringify(data));
  }

  const rows = Array.isArray(data.data) ? data.data : [];
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

/* Zoho Documents report is the truth for "did this client submit?".
   Used to self-heal a portal link whose status was never marked Submitted. */
const ZOHO_SUBMIT_CACHE = new Map();
const ZOHO_SUBMIT_TTL_MS = 60 * 1000;

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
  const value = latest ? new Date(creatorRecordTime(latest) || Date.now()).toISOString() : null;
  ZOHO_SUBMIT_CACHE.set(clientId, { at: Date.now(), value });
  return value;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "DocWealth backend is running" });
});

app.get("/api/zoho-test", async (req, res) => {
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

app.get("/api/portal-data", async (req, res) => {
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

app.post("/api/client-link", async (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const record = await upsertPortalRecord(payload);
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/portal-sent", async (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const existing = await findPortalRecord(payload.clientId, payload.portalToken);
  const nextStatus = existing && existing.portalStatus === "Needs Correction" ? "Needs Correction" : "Sent";
  const record = await upsertPortalRecord(payload, { portalStatus: nextStatus, lastSentAt: new Date().toISOString() });
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/request-correction", async (req, res) => {
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

    if (existing && (existing.portalStatus === "Submitted" || existing.portalStatus === "Locked")) {
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
