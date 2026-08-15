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
const geocodeCache = new Map();

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

app.get("/download", (req, res) => {
  const googlePlayUrl = String(process.env.AUTODEAR_GOOGLE_PLAY_URL || "").trim();
  const ruStoreUrl = String(process.env.AUTODEAR_RUSTORE_URL || "").trim();
  const appStoreUrl = String(process.env.AUTODEAR_APP_STORE_URL || "").trim();

  const storeButton = (url, title, subtitle) => {
    if (!url) {
      return `
        <div class="store disabled">
          <strong>${title}</strong>
          <span>${subtitle} — скоро</span>
        </div>
      `;
    }

    return `
      <a class="store" href="${url}" rel="noopener noreferrer">
        <strong>${title}</strong>
        <span>${subtitle}</span>
      </a>
    `;
  };

  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,maximum-scale=1"
  />
  <title>AUTODEAR — скачать приложение</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background:
        radial-gradient(circle at top, #263244 0%, #111827 48%, #090d14 100%);
      color: #ffffff;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Arial,
        sans-serif;
    }

    .card {
      width: 100%;
      max-width: 520px;
      padding: 34px 28px;
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 30px;
      background: rgba(17,24,39,.88);
      box-shadow: 0 24px 80px rgba(0,0,0,.38);
      text-align: center;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      font-size: 36px;
      font-weight: 900;
      letter-spacing: 1px;
    }

    .auto {
      color: #FFD21F;
    }

    .dear {
      color: #FFFFFF;
    }

    h1 {
      margin: 24px 0 8px;
      font-size: 28px;
      line-height: 1.2;
    }

    .lead {
      margin: 0 auto;
      max-width: 410px;
      color: #AEB7C5;
      font-size: 16px;
      line-height: 1.55;
    }

    .stores {
      display: grid;
      gap: 12px;
      margin-top: 28px;
    }

    .store {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 15px 18px;
      border-radius: 17px;
      background: #FFD21F;
      color: #111827;
      text-decoration: none;
    }

    .store strong {
      font-size: 16px;
    }

    .store span {
      font-size: 13px;
      opacity: .75;
    }

    .store.disabled {
      background: #232D3D;
      color: #98A2B3;
    }

    .footer {
      margin-top: 26px;
      color: #667085;
      font-size: 12px;
    }
  </style>
</head>

<body>
  <main class="card">
    <div class="logo">
      <span class="auto">AUTO</span><span class="dear">DEAR</span>
    </div>

    <h1>Всё для автомобиля — в одном приложении</h1>

    <p class="lead">
      Проверка автомобиля, сервисы рядом, объявления, гараж,
      история обслуживания, чаты и AI-помощник.
    </p>

    <div class="stores">
      ${storeButton(
        googlePlayUrl,
        "Google Play",
        "Версия для Android"
      )}

      ${storeButton(
        ruStoreUrl,
        "RuStore",
        "Версия для Android"
      )}

      ${storeButton(
        appStoreUrl,
        "App Store",
        "Версия для iPhone"
      )}
    </div>

    <div class="footer">
      AUTODEAR © ${new Date().getFullYear()}
    </div>
  </main>
</body>
</html>`);
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

function normalizeGeocodeText(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

app.post("/api/geocode", async (req, res) => {
  try {
    const city = normalizeGeocodeText(req.body?.city);
    const address = normalizeGeocodeText(req.body?.address);

    if (!address) {
      return res.status(400).json({
        ok: false,
        error: "ADDRESS_REQUIRED",
      });
    }

    const query = [city, address]
      .filter(Boolean)
      .join(", ");

    const cacheKey = query.toLowerCase();

    if (geocodeCache.has(cacheKey)) {
      return res.json({
        ...geocodeCache.get(cacheKey),
        cached: true,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let response;

    try {
      const url =
        "https://nominatim.openstreetmap.org/search" +
        `?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;

      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Language": "ru",
          "User-Agent":
            process.env.NOMINATIM_USER_AGENT ||
            "AUTODEAR/1.0",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `GEOCODE_PROVIDER_HTTP_${response.status}`,
      });
    }

    const data = await response.json();
    const item = Array.isArray(data) ? data[0] : null;

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "ADDRESS_NOT_FOUND",
        query,
      });
    }

    const latitude = Number(item.lat);
    const longitude = Number(item.lon);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return res.status(502).json({
        ok: false,
        error: "INVALID_GEOCODE_COORDINATES",
      });
    }

    const result = {
      ok: true,
      latitude,
      longitude,
      displayName: String(item.display_name || query),
      query,
      cached: false,
    };

    geocodeCache.set(cacheKey, result);

    return res.json(result);
  } catch (error) {
    const message = String(error?.message || error || "");

    console.log("[AUTODEAR][GEOCODE_ERROR]", message);

    return res.status(
      message.toLowerCase().includes("abort")
        ? 504
        : 500
    ).json({
      ok: false,
      error: message.toLowerCase().includes("abort")
        ? "GEOCODE_TIMEOUT"
        : "GEOCODE_FAILED",
    });
  }
});

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

    const callOptionalAvtoVinCod = async (
      path,
      sourceName
    ) => {
      const url =
        `https://api.avtovincod.ru${path}`;

      const startedAt = Date.now();

      console.log(
        "[AUTODEAR][VEHICLE_CHECK][SOURCE_BEGIN]",
        {
          source: sourceName,
        }
      );

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept: "application/json",
          },
        });

        const json =
          await response
            .json()
            .catch(() => null);

        console.log(
          "[AUTODEAR][VEHICLE_CHECK][SOURCE_RESPONSE]",
          {
            source: sourceName,
            status: response.status,
            success:
              json?.success ?? null,
            ms:
              Date.now() - startedAt,
          }
        );

        if (!response.ok || !json) {
          return {
            success: 0,
            unavailable: true,
            httpStatus:
              response.status,
            code:
              json?.code || null,
            error:
              json?.error ||
              `AVTOVINCODE_HTTP_${response.status}`,
          };
        }

        return json;
      } catch (error) {
        console.warn(
          "[AUTODEAR][VEHICLE_CHECK][SOURCE_ERROR]",
          {
            source: sourceName,
            message:
              error?.message ||
              String(error),
            ms:
              Date.now() - startedAt,
          }
        );

        return {
          success: 0,
          unavailable: true,
          error:
            error?.message ||
            String(error),
        };
      }
    };

    let vin = inputVin;
    let numberResult = null;

    const directCacheKey =
      vin
        ? `vin:v2:${vin}`
        : "";
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

    const [
      registration,
      score,
      accidents,
    ] = await Promise.all([
      callAvtoVinCod(
        `/vin?vin=${encodeURIComponent(vin)}`
      ),
      callAvtoVinCod(
        `/score?vin=${encodeURIComponent(vin)}`
      ),
      callOptionalAvtoVinCod(
        `/accidents?vin=${encodeURIComponent(vin)}`,
        "accidents"
      ),
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

    const accidentRecords =
      Array.isArray(accidents?.records)
        ? accidents.records
        : [];

    const accidentsChecked =
      accidents?.success === 1;

    const hasAccidents =
      accidentsChecked
        ? Boolean(
            accidents?.hasAccidents ||
            accidentRecords.length > 0
          )
        : false;

    const accidentCount =
      accidentsChecked
        ? Number(
            accidents?.found ??
            accidentRecords.length
          )
        : 0;

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][ACCIDENTS]",
      {
        vin,
        success:
          accidents?.success ?? null,
        checked:
          accidentsChecked,
        hasAccidents:
          accidentsChecked
            ? hasAccidents
            : null,
        found:
          accidentsChecked
            ? accidentCount
            : null,
        notInArchive:
          Boolean(
            accidents?.notInArchive
          ),
        archival:
          Boolean(
            accidents?.archival
          ),
        checkedAt:
          accidents?.checkedAt ||
          null,
      }
    );

    const finalReport = {
      ok: true,
      provider: "avtovincode",
      vin,
      numberResult,
      raw: {
        registration,
        score,
        accidents,
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
        dtp:
          accidentsChecked
            ? {
                available: true,
                archival:
                  Boolean(
                    accidents?.archival
                  ),
                dataNote:
                  accidents?.dataNote ||
                  null,
                checkedAt:
                  accidents?.checkedAt ||
                  null,
                hasAccidents,
                count:
                  accidentCount,
                items:
                  accidentRecords,
              }
            : null,
        wanted: {
          items: score?.searches || [],
          wanted: Boolean(score?.status?.wanted),
          specWanted: Boolean(score?.status?.spec_wanted),
        },
      },
      ai: {
        riskLevel:
          score?.status?.restricted ||
          score?.status?.wanted ||
          score?.status?.spec_wanted
            ? "high"
            : hasAccidents ||
                ownershipPeriods.length >= 6
              ? "medium"
              : "low",

        title:
          score?.status?.restricted ||
          score?.status?.wanted ||
          score?.status?.spec_wanted
            ? "Высокий риск"
            : hasAccidents ||
                ownershipPeriods.length >= 6
              ? "Средний риск"
              : "Низкий риск",

        summary:
          score?.status?.restricted ||
          score?.status?.wanted ||
          score?.status?.spec_wanted
            ? "Найдены ограничения или признаки розыска. Такой автомобиль нельзя покупать без дополнительной юридической проверки."
            : hasAccidents
              ? `В доступном архиве найдены сведения о ДТП: ${accidentCount}. Ограничений и признаков розыска не найдено. Перед покупкой рекомендуется изучить даты и характер повреждений.`
              : ownershipPeriods.length >= 6
                ? `Ограничений и розыска не найдено, но у автомобиля много периодов владения: ${ownershipPeriods.length}. Перед покупкой стоит проверить пробег, ДТП и сервисную историю.`
                : "Ограничений и розыска не найдено. По доступным данным критических рисков не видно.",
      },
    };

    vehicleCheckCache.set(
      `vin:v2:${vin}`,
      finalReport
    );
    return res.json(finalReport);
  } catch (error) {
    console.error("[AUTODEAR][VEHICLE_CHECK] error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "VEHICLE_CHECK_UNKNOWN_ERROR",
    });
  }
});





