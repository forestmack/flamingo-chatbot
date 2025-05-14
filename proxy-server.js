// Flamingo Proxy Server – v1.0
// Node 18 / Express on Render
// -----------------------------------------------------------------------------
//  • /chat       – OpenAI Assistants API (threaded memory)
//  • /openai     – generic Chat Completions proxy (for swiper)
//  • /airtable   – read‑only Airtable REST proxy (Listings / Renters)
//  • CORS locked to flamingolisting.com + localhost for dev
//  • Secrets injected via Render env‑vars
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";
import OpenAI from "openai";

// -----------------------------------------------------------------------------
// Environment variables expected on Render
// -----------------------------------------------------------------------------
//  OPENAI_API_KEY   – your OpenAI secret key
//  AIRTABLE_PAT     – Airtable Personal Access Token (read or rw if needed)
//  AIRTABLE_BASE    – appvxviJeYHM0rx3U
// -----------------------------------------------------------------------------

const {
  OPENAI_API_KEY,
  AIRTABLE_PAT,
  AIRTABLE_BASE,
  NODE_ENV,
} = process.env;

if (!OPENAI_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE) {
  console.error("❌ Missing required env‑vars. Check Render settings.");
  process.exit(1);
}

const app = express();

// Basic hardening
app.use(helmet());

// CORS – allow production domain + localhost for preview
app.use(
  cors({
    origin: [
      "https://www.flamingolisting.com",
      "https://flamingolisting.webflow.io",
      "http://localhost:3000",
    ],
    credentials: false,
  })
);

app.use(express.json({ limit: "1mb" }));

// -----------------------------------------------------------------------------
// OpenAI clients
// -----------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ASSISTANT_ID = "asst_HUbqZgq3MKrotoCBvSPKtwXj"; // Fiona

// -----------------------------------------------------------------------------
// ROUTE: /chat  (Assistants API, stateful thread per request)
// -----------------------------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    // 1. create thread
    const thread = await openai.beta.threads.create();
    // 2. add message
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });
    // 3. run assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID,
    });
    // 4. poll until done (simple)
    while (true) {
      const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (status.status === "completed") break;
      if (status.status === "failed") throw new Error("Assistant run failed");
      await new Promise((r) => setTimeout(r, 1500));
    }
    // 5. get reply
    const msgs = await openai.beta.threads.messages.list(thread.id);
    const assistantMsg = msgs.data.find((m) => m.role === "assistant");
    const reply = assistantMsg?.content?.[0]?.text?.value || "[No reply]";
    return res.json({ reply });
  } catch (err) {
    console.error("/chat error", err);
    res.status(500).json({ error: "Fiona blew a feather" });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: /openai  (generic proxy for chat completions)
// -----------------------------------------------------------------------------
app.post("/openai", async (req, res) => {
  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("/openai error", err);
    res.status(500).json({ error: "openai proxy failure" });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: /airtable  (read‑only proxy)
//   query params -> table, params (URL‑encoded string of Airtable query params)
//   ex: /airtable?table=Listings&params=maxRecords%3D50
// -----------------------------------------------------------------------------
app.get("/airtable", async (req, res) => {
  try {
    const { table = "Listings", params = "" } = req.query;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(
      table
    )}?${params}`;
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    const json = await upstream.json();
    return res.status(upstream.status).json(json);
  } catch (err) {
    console.error("/airtable error", err);
    res.status(500).json({ error: "airtable proxy failure" });
  }
});
app.post("/airtable/swipe", async (req, res) => {
  const { renterId, listingId, action } = req.body;
  if (!renterId || !listingId || !action) {
    return res.status(400).json({ error: "missing fields" });
  }

  const record = {
    fields: {
      "Renter":  [renterId],
      "Listing": [listingId],
      "Action":  action, // expects "Like" or "Dislike"
    },
  };

  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE}/Swipes`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
    },
    body: JSON.stringify({ records: [record] }),
  });

  const data = await upstream.json();
  res.status(upstream.status).json(data);
});
// -----------------------------------------------------------------------------
// Healthcheck
// -----------------------------------------------------------------------------
app.get("/healthz", (req, res) => res.send("ok"));

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🦩 Flamingo proxy listening on ${PORT} (${NODE_ENV || "dev"})`);
});
