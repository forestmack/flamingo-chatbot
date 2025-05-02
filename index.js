const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const assistantId = "asst_HUbqZgq3MKrotoCBvSPKtwXj";

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    // Step 1: Create a new thread
    const thread = await openai.beta.threads.create();

    // Step 2: Add user's message to thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // Step 3: Run the assistant on the thread
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // Step 4: Poll for completion
    let runStatus;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    } while (runStatus.status !== "completed");

    // Step 5: Get the assistant's reply
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find(
      (msg) => msg.role === "assistant"
    );

    const reply = assistantMessage?.content[0]?.text?.value || "[No reply]";
    res.json({ reply });
  } catch (error) {
    console.error("Assistant API error:", error);
    res.status(500).send("Fiona broke down 😓");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Fiona is live using Assistants API on port ${PORT}`);
});