app.post("/api/payments/ckassa/create", async (req, res) => {
  try {
    const apiLoginAuthorization = String(
      process.env.ApiLoginAuthorization || ""
    ).trim();

    const apiAuthorization = String(
      process.env.ApiAutorization ||
      process.env.ApiAuthorization ||
      ""
    ).trim();

    const servCode = String(
      process.env.servCode || ""
    ).trim();

    if (
      !apiLoginAuthorization ||
      !apiAuthorization ||
      !servCode
    ) {
      console.error(
        "[AUTODEAR][CKASSA][CONFIG_MISSING]",
        {
          hasApiLoginAuthorization:
            Boolean(apiLoginAuthorization),
          hasApiAuthorization:
            Boolean(apiAuthorization),
          hasServCode:
            Boolean(servCode),
        }
      );

      return res.status(500).json({
        ok: false,
        error: "CKASSA_CONFIG_MISSING",
      });
    }

    const email = String(
      req.body?.email || ""
    )
      .trim()
      .toLowerCase();

    const purpose = String(
      req.body?.purpose || ""
    ).trim();

    const targetId = String(
      req.body?.targetId || ""
    ).trim();

    const paymentMethod = String(
      req.body?.paymentMethod || "sbp"
    ).trim();

    const requestedWalletType = String(
      req.body?.walletType || ""
    )
      .trim()
      .toLowerCase();

    const amountKopecks = Number(
      req.body?.amountKopecks
    );

      const allowedPurposes = [
        "wallet_topup",
        "ads_wallet_topup",
      ];

      // TEMP 2026-08-13:
      // CKassa integration test minimum = 50 RUB.
      // IMPORTANT: restore Ads product minimum to 50000
      // after the real end-to-end payment test.
      const minimumAmountKopecks =
        purpose === "ads_wallet_topup"
          ? 5000
          : 10000;

      if (
        !allowedPurposes.includes(purpose) ||
        !targetId ||
        !Number.isInteger(amountKopecks) ||
        amountKopecks < minimumAmountKopecks
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PAYMENT_REQUEST",
        });
      }

    const payload = {
      servCode,
      startPaySelect: true,
      invType: "READ_ONLY",
      amount: amountKopecks,
      properties: [
        email,
      ],
    };

    console.log(
      "[AUTODEAR][CKASSA][CREATE_REQUEST]",
      {
        amountKopecks,
        purpose,
        targetId,
        paymentMethod,
        hasEmail: Boolean(email),
        servCode,
      }
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, 60000);

    let ckassaResponse;

    try {
      ckassaResponse = await fetch(
        "https://api2.ckassa.ru/api-shop/rs/open/invoice/create2",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/plain, application/json",
            ApiLoginAuthorization:
              apiLoginAuthorization,
            ApiAuthorization:
              apiAuthorization,
          },
          body:
            JSON.stringify(payload),
          signal:
            controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = String(
      await ckassaResponse.text()
    ).trim();

    if (!ckassaResponse.ok) {
      console.error(
        "[AUTODEAR][CKASSA][CREATE_FAILED]",
        {
          status:
            ckassaResponse.status,
          body:
            raw.slice(0, 1000),
        }
      );

      return res.status(502).json({
        ok: false,
        error: "CKASSA_CREATE_FAILED",
        providerStatus:
          ckassaResponse.status,
      });
    }

    let paymentUrl = raw;

    if (
      raw.startsWith('"') &&
      raw.endsWith('"')
    ) {
      try {
        paymentUrl =
          JSON.parse(raw);
      } catch {}
    }

    paymentUrl = String(
      paymentUrl || ""
    ).trim();

    if (
      !paymentUrl.startsWith(
        "https://"
      )
    ) {
      console.error(
        "[AUTODEAR][CKASSA][INVALID_PAYMENT_URL]",
        {
          body:
            raw.slice(0, 1000),
        }
      );

      return res.status(502).json({
        ok: false,
        error:
          "CKASSA_INVALID_PAYMENT_URL",
      });
    }

    if (!supabase) {
      console.error(
        "[AUTODEAR][CKASSA][PAYMENT_REGISTRY_UNAVAILABLE]"
      );

      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const walletType =
      purpose === "ads_wallet_topup"
        ? "ads"
        : requestedWalletType === "business"
        ? "business"
        : "personal";

    const paymentRecord = {
      provider: "ckassa",
      purpose,
      target_id: targetId,
      wallet_type: walletType,
      email,
      amount_kopecks: amountKopecks,
      payment_method: paymentMethod,
      invoice_url: paymentUrl,
      status: "pending",
    };

    const {
      data: storedPayment,
      error: paymentStoreError,
    } = await supabase
      .from("ckassa_payments")
      .upsert(
        paymentRecord,
        {
          onConflict: "invoice_url",
          ignoreDuplicates: false,
        }
      )
      .select(
        "id,purpose,target_id,wallet_type,amount_kopecks,status,created_at"
      )
      .single();

    if (paymentStoreError) {
      console.error(
        "[AUTODEAR][CKASSA][PAYMENT_REGISTRY_ERROR]",
        {
          code: paymentStoreError.code,
          message: paymentStoreError.message,
          details: paymentStoreError.details,
        }
      );

      return res.status(500).json({
        ok: false,
        error: "PAYMENT_REGISTRY_ERROR",
      });
    }

    console.log(
      "[AUTODEAR][CKASSA][PAYMENT_REGISTERED]",
      {
        paymentId: storedPayment?.id || null,
        purpose,
        targetId,
        amountKopecks,
        status: storedPayment?.status || "pending",
      }
    );

    console.log(
      "[AUTODEAR][CKASSA][CREATE_OK]",
      {
        amountKopecks,
        targetId,
        paymentId:
          storedPayment?.id || null,
        paymentUrlHost:
          (() => {
            try {
              return new URL(
                paymentUrl
              ).host;
            } catch {
              return null;
            }
          })(),
      }
    );

    return res.json({
      ok: true,
      paymentUrl,
      paymentId:
        storedPayment?.id || null,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][CKASSA][CREATE_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.name ===
        "AbortError"
          ? "CKASSA_TIMEOUT"
          : error?.message ||
            "CKASSA_CREATE_ERROR",
    });
  }
});



