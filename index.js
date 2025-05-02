const express = require('express');
const cors = require('cors');
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: message }]
    });
    res.json({ reply: response.choices[0].message.content });
  } catch (error) {
    console.error("Chatbot error:", error);
    res.status(500).send("Something went wrong with the chatbot.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Flamingo chatbot is running on port ${PORT}`);
});

