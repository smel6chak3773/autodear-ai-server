require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const { processMessage } = require("./assistant/brain");
const memoryStore = require("./assistant/memoryStore");
const cacheStore = require("./assistant/cacheStore");
const { diagnoseDeveloperSnapshot } = require("./developer/diagnose");

const app = express();
const vehicleCheckCache = new Map();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

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
app.use(express.json({ limit: "12mb" }));

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
    version: "developer-diagnose-api",
    expectedLatestCommit: "developer-diagnose-api",
  });
});





function normalizeVin(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-HJ-NPR-Z0-9]/g, "")
    .slice(0, 17);
}

function mapVpicFuel(value = "") {
  const text = String(value || "").toLowerCase();

  if (text.includes("electric")) return "electric";
  if (text.includes("hybrid")) return "hybrid";
  if (text.includes("diesel")) return "diesel";

  return "petrol";
}

function mapVpicTransmission(value = "") {
  const text = String(value || "").toLowerCase();

  if (
    text.includes("manual") ||
    text.includes("mechanical")
  ) {
    return "manual";
  }

  if (
    text.includes("cvt") ||
    text.includes("automatic")
  ) {
    return "automatic";
  }

  if (
    text.includes("dual-clutch") ||
    text.includes("dual clutch") ||
    text.includes("dct") ||
    text.includes("automated manual")
  ) {
    return "robot";
  }

  return "";
}

function cleanJsonText(value = "") {
  return String(value || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeVehiclePlate(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^АВЕКМНОРСТУХA-Z0-9]/g, "");
}