app.get("/api/payments/ckassa/callback", (req, res) => {
  return res.json({
    ok: true,
    service: "AUTODEAR CKassa callback",
    ready: true,
  });
});


app.post("/api/payments/ckassa/callback", async (req, res) => {
  try {
    if (!supabase) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_SUPABASE_UNAVAILABLE]"
      );

      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const regPayNum = String(
      req.body?.regPayNum || ""
    ).trim();

    const providerState = String(
      req.body?.state || ""
    )
      .trim()
      .toUpperCase();

    const callbackAmountKopecks = Number(
      req.body?.amount
    );

    const callbackProperty =
      req.body?.property ||
      req.body?.map ||
      null;

    let callbackEmail = "";

    if (
      callbackProperty &&
      typeof callbackProperty === "object"
    ) {
      for (const value of Object.values(
        callbackProperty
      )) {
        const candidate = String(
          value || ""
        )
          .trim()
          .toLowerCase();

        if (candidate.includes("@")) {
          callbackEmail = candidate;
          break;
        }
      }
    }

    console.log(
      "[AUTODEAR][CKASSA][CALLBACK_RECEIVED]",
      {
        regPayNum,
        providerState,
        callbackAmountKopecks,
        hasEmail: Boolean(callbackEmail),
      }
    );

    if (
      !regPayNum ||
      !providerState ||
      !Number.isInteger(
        callbackAmountKopecks
      ) ||
      callbackAmountKopecks <= 0
    ) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_INVALID]",
        {
          regPayNum,
          providerState,
          callbackAmountKopecks,
        }
      );

      return res.status(400).json({
        ok: false,
        error: "INVALID_CKASSA_CALLBACK",
      });
    }

    let paymentQuery = supabase
      .from("ckassa_payments")
      .select(
        "id,purpose,target_id,wallet_type,email,amount_kopecks,status,reg_pay_num,created_at"
      )
      .eq(
        "amount_kopecks",
        callbackAmountKopecks
      )
      .in(
        "status",
        [
          "pending",
          "processing",
          "paid",
          "credited",
        ]
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(10);

    if (callbackEmail) {
      paymentQuery =
        paymentQuery.eq(
          "email",
          callbackEmail
        );
    }

    const {
      data: candidatePayments,
      error: candidateError,
    } = await paymentQuery;

    if (candidateError) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_LOOKUP_ERROR]",
        {
          code: candidateError.code,
          message:
            candidateError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "CKASSA_CALLBACK_LOOKUP_ERROR",
      });
    }

    const candidates =
      Array.isArray(candidatePayments)
        ? candidatePayments
        : [];

    let payment = null;

    const alreadyBound =
      candidates.find(
        (item) =>
          String(
            item.reg_pay_num || ""
          ) === regPayNum
      );

    if (alreadyBound) {
      payment = alreadyBound;
    } else if (
      candidates.length === 1
    ) {
      payment = candidates[0];
    } else {
      const pendingCandidates =
        candidates.filter(
          (item) =>
            item.status ===
              "pending" ||
            item.status ===
              "processing"
        );

      if (
        pendingCandidates.length === 1
      ) {
        payment =
          pendingCandidates[0];
      }
    }

    if (!payment) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_PAYMENT_NOT_FOUND]",
        {
          regPayNum,
          callbackAmountKopecks,
          callbackEmail:
            callbackEmail || null,
          candidates:
            candidates.length,
        }
      );

      return res.status(404).json({
        ok: false,
        error:
          "CKASSA_PAYMENT_NOT_FOUND",
      });
    }

    if (
      Number(payment.amount_kopecks) !==
      callbackAmountKopecks
    ) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_AMOUNT_MISMATCH]",
        {
          paymentId:
            payment.id,
          expected:
            payment.amount_kopecks,
          received:
            callbackAmountKopecks,
        }
      );

      return res.status(400).json({
        ok: false,
        error:
          "CKASSA_AMOUNT_MISMATCH",
      });
    }

    const {
      data: creditResult,
      error: creditError,
    } = await supabase.rpc(
      "autodear_credit_ckassa_payment",
      {
        p_payment_id:
          payment.id,
        p_reg_pay_num:
          regPayNum,
        p_provider_state:
          providerState,
        p_callback_payload:
          req.body || {},
      }
    );

    if (creditError) {
      console.error(
        "[AUTODEAR][CKASSA][CALLBACK_CREDIT_ERROR]",
        {
          paymentId:
            payment.id,
          regPayNum,
          code:
            creditError.code,
          message:
            creditError.message,
          details:
            creditError.details,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "CKASSA_CREDIT_ERROR",
      });
    }

    console.log(
      "[AUTODEAR][CKASSA][CALLBACK_OK]",
      {
        paymentId:
          payment.id,
        regPayNum,
        providerState,
        result:
          creditResult,
      }
    );

    return res.status(200).json({
      ok: true,
      paymentId:
        payment.id,
      result:
        creditResult,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][CKASSA][CALLBACK_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "CKASSA_CALLBACK_ERROR",
    });
  }
});



