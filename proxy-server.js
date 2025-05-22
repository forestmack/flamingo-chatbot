// Flamingo Proxy Server – v1.1
// Node 18 / Express on Render
// -----------------------------------------------------------------------------
//  • /chat         – OpenAI Assistants API (now with potential for swipe-based context)
//  • /openai       – generic Chat Completions proxy
//  • /airtable     – read-only Airtable REST proxy (Listings / Renters)
//  • /airtable/swipe – logs user swipes to Airtable "Swipes" table
//  • CORS locked to flamingolisting.com + localhost for dev
//  • Secrets injected via Render env‑vars
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch"; // Ensure you are using node-fetch v3+ for ESM
import OpenAI from "openai";

// -----------------------------------------------------------------------------
// Environment variables expected on Render
// -----------------------------------------------------------------------------
//  OPENAI_API_KEY    – your OpenAI secret key
//  AIRTABLE_PAT      – Airtable Personal Access Token (read or rw if needed)
//  AIRTABLE_BASE     – appvxviJeYHM0rx3U (Your Airtable Base ID)
//  SWIPES_TABLE_NAME – Name or ID of your "Swipes" table in Airtable (e.g., "Swipes")
// -----------------------------------------------------------------------------

const {
  OPENAI_API_KEY,
  AIRTABLE_PAT,
  AIRTABLE_BASE,
  SWIPES_TABLE_NAME, // Added for clarity for the Swipes table
  NODE_ENV,
} = process.env;

if (!OPENAI_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE || !SWIPES_TABLE_NAME) {
  console.error(
    "❌ Missing required env‑vars. Check Render settings. Need OPENAI_API_KEY, AIRTABLE_PAT, AIRTABLE_BASE, SWIPES_TABLE_NAME."
  );
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
      "http://localhost:3000", // For local development
      // Add any other specific development/staging origins if necessary
    ],
    credentials: false, // Set to true if you start using cookies/sessions that need to be sent cross-origin
  })
);

app.use(express.json({ limit: "1mb" })); // For parsing application/json

// -----------------------------------------------------------------------------
// OpenAI clients
// -----------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ASSISTANT_ID = "asst_HUbqZgq3MKrotoCBvSPKtwXj"; // Fiona Assistant ID