app.post("/api/vehicle/read-sts", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY_NOT_CONFIGURED",
      });
    }

    const imageBase64 = String(
      req.body?.imageBase64 ||
      req.body?.base64 ||
      ""
    ).trim();

    const mimeType = String(
      req.body?.mimeType ||
      "image/jpeg"
    ).trim();

    if (!imageBase64) {
      return res.status(400).json({
        ok: false,
        error: "STS_IMAGE_REQUIRED",
      });
    }

    if (
      ![
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
      ].includes(mimeType)
    ) {
      return res.status(400).json({
        ok: false,
        error: "STS_IMAGE_FORMAT_NOT_SUPPORTED",
      });
    }

    const dataUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:${mimeType};base64,${imageBase64}`;

    const response = await openai.responses.create({
      model:
        process.env.OPENAI_STS_MODEL ||
        "gpt-4o-mini",

      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Проанализируй фотографию российского свидетельства о регистрации транспортного средства (СТС). " +
                "Извлеки только данные, которые действительно видны. Ничего не выдумывай. " +
                "Верни строго JSON без markdown со следующими полями: " +
                '{"documentDetected":boolean,"vin":"","plate":"","brand":"","model":"","year":null,' +
                '"vehicleType":"","category":"","bodyNumber":"","chassisNumber":"","color":"","enginePowerHp":null,' +
                '"enginePowerKw":null,"engineDisplacementCc":null,"stsNumber":"","ownerName":"","confidence":"low|medium|high",' +
                '"warnings":[]}. ' +
                "VIN должен содержать 17 символов без пробелов. " +
                "Госномер верни без пробелов. " +
                "Если поле не читается — оставь пустую строку или null.",
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],

      max_output_tokens: 1200,
    });

    const rawText = String(
      response.output_text ||
      ""
    );

    let parsed = null;

    try {
      parsed = JSON.parse(
        cleanJsonText(rawText)
      );
    } catch (error) {
      console.error(
        "[AUTODEAR][STS_JSON_PARSE]",
        rawText
      );

      return res.status(502).json({
        ok: false,
        error: "STS_AI_INVALID_JSON",
      });
    }

    const vin = normalizeVin(
      parsed?.vin || ""
    );

    const plate = normalizeVehiclePlate(
      parsed?.plate || ""
    );

    const vehicle = {
      vin,
      plate,

      brand: String(
        parsed?.brand || ""
      ).trim(),

      model: String(
        parsed?.model || ""
      ).trim(),

      year:
        Number(parsed?.year || 0) ||
        null,

      vehicleType: String(
        parsed?.vehicleType || ""
      ).trim(),

      category: String(
        parsed?.category || ""
      ).trim(),

      bodyNumber: String(
        parsed?.bodyNumber || ""
      ).trim(),

      chassisNumber: String(
        parsed?.chassisNumber || ""
      ).trim(),

      color: String(
        parsed?.color || ""
      ).trim(),

      enginePowerHp:
        Number(
          parsed?.enginePowerHp || 0
        ) || null,

      enginePowerKw:
        Number(
          parsed?.enginePowerKw || 0
        ) || null,

      engineDisplacementCc:
        Number(
          parsed?.engineDisplacementCc || 0
        ) || null,

      stsNumber: String(
        parsed?.stsNumber || ""
      ).trim(),

      ownerName: String(
        parsed?.ownerName || ""
      ).trim(),
    };

    const hasUsefulData = Boolean(
      vehicle.vin ||
      vehicle.plate ||
      vehicle.brand ||
      vehicle.model
    );

    if (
      parsed?.documentDetected === false ||
      !hasUsefulData
    ) {
      return res.status(422).json({
        ok: false,
        error: "STS_NOT_RECOGNIZED",
        confidence:
          parsed?.confidence || "low",
        warnings: Array.isArray(
          parsed?.warnings
        )
          ? parsed.warnings
          : [],
      });
    }

    return res.json({
      ok: true,
      provider: "openai_vision",
      documentDetected: true,
      confidence:
        parsed?.confidence || "medium",
      vehicle,
      warnings: Array.isArray(
        parsed?.warnings
      )
        ? parsed.warnings
        : [],
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][STS_RECOGNITION]",
      error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "STS_RECOGNITION_FAILED",
    });
  }
});


app.post("/api/vehicle/decode", async (req, res) => {
  try {
    const vin = normalizeVin(req.body?.vin);

    if (!vin) {
      return res.status(400).json({
        ok: false,
        error: "VIN_REQUIRED",
      });
    }

    if (vin.length !== 17) {
      return res.status(400).json({
        ok: false,
        error: "VIN_INVALID_LENGTH",
      });
    }

    const cacheKey = `free_decode:${vin}`;

    if (vehicleCheckCache.has(cacheKey)) {
      return res.json(vehicleCheckCache.get(cacheKey));
    }

    const url =
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/` +
      `${encodeURIComponent(vin)}?format=json`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "AUTODEAR/1.0",
      },
    });

    const json = await response.json().catch(() => null);

    if (!response.ok || !json) {
      return res.status(502).json({
        ok: false,
        error: `VPIC_HTTP_${response.status}`,
      });
    }

    const row = Array.isArray(json.Results)
      ? json.Results[0] || {}
      : {};

    const brand = String(row.Make || "").trim();
    const model = String(row.Model || "").trim();
    const year = Number(row.ModelYear || 0);
    const body = String(row.BodyClass || "").trim();
    const fuelRaw = String(row.FuelTypePrimary || "").trim();
    const transmissionRaw = String(row.TransmissionStyle || "").trim();

    const displacement = String(
      row.DisplacementL ||
      ""
    ).trim();

    const engineModel = String(
      row.EngineModel ||
      ""
    ).trim();

    const cylinders = String(
      row.EngineCylinders ||
      ""
    ).trim();

    const engineParts = [
      displacement
        ? `${displacement} л`
        : "",
      engineModel,
      cylinders
        ? `${cylinders} цил.`
        : "",
    ].filter(Boolean);

    const fieldsFound = [
      brand,
      model,
      year,
      body,
      fuelRaw,
      displacement,
      transmissionRaw,
    ].filter(Boolean).length;

    const providerErrorCode = String(
      row.ErrorCode || ""
    );

    const providerErrorText = String(
      row.ErrorText || ""
    );

    if (!brand && !model && !year) {
      return res.status(422).json({
        ok: false,
        error: "VIN_NOT_SUPPORTED_FREE",
        provider: "nhtsa_vpic",
        vin,
        fallbackRequired: true,
        diagnostic: {
          errorCode: providerErrorCode,
          errorText: providerErrorText,
          fieldsFound,
        },
      });
    }

    const result = {
      ok: true,
      provider: "nhtsa_vpic",
      vin,

      complete:
        Boolean(brand) &&
        Boolean(model) &&
        Boolean(year),

      confidence:
        fieldsFound >= 6
          ? "high"
          : fieldsFound >= 3
            ? "medium"
            : "low",

      vehicle: {
        brand,
        model,
        year: year || null,
        body,
        fuel: mapVpicFuel(fuelRaw),
        fuelRaw,
        transmission:
          mapVpicTransmission(transmissionRaw),
        transmissionRaw,
        engine: engineParts.join(" · "),
        displacement,
        engineModel,
        cylinders:
          cylinders
            ? Number(cylinders)
            : null,
        driveType: String(row.DriveType || "").trim(),
        manufacturer: String(
          row.Manufacturer ||
          row.ManufacturerName ||
          ""
        ).trim(),
        plantCountry: String(
          row.PlantCountry ||
          ""
        ).trim(),
      },

      diagnostic: {
        errorCode: providerErrorCode,
        errorText: providerErrorText,
        fieldsFound,
      },
    };

    vehicleCheckCache.set(cacheKey, result);

    return res.json(result);
  } catch (error) {
    console.error(
      "[AUTODEAR][FREE_VIN_DECODE]",
      error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "VIN_DECODE_FAILED",
    });
  }
});


