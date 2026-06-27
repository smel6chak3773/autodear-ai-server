require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const { processMessage } = require("./assistant/brain");
const memoryStore = require("./assistant/memoryStore");
const cacheStore = require("./assistant/cacheStore");

const app = express();

const PORT = Number(process.env.PORT || process.env.AUTODEAR_AI_PORT || 3010);

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  "";

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

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

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: "supabase-station-search-22a54f5",
    expectedLatestCommit: "22a54f5",
  });
});


app.post("/api/push/register-token", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    const nowIso = new Date().toISOString();
    const token = String(req.body.token || req.body.fcmToken || "").trim();

    if (!token) {
      return res.status(400).json({ ok: false, error: "token_required" });
    }

    const payload = {
      user_id: req.body.user_id || req.body.userId || null,
      user_email: req.body.user_email || req.body.userEmail || null,
      role: req.body.role || "guest",
      expo_push_token: token,
      platform: req.body.platform || "android",
      device_name: req.body.device_name || req.body.deviceName || null,
      app_env: req.body.app_env || req.body.appEnv || "production",
      is_active: true,
      updated_at: nowIso,
    };

    const { data, error } = await supabase
      .from("device_push_tokens")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.error("[AUTODEAR][PUSH] register-token failed:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, id: data?.id || null });
  } catch (error) {
    console.error("[AUTODEAR][PUSH] register-token error:", error);
    return res.status(500).json({ ok: false, error: error?.message || "unknown" });
  }
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