// -----------------------------------------------------------------------------
// Helper Function: Get Swipe Summary for a User (Placeholder - Needs Implementation)
// -----------------------------------------------------------------------------
async function getSwipeSummaryForUser(renterId) {
  if (!renterId) return null;

  // Construct the URL to fetch swipes for the given renterId
  // This uses Airtable's filterByFormula to find matching records.
  // Ensure 'Renter_ID' is the exact field name in your 'Swipes' table that stores the Memberstack ID.
  const filterFormula = encodeURIComponent(`{Renter_ID} = "${renterId}"`);
  const fieldsToFetch = encodeURIComponent("Action,Listing"); // Example fields
  const airtableSwipesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(SWIPES_TABLE_NAME)}?filterByFormula=${filterFormula}&fields%5B%5D=${fieldsToFetch}`;

  console.log(`[Chat Helper] Fetching swipe summary for ${renterId} from ${airtableSwipesUrl}`);

  try {
    const response = await fetch(airtableSwipesUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (!response.ok) {
      const errorData = await response.json();
      console.error(
        `[Chat Helper] Airtable error fetching swipes for ${renterId}: ${response.status}`,
        errorData
      );
      return null;
    }
    const { records } = await response.json();
    if (!records || records.length === 0) {
      return "No past swipes recorded for this user.";
    }

    // Process records to create a summary
    let likes = 0;
    let dislikes = 0;
    const likedListingIds = [];

    records.forEach(record => {
      if (record.fields.Action === "Like") {
        likes++;
        if(record.fields.Listing && record.fields.Listing.length > 0) {
          likedListingIds.push(record.fields.Listing[0]); // Assuming Listing is a linked record and we take the first one
        }
      } else if (record.fields.Action === "Dislike") {
        dislikes++;
      }
    });

    // This is a very basic summary. You can make it more sophisticated.
    // For example, fetch details of liked listings to find common features.
    let summary = `User has ${likes} like(s) and ${dislikes} dislike(s).`;
    if (likedListingIds.length > 0) {
        summary += ` IDs of liked listings: ${likedListingIds.join(', ')}.`;
        // TODO: Potentially fetch these listings and summarize their features.
    }
    return summary;

  } catch (error) {
    console.error("[Chat Helper] Error fetching or processing swipe summary:", error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// ROUTE: /chat  (Assistants API, stateful thread per request)
// -----------------------------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, renterId } = req.body; // Expect renterId from frontend if user is logged in

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    let fullContent = message;

    // If renterId is provided, try to get their swipe summary and prepend it to the message
    if (renterId) {
      console.log(`[Chat] Received chat from Renter ID: ${renterId}`);
      const swipeSummary = await getSwipeSummaryForUser(renterId);
      if (swipeSummary) {
        console.log(`[Chat] Using swipe summary for ${renterId}: ${swipeSummary}`);
        // How you incorporate this depends on your Assistant's instructions.
        // Option 1: Prepend to user message
        fullContent = `Context based on user's past property swipes: ${swipeSummary}\n\nUser's current message: ${message}`;
        // Option 2: You might have specific instructions for your assistant to look for "Context:"
      } else {
        console.log(`[Chat] No swipe summary found or error for ${renterId}. Proceeding with original message.`);
      }
    } else {
        console.log("[Chat] Received chat from anonymous user.");
    }

    // 1. Create thread
    const thread = await openai.beta.threads.create();
    // 2. Add message (with potentially enriched content)
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: fullContent,
    });
    // 3. Run assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID,
      // You can pass additional instructions to the assistant here if needed,
      // possibly related to how it should interpret the swipe summary.
      // instructions: "Consider the provided swipe context when formulating your response..."
    });

    // 4. Poll until done (simple polling, consider webhooks for production)
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    while (runStatus.status === "queued" || runStatus.status === "in_progress") {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait 1.5 seconds
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (runStatus.status === "failed") {
      console.error("[Chat] Assistant run failed:", runStatus.last_error);
      throw new Error(`Assistant run failed: ${runStatus.last_error?.message || 'Unknown error'}`);
    }
    if (runStatus.status !== "completed") {
        console.error("[Chat] Assistant run did not complete. Status:", runStatus.status);
        throw new Error(`Assistant run did not complete. Status: ${runStatus.status}`);
    }

    // 5. Get reply
    const messagesPage = await openai.beta.threads.messages.list(thread.id, { order: 'asc' }); // Get messages in chronological order
    const assistantMessages = messagesPage.data.filter((m) => m.run_id === run.id && m.role === "assistant");
    
    // Usually, the last assistant message in the run is the reply.
    // If using tools, there might be multiple assistant messages.
    const reply = assistantMessages.length > 0 
        ? assistantMessages[assistantMessages.length -1].content
            .filter(contentBlock => contentBlock.type === 'text')
            .map(textContent => textContent.text.value)
            .join('\n')
        : "[Fiona is thinking...]";

    return res.json({ reply });

  } catch (err) {
    console.error("/chat error:", err);
    res.status(500).json({ error: err.message || "Fiona blew a feather. Please try again." });
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
      body: JSON.stringify(req.body), // Pass through the request body
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("/openai error:", err);
    res.status(500).json({ error: "OpenAI proxy failure" });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: /airtable  (read-only proxy for listings, etc.)
//  query params -> table, params (URL-encoded string of Airtable query params)
//  ex: /airtable?table=Listings&params=maxRecords%3D50%26filterByFormula%3D...
// -----------------------------------------------------------------------------
app.get("/airtable", async (req, res) => {
  try {
    const { table = "Listings", params = "" } = req.query; // Default to "Listings"
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}?${params}`;
    
    console.log(`[Airtable GET Proxy] Fetching from: ${airtableUrl}`);

    const upstreamResponse = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    const responseData = await upstreamResponse.json();

    if (!upstreamResponse.ok) {
        console.error("[Airtable GET Proxy] Airtable API Error:", responseData);
        const errorMessage = responseData.error?.message || "Failed to fetch data from Airtable.";
        return res.status(upstreamResponse.status).json({ error: "Airtable API error", details: errorMessage });
    }
    
    return res.status(upstreamResponse.status).json(responseData);
  } catch (err) {
    console.error("/airtable GET error:", err);
    res.status(500).json({ error: "Airtable proxy failure (GET)" });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: /airtable/swipe (logs a swipe action)
// -----------------------------------------------------------------------------
app.post("/airtable/swipe", async (req, res) => {
  // Expected from frontend: { renterId, listingRecordId, swipeAction, timestamp }
  const { renterId, listingRecordId, swipeAction, timestamp } = req.body;

  if (!renterId || !listingRecordId || !swipeAction || !timestamp) {
    return res.status(400).json({ 
        error: "Missing required fields. Expected: renterId, listingRecordId, swipeAction, timestamp." 
    });
  }

  // Construct payload for Airtable "Swipes" table
  // Ensure field names match your Airtable base exactly.
  const recordPayload = {
    fields: {
      "Renter_ID": renterId,        // Assuming "Renter_ID" is a Text Field in Airtable for Memberstack ID.
                                    // If "Renter_ID" is a LINKED RECORD field to a "Renters" table, 
                                    // renterId would need to be the Airtable Record ID of that renter.
      "Listing": [listingRecordId], // Assuming "Listing" is a Linked Record field to your "Listings" table.
      "Action": swipeAction,        // Should be "Like" or "Dislike" from frontend.
      "Timestamp": timestamp,       // ISO 8601 string from client.
      // "Instance" (Autonumber) will be auto-populated by Airtable.
    },
  };

  const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(SWIPES_TABLE_NAME)}`;

  console.log(`[Swipe Logger] Attempting to log swipe to ${airtableUrl} for Renter_ID: ${renterId}`);
  console.log("[Swipe Logger] Payload:", JSON.stringify(recordPayload, null, 2));

  try {
    const upstreamResponse = await fetch(airtableUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AIRTABLE_PAT}`,
      },
      // Airtable API for creating records expects a "records" array, even for a single record.
      body: JSON.stringify({ records: [recordPayload] }), 
    });

    const responseData = await upstreamResponse.json();

    if (!upstreamResponse.ok) {
      console.error("[Swipe Logger] Airtable API Error:", responseData);
      const errorMessage = responseData.error?.message || responseData.error?.type || "Failed to communicate with Airtable.";
      return res.status(upstreamResponse.status).json({ error: "Airtable API error when logging swipe", details: errorMessage });
    }

    console.log("[Swipe Logger] Swipe successfully logged to Airtable. New record ID(s):", responseData.records?.map(r => r.id).join(', '));
    res.status(201).json(responseData); // 201 Created is more appropriate for successful POST

  } catch (err) {
    console.error("[Swipe Logger] Error in /airtable/swipe endpoint:", err);
    res.status(500).json({ error: "Internal server error while logging swipe." });
  }
});

// -----------------------------------------------------------------------------
// Healthcheck
// -----------------------------------------------------------------------------
app.get("/healthz", (req, res) => res.send("ok"));

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080; // Render sets the PORT env var
app.listen(PORT, () => {
  console.log(
    `🦩 Flamingo proxy (v1.1) listening on port ${PORT} (NODE_ENV: ${NODE_ENV || "development"})`
  );
});