app.post("/api/payments/ckassa/sync-new", async (req, res) => {
  try {
    const expectedSyncKey = String(
      process.env.CKASSA_SYNC_KEY || ""
    ).trim();

    const receivedSyncKey = String(
      req.headers["x-autodear-sync-key"] || ""
    ).trim();

    if (
      !expectedSyncKey ||
      !receivedSyncKey ||
      receivedSyncKey !== expectedSyncKey
    ) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const apiLoginAuthorization = String(
      process.env.ApiLoginAuthorization || ""
    ).trim();

    const apiAuthorization = String(
      process.env.ApiAutorization ||
      process.env.ApiAuthorization ||
      ""
    ).trim();

    if (
      !apiLoginAuthorization ||
      !apiAuthorization
    ) {
      return res.status(500).json({
        ok: false,
        error: "CKASSA_CONFIG_MISSING",
      });
    }

    console.log(
      "[AUTODEAR][CKASSA][SYNC_NEW_BEGIN]"
    );

    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      60000
    );

    let ckassaResponse;

    try {
      ckassaResponse = await fetch(
        "https://api2.ckassa.ru/api-shop/rs/open/payments/new",
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            ApiLoginAuthorization:
              apiLoginAuthorization,
            ApiAuthorization:
              apiAuthorization,
          },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = String(
      await ckassaResponse.text()
    ).trim();

    if (!ckassaResponse.ok) {
      console.error(
        "[AUTODEAR][CKASSA][SYNC_NEW_PROVIDER_ERROR]",
        {
          status: ckassaResponse.status,
          body: raw.slice(0, 600),
        }
      );

      return res.status(502).json({
        ok: false,
        error: "CKASSA_SYNC_PROVIDER_ERROR",
        providerStatus:
          ckassaResponse.status,
      });
    }

    let providerData;

    try {
      providerData = raw
        ? JSON.parse(raw)
        : {};
    } catch {
      console.error(
        "[AUTODEAR][CKASSA][SYNC_NEW_INVALID_JSON]"
      );

      return res.status(502).json({
        ok: false,
        error: "CKASSA_SYNC_INVALID_JSON",
      });
    }

    /*
     * Open API документирует:
     * {
     *   payments: [...]
     * }
     *
     * Оставляем также поддержку массива,
     * если провайдер вернёт его напрямую.
     */
    const payments = Array.isArray(
      providerData
    )
      ? providerData
      : Array.isArray(
          providerData?.payments
        )
      ? providerData.payments
      : [];

    const summary = {
      fetched: payments.length,
      matched: 0,
      credited: 0,
      duplicate: 0,
      notPaid: 0,
      ambiguous: 0,
      notFound: 0,
      invalid: 0,
      errors: 0,
    };

    for (const providerPayment of payments) {
      const regPayNum = String(
        providerPayment?.regPayNum || ""
      ).trim();

      const providerState = String(
        providerPayment?.state || ""
      )
        .trim()
        .toUpperCase();

      const amountKopecks = Number(
        providerPayment?.amount
      );

      if (
        !regPayNum ||
        !providerState ||
        !Number.isInteger(
          amountKopecks
        ) ||
        amountKopecks <= 0
      ) {
        summary.invalid += 1;
        continue;
      }

      let email = "";

      const properties =
        providerPayment?.properties;

      if (Array.isArray(properties)) {
        for (const item of properties) {
          const candidate = String(
            item?.value || ""
          )
            .trim()
            .toLowerCase();

          if (candidate.includes("@")) {
            email = candidate;
            break;
          }
        }
      } else if (
        properties &&
        typeof properties === "object"
      ) {
        for (const value of Object.values(
          properties
        )) {
          const candidate = String(
            value || ""
          )
            .trim()
            .toLowerCase();

          if (candidate.includes("@")) {
            email = candidate;
            break;
          }
        }
      }

      /*
       * Сначала ищем уже связанный regPayNum.
       */
      const {
        data: boundPayment,
        error: boundError,
      } = await supabase
        .from("ckassa_payments")
        .select(
          "id,email,amount_kopecks,status,reg_pay_num"
        )
        .eq(
          "reg_pay_num",
          regPayNum
        )
        .maybeSingle();

      if (boundError) {
        summary.errors += 1;
        continue;
      }

      let localPayment =
        boundPayment || null;

      /*
       * Если regPayNum ещё не привязан,
       * ищем pending по сумме + email.
       *
       * При нескольких совпадениях ничего
       * автоматически не начисляем.
       */
      if (!localPayment) {
        let pendingQuery = supabase
          .from("ckassa_payments")
          .select(
            "id,email,amount_kopecks,status,reg_pay_num,created_at"
          )
          .eq(
            "amount_kopecks",
            amountKopecks
          )
          .in(
            "status",
            [
              "pending",
              "processing",
              "paid",
            ]
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          )
          .limit(10);

        if (email) {
          pendingQuery =
            pendingQuery.eq(
              "email",
              email
            );
        }

        const {
          data: pendingPayments,
          error: pendingError,
        } = await pendingQuery;

        if (pendingError) {
          summary.errors += 1;
          continue;
        }

        const candidates =
          Array.isArray(pendingPayments)
            ? pendingPayments
            : [];

        if (candidates.length === 0) {
          summary.notFound += 1;

          console.warn(
            "[AUTODEAR][CKASSA][SYNC_NEW_NOT_FOUND]",
            {
              regPayNum,
              providerState,
              amountKopecks,
              email: email || null,
              providerPayment,
            }
          );

          continue;
        }

        if (candidates.length !== 1) {
          summary.ambiguous += 1;

          console.warn(
            "[AUTODEAR][CKASSA][SYNC_NEW_AMBIGUOUS]",
            {
              regPayNum,
              amountKopecks,
              hasEmail: Boolean(email),
              candidates:
                candidates.length,
            }
          );

          continue;
        }

        localPayment =
          candidates[0];
      }

      summary.matched += 1;

      const {
        data: creditResult,
        error: creditError,
      } = await supabase.rpc(
        "autodear_credit_ckassa_payment",
        {
          p_payment_id:
            localPayment.id,
          p_reg_pay_num:
            regPayNum,
          p_provider_state:
            providerState,
          p_callback_payload:
            providerPayment || {},
        }
      );

      if (creditError) {
        summary.errors += 1;

        console.error(
          "[AUTODEAR][CKASSA][SYNC_NEW_CREDIT_ERROR]",
          {
            paymentId:
              localPayment.id,
            regPayNum,
            code:
              creditError.code,
            message:
              creditError.message,
          }
        );

        continue;
      }

      if (
        creditResult?.duplicate === true
      ) {
        summary.duplicate += 1;
      } else if (
        creditResult?.credited === true
      ) {
        summary.credited += 1;
      } else {
        summary.notPaid += 1;
      }
    }

    console.log(
      "[AUTODEAR][CKASSA][SYNC_NEW_OK]",
      summary
    );

    return res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][CKASSA][SYNC_NEW_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.name === "AbortError"
          ? "CKASSA_SYNC_TIMEOUT"
          : error?.message ||
            "CKASSA_SYNC_ERROR",
    });
  }
});



