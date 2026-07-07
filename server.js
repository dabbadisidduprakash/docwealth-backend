require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const PORTAL_STORE_PATH = path.join(__dirname, "portal-links.json");

function readPortalStore() {
  try {
    return JSON.parse(fs.readFileSync(PORTAL_STORE_PATH, "utf8"));
  } catch {
    return { links: {} };
  }
}

function writePortalStore(store) {
  fs.writeFileSync(PORTAL_STORE_PATH, JSON.stringify(store, null, 2));
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

function upsertPortalRecord(payload, patch = {}) {
  const store = readPortalStore();
  const key = portalKey(payload.clientId, payload.portalToken);
  const existing = store.links[key] || {};
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
  store.links[key] = next;
  writePortalStore(store);
  return next;
}

function findPortalRecord(clientId, token) {
  const store = readPortalStore();
  return store.links[portalKey(clientId, token)] || null;
}

async function getAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const response = await fetch(`https://accounts.zoho.in/oauth/v2/token?${params}`, { method: "POST" });
  const data = await response.json();

  if (!data.access_token) throw new Error(JSON.stringify(data));
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

    const portalRecord = findPortalRecord(clientId, token);
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

app.post("/api/client-link", (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const record = upsertPortalRecord(payload);
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/portal-sent", (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const existing = findPortalRecord(payload.clientId, payload.portalToken);
  const nextStatus = existing && existing.portalStatus === "Needs Correction" ? "Needs Correction" : "Sent";
  const record = upsertPortalRecord(payload, { portalStatus: nextStatus, lastSentAt: new Date().toISOString() });
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.post("/api/request-correction", (req, res) => {
  const payload = req.body || {};
  if (!payload.clientId || !payload.portalToken) return res.status(400).json({ ok: false, error: "Missing clientId or portalToken" });
  const record = upsertPortalRecord(payload, { portalStatus: "Needs Correction", correctionRequestedAt: new Date().toISOString() });
  res.json({ ok: true, portal: publicPortalRecord(record) });
});

app.get("/api/portal-status", (req, res) => {
  const record = findPortalRecord(req.query.clientId, req.query.token);
  if (!record) return res.json({ ok: true, status: "Open" });
  res.json({ ok: true, status: record.portalStatus || "Open", portal: publicPortalRecord(record) });
});

app.post("/api/portal-submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const clientId = payload.clientId || "";
    const portalToken = payload.portalToken || "";
    const existing = findPortalRecord(clientId, portalToken);

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

    if (clientId && portalToken) upsertPortalRecord(payload, { portalStatus: "Submitted", submittedAt: new Date().toISOString() });
    res.json({ ok: true, zohoResponse: data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`DocWealth backend running on http://localhost:${PORT}`);
});