app.post("/api/vehicle-check/report", async (req, res) => {
  try {
    const token = process.env.AVTOVINCODE_TOKEN || "";
    const mode = String(req.body.mode || "").trim();
    const inputVin = String(req.body.vin || "").trim().toUpperCase();
    const plate = String(req.body.plate || req.body.gosnomer || "").trim().toUpperCase();

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "AVTOVINCODE_TOKEN_NOT_CONFIGURED_ON_SERVER",
      });
    }

    const callAvtoVinCod = async (path) => {
      const url = `https://api.avtovincod.ru${path}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      const json = await response.json().catch(() => null);

      if (!response.ok || !json) {
        throw new Error(json?.error || `AVTOVINCODE_HTTP_${response.status}`);
      }

      if (json?.success === 0) {
        throw new Error(json?.error || json?.code || "AVTOVINCODE_REQUEST_FAILED");
      }

      return json;
    };

    let vin = inputVin;
    let numberResult = null;

    const directCacheKey = vin ? `vin:${vin}` : "";
    if (directCacheKey && vehicleCheckCache.has(directCacheKey)) {
      return res.json(vehicleCheckCache.get(directCacheKey));
    }

    if (mode === "number") {
      if (!plate) return res.status(400).json({ ok: false, error: "PLATE_REQUIRED" });

      numberResult = await callAvtoVinCod(`/gos2vin?plate=${encodeURIComponent(plate)}`);

      if (!numberResult?.success) {
        return res.status(400).json({
          ok: false,
          error: numberResult?.error || "VIN_BY_PLATE_NOT_FOUND",
          providerCode: numberResult?.code || null,
          raw: { numberResult },
        });
      }

      vin =
        numberResult?.vin ||
        numberResult?.record?.vin ||
        numberResult?.result?.vin ||
        numberResult?.result?.number2vin?.vin ||
        "";
    }

    if (!vin) return res.status(400).json({ ok: false, error: "VIN_REQUIRED" });

    const [registration, score] = await Promise.all([
      callAvtoVinCod(`/vin?vin=${encodeURIComponent(vin)}`),
      callAvtoVinCod(`/score?vin=${encodeURIComponent(vin)}`),
    ]);

    if (!registration?.success && !score?.success) {
      return res.status(400).json({
        ok: false,
        error: registration?.error || score?.error || "VIN_CHECK_FAILED",
        providerCode: registration?.code || score?.code || null,
        raw: { numberResult, registration, score },
      });
    }

    const registrationRecord = registration?.record || {};
    const scoreRecord = score?.record || {};
    const record = {
      ...registrationRecord,
      ...scoreRecord,
      regNumber: scoreRecord.regNumber || registrationRecord.regNumber || plate || null,
      pts: {
        ...(registrationRecord.pts || {}),
        ...(scoreRecord.pts || {}),
        num: scoreRecord?.pts?.num || registrationRecord?.pts?.num || null,
        date: scoreRecord?.pts?.date || registrationRecord?.pts?.date || null,
      },
      sts: {
        ...(registrationRecord.sts || {}),
        ...(scoreRecord.sts || {}),
        num: scoreRecord?.sts?.num || registrationRecord?.sts?.num || null,
        date: scoreRecord?.sts?.date || registrationRecord?.sts?.date || null,
      },
      ownershipPeriods:
        Array.isArray(scoreRecord.ownershipPeriods) && scoreRecord.ownershipPeriods.length
          ? scoreRecord.ownershipPeriods
          : registrationRecord.ownershipPeriods || [],
    };
    const ownershipPeriods = Array.isArray(record.ownershipPeriods)
      ? record.ownershipPeriods
      : [];

    const finalReport = {
      ok: true,
      provider: "avtovincode",
      vin,
      numberResult,
      raw: {
        registration,
        score,
      },
      result: {
        gibdd: {
          vehicle: {
            vin: record.vin || vin,
            bodyNumber: record.bodyNumber || null,
            regNumber: record.regNumber || plate || null,
            model: record.model || null,
            year: record.year || null,
            color: record.color || null,
            engineVolume: record.engineVolume || null,
            powerHp: record.powerHp || null,
            powerKwt: record.powerKwt || null,
            category: record.category || null,
            maxWeight: record.maxWeight || null,
            weightWithoutLoading: record.weightWithoutLoading || null,
            recordStatus: record.recordStatus || null,
            lastRegAction: record.lastRegAction || null,
          },
          pts: record.pts || null,
          sts: record.sts || null,
          ownershipPeriods,
          ownersCount: ownershipPeriods.length,
        },
        restrict: {
          items: score?.restrictions || [],
          restricted: Boolean(score?.status?.restricted),
        },
        dtp: null,
        wanted: {
          items: score?.searches || [],
          wanted: Boolean(score?.status?.wanted),
          specWanted: Boolean(score?.status?.spec_wanted),
        },
      },
      ai: {
        riskLevel:
          score?.status?.restricted || score?.status?.wanted || score?.status?.spec_wanted
            ? "high"
            : ownershipPeriods.length >= 6
              ? "medium"
              : "low",
        title:
          score?.status?.restricted || score?.status?.wanted || score?.status?.spec_wanted
            ? "Высокий риск"
            : ownershipPeriods.length >= 6
              ? "Средний риск"
              : "Низкий риск",
        summary:
          score?.status?.restricted || score?.status?.wanted || score?.status?.spec_wanted
            ? "Найдены ограничения или признаки розыска. Такой автомобиль нельзя покупать без дополнительной юридической проверки."
            : ownershipPeriods.length >= 6
              ? `Ограничений и розыска не найдено, но у автомобиля много периодов владения: ${ownershipPeriods.length}. Перед покупкой стоит проверить пробег, ДТП и сервисную историю.`
              : "Ограничений и розыска не найдено. По базовым данным критических рисков не видно.",
      },
    };

    vehicleCheckCache.set(`vin:${vin}`, finalReport);
    return res.json(finalReport);
  } catch (error) {
    console.error("[AUTODEAR][VEHICLE_CHECK] error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "VEHICLE_CHECK_UNKNOWN_ERROR",
    });
  }
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
      .upsert(payload, { onConflict: "expo_push_token" })
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

app.post("/api/developer/diagnose", async (req, res) => {
  try {
    const snapshot = req.body?.snapshot || {};

    const result = await diagnoseDeveloperSnapshot(snapshot);

    return res.json({
      ok: true,
      aiUsed: result.aiUsed,
      diagnosis: result.diagnosis,
    });
  } catch (error) {
    console.error("[AUTODEAR][DEVELOPER_DIAGNOSE_ROUTE]", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "DEVELOPER_DIAGNOSE_FAILED",
    });
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