// ============================================================
// AUTODEAR ADS — REAL SERVER WALLET
// Supabase is the source of truth.
// Client can read the wallet through AUTODEAR API,
// but cannot modify the financial tables directly.
// ============================================================


// ============================================================
// AUTODEAR CENTRAL WALLET — PERSONAL / BUSINESS
//
// Supabase is the financial source of truth.
//
// One owner may have two independent wallets:
//   personal
//   business
//
// The client may READ financial state through AUTODEAR API,
// but must never create money locally.
// ============================================================

app.get("/api/wallet/:walletType/:ownerId", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const ownerId = String(
      req.params?.ownerId || ""
    ).trim();

    const walletType = String(
      req.params?.walletType || ""
    )
      .trim()
      .toLowerCase();

    if (!ownerId) {
      return res.status(400).json({
        ok: false,
        error: "OWNER_ID_REQUIRED",
      });
    }

    if (
      walletType !== "personal" &&
      walletType !== "business"
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_WALLET_TYPE",
      });
    }

    const {
      data: wallet,
      error: walletError,
    } = await supabase
      .from("wallets")
      .select(
        "owner_id,wallet_type,owner_type,balance,updated_at"
      )
      .eq(
        "owner_id",
        ownerId
      )
      .eq(
        "wallet_type",
        walletType
      )
      .maybeSingle();

    if (walletError) {
      console.error(
        "[AUTODEAR][WALLET][GET_ERROR]",
        {
          ownerId,
          walletType,
          code:
            walletError.code,
          message:
            walletError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error: "WALLET_GET_ERROR",
      });
    }

    const {
      data: transactions,
      error: transactionsError,
    } = await supabase
      .from("wallet_transactions")
      .select(
        "id,owner_id,wallet_type,type,title,amount,balance_after,method,external_payment_id,created_at"
      )
      .eq(
        "owner_id",
        ownerId
      )
      .eq(
        "wallet_type",
        walletType
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(100);

    if (transactionsError) {
      console.error(
        "[AUTODEAR][WALLET][TRANSACTIONS_GET_ERROR]",
        {
          ownerId,
          walletType,
          code:
            transactionsError.code,
          message:
            transactionsError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "WALLET_TRANSACTIONS_GET_ERROR",
      });
    }

    /*
     * Если отдельного кошелька ещё нет,
     * возвращаем корректный пустой кошелёк.
     *
     * GET никогда не создаёт финансовую запись.
     * Она появится при первой реальной операции.
     */
    const result = {
      wallet: {
        ownerId,

        walletType,

        ownerType:
          wallet?.owner_type ||
          (
            walletType === "business"
              ? "business"
              : "user"
          ),

        balance:
          Number(
            wallet?.balance || 0
          ),

        updatedAt:
          wallet?.updated_at ||
          null,
      },

      transactions:
        (transactions || []).map(
          (item) => ({
            id:
              item.id,

            ownerId:
              item.owner_id,

            walletType:
              item.wallet_type,

            type:
              item.type,

            title:
              item.title,

            amount:
              Number(
                item.amount || 0
              ),

            balanceAfter:
              Number(
                item.balance_after || 0
              ),

            method:
              item.method ||
              undefined,

            externalPaymentId:
              item.external_payment_id ||
              undefined,

            createdAt:
              item.created_at,
          })
        ),
    };

    console.log(
      "[AUTODEAR][WALLET][GET_OK]",
      {
        ownerId,
        walletType,
        balance:
          result.wallet.balance,
        transactions:
          result.transactions.length,
        exists:
          Boolean(wallet),
      }
    );

    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][WALLET][GET_FATAL]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "WALLET_GET_FATAL",
    });
  }
});


