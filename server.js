require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { processMessage } = require("./assistant/brain");
const memoryStore = require("./assistant/memoryStore");
const cacheStore = require("./assistant/cacheStore");

const app = express();

const PORT = Number(process.env.PORT || process.env.AUTODEAR_AI_PORT || 3010);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AUTODEAR AI Server",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AUTODEAR AI Server",
    port: PORT,
  });
});

app.post("/api/assistant/cache/clear", (req, res) => {
  cacheStore.clear();
  res.json({ ok: true, message: "Assistant cache cleared" });
});

app.post("/api/assistant/message", async (req, res) => {
  try {
    const userId = String(req.body.userId || "guest_demo");
    const message = String(req.body.message || "").trim();

    if (!message) {
      return res.status(400).json({
        ok: false,
        error: "Message is required",
      });
    }

    const cacheKey = `${userId}:${message}`;
    const cached = cacheStore.get(cacheKey);

    if (cached) {
      return res.json({
        ok: true,
        cached: true,
        answer: cached.value.answer,
        intent: cached.value.intent,
        action: cached.value.action,
        toolData: cached.value.toolData,
      });
    }

    memoryStore.addMessage(userId, "user", message);

    const result = await processMessage({
      userId,
      message,
      session: memoryStore.getSession(userId),
    });

    memoryStore.addMessage(userId, "assistant", result.answer);
    cacheStore.set(cacheKey, result);

    return res.json({
      ok: true,
      cached: false,
      answer: result.answer,
      intent: result.intent,
      action: result.action,
      toolData: result.toolData,
    });
  } catch (error) {
    console.error("AUTODEAR AI error:", error);

    return res.status(500).json({
      ok: false,
      error: "AI server error",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AUTODEAR AI Server started on port ${PORT}`);
});