app.get("/api/ads/wallet/:ownerId", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const ownerId = String(
      req.params?.ownerId || ""
    ).trim();

    if (!ownerId) {
      return res.status(400).json({
        ok: false,
        error: "OWNER_ID_REQUIRED",
      });
    }

    const {
      data: wallet,
      error: walletError,
    } = await supabase
      .from("ads_wallets")
      .select(
        "owner_id,available_kopecks,reserved_kopecks,spent_kopecks,updated_at"
      )
      .eq("owner_id", ownerId)
      .maybeSingle();

    if (walletError) {
      console.error(
        "[AUTODEAR][ADS][WALLET_GET_ERROR]",
        {
          ownerId,
          code: walletError.code,
          message: walletError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error: "ADS_WALLET_GET_ERROR",
      });
    }

    const {
      data: transactions,
      error: transactionsError,
    } = await supabase
      .from("ads_wallet_transactions")
      .select(
        "id,operation_key,owner_id,type,status,amount_kopecks,campaign_id,placement_id,event_id,external_payment_id,description,created_at,confirmed_at"
      )
      .eq("owner_id", ownerId)
      .order("created_at", {
        ascending: false,
      })
      .limit(100);

    if (transactionsError) {
      console.error(
        "[AUTODEAR][ADS][WALLET_TRANSACTIONS_GET_ERROR]",
        {
          ownerId,
          code: transactionsError.code,
          message:
            transactionsError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "ADS_WALLET_TRANSACTIONS_GET_ERROR",
      });
    }

    const result = {
      wallet: {
        ownerId,

        availableKopecks:
          Number(
            wallet?.available_kopecks || 0
          ),

        reservedKopecks:
          Number(
            wallet?.reserved_kopecks || 0
          ),

        spentKopecks:
          Number(
            wallet?.spent_kopecks || 0
          ),

        updatedAt:
          wallet?.updated_at ||
          new Date().toISOString(),
      },

      transactions:
        (transactions || []).map(
          (item) => ({
            id: item.id,

            operationKey:
              item.operation_key,

            ownerId:
              item.owner_id,

            type:
              item.type,

            status:
              item.status,

            amountKopecks:
              Number(
                item.amount_kopecks || 0
              ),

            campaignId:
              item.campaign_id || undefined,

            placementId:
              item.placement_id || undefined,

            eventId:
              item.event_id || undefined,

            externalPaymentId:
              item.external_payment_id ||
              undefined,

            description:
              item.description,

            createdAt:
              item.created_at,

            confirmedAt:
              item.confirmed_at ||
              undefined,
          })
        ),
    };

    console.log(
      "[AUTODEAR][ADS][WALLET_GET_OK]",
      {
        ownerId,
        availableKopecks:
          result.wallet.availableKopecks,
        transactions:
          result.transactions.length,
      }
    );

    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][ADS][WALLET_GET_FATAL]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "ADS_WALLET_GET_FATAL",
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
