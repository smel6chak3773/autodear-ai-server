require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const multer = require("multer");

const { processMessage } = require("./assistant/brain");
const memoryStore = require("./assistant/memoryStore");
const cacheStore = require("./assistant/cacheStore");
const { diagnoseDeveloperSnapshot } = require("./developer/diagnose");

const app = express();

const stsMultipartUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

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

const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  "";

const supabaseAuth =
  supabaseUrl && supabaseAnonKey
    ? createClient(
        supabaseUrl,
        supabaseAnonKey,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        }
      )
    : null;

app.use(cors());

/*
 * Диагностика СТС ДО express.json().
 *
 * Это принципиально важно:
 * route /api/vehicle/read-sts запускается только после того,
 * как Express полностью получил и разобрал JSON body.
 *
 * Если большой base64-запрос с телефона зависнет при загрузке
 * или оборвётся раньше, route-логов мы вообще не увидим.
 */
app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    req.originalUrl?.startsWith(
      "/api/vehicle/read-sts"
    )
  ) {
    const startedAt = Date.now();

    console.log(
      "[AUTODEAR][STS_RAW][REQUEST_BEGIN]",
      {
        contentLength:
          req.headers["content-length"] || null,
        contentType:
          req.headers["content-type"] || null,
        userAgent:
          req.headers["user-agent"] || null,
      }
    );

    req.on("aborted", () => {
      console.warn(
        "[AUTODEAR][STS_RAW][REQUEST_ABORTED]",
        {
          ms: Date.now() - startedAt,
          complete: req.complete,
          readableEnded: req.readableEnded,
        }
      );
    });

    req.on("end", () => {
      console.log(
        "[AUTODEAR][STS_RAW][REQUEST_BODY_END]",
        {
          ms: Date.now() - startedAt,
          complete: req.complete,
        }
      );
    });

    res.on("finish", () => {
      console.log(
        "[AUTODEAR][STS_RAW][RESPONSE_FINISH]",
        {
          ms: Date.now() - startedAt,
          statusCode: res.statusCode,
        }
      );
    });
  }

  next();
});

app.use(express.json({ limit: "12mb" }));

async function resolveAuthenticatedUser(req) {
  const authHeader =
    String(
      req.headers?.authorization || ""
    ).trim();

  if (
    !authHeader
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return {
      user: null,
      error: "AUTH_TOKEN_REQUIRED",
    };
  }

  const accessToken =
    authHeader
      .slice(7)
      .trim();

  if (!accessToken) {
    return {
      user: null,
      error: "AUTH_TOKEN_REQUIRED",
    };
  }

  if (!supabaseAuth) {
    return {
      user: null,
      error: "AUTH_SERVICE_NOT_CONFIGURED",
    };
  }

  try {
    const {
      data,
      error,
    } = await supabaseAuth.auth.getUser(
      accessToken
    );

    if (
      error ||
      !data?.user?.id
    ) {
      console.warn(
        "[AUTODEAR][AUTH][TOKEN_INVALID]",
        {
          message:
            error?.message ||
            null,
        }
      );

      return {
        user: null,
        error: "AUTH_TOKEN_INVALID",
      };
    }

    return {
      user: data.user,
      error: null,
    };
  } catch (error) {
    console.warn(
      "[AUTODEAR][AUTH][TOKEN_ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );

    return {
      user: null,
      error: "AUTH_TOKEN_INVALID",
    };
  }
}

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

app.get("/api/auth/me", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const userId =
    String(
      authResult?.user?.id || ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  return res.json({
    ok: true,
    userId,
    email:
      authResult?.user?.email ||
      null,
  });
});

app.get("/api/vehicle-reports/balance", async (req, res) => {
  try {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    const {
      data: balance,
      error,
    } = await supabase
      .from("vehicle_report_balances")
      .select(
        [
          "user_id",
          "basic_purchased",
          "basic_used",
          "basic_remaining",
          "extended_purchased",
          "extended_used",
          "extended_remaining",
          "maximum_purchased",
          "maximum_used",
          "maximum_remaining",
          "updated_at",
        ].join(",")
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error(
        "[AUTODEAR][VEHICLE_REPORT][BALANCE_ERROR]",
        {
          userId,
          code: error.code,
          message: error.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "VEHICLE_REPORT_BALANCE_ERROR",
      });
    }

    const result =
      balance || {
        user_id: userId,
        basic_purchased: 0,
        basic_used: 0,
        basic_remaining: 0,
        extended_purchased: 0,
        extended_used: 0,
        extended_remaining: 0,
        maximum_purchased: 0,
        maximum_used: 0,
        maximum_remaining: 0,
        updated_at: null,
      };

    console.log(
      "[AUTODEAR][VEHICLE_REPORT][BALANCE_OK]",
      {
        userId,
        basic:
          Number(
            result.basic_remaining || 0
          ),
        extended:
          Number(
            result.extended_remaining || 0
          ),
        maximum:
          Number(
            result.maximum_remaining || 0
          ),
      }
    );

    return res.json({
      ok: true,
      balance: {
        basic: {
          purchased:
            Number(
              result.basic_purchased || 0
            ),
          used:
            Number(
              result.basic_used || 0
            ),
          remaining:
            Number(
              result.basic_remaining || 0
            ),
        },
        extended: {
          purchased:
            Number(
              result.extended_purchased || 0
            ),
          used:
            Number(
              result.extended_used || 0
            ),
          remaining:
            Number(
              result.extended_remaining || 0
            ),
        },
        maximum: {
          purchased:
            Number(
              result.maximum_purchased || 0
            ),
          used:
            Number(
              result.maximum_used || 0
            ),
          remaining:
            Number(
              result.maximum_remaining || 0
            ),
        },
      },
      updatedAt:
        result.updated_at || null,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][VEHICLE_REPORT][BALANCE_UNKNOWN_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "VEHICLE_REPORT_BALANCE_UNKNOWN_ERROR",
    });
  }
});

app.get("/api/vehicle-reports/products", async (req, res) => {
  try {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    const {
      data,
      error,
    } = await supabase
      .from("vehicle_report_products")
      .select(
        "id,report_type,quantity,unit_price_kopecks,total_price_kopecks,sort_order"
      )
      .eq("is_active", true)
      .order("report_type", {
        ascending: true,
      })
      .order("sort_order", {
        ascending: true,
      })
      .order("quantity", {
        ascending: true,
      });

    if (error) {
      console.error(
        "[AUTODEAR][VEHICLE_REPORT][PRODUCTS_ERROR]",
        {
          userId,
          code: error.code,
          message: error.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "VEHICLE_REPORT_PRODUCTS_ERROR",
      });
    }

    const products =
      Array.isArray(data)
        ? data.map((item) => ({
            id: item.id,
            reportType:
              item.report_type,
            quantity:
              Number(
                item.quantity || 0
              ),
            unitPriceKopecks:
              Number(
                item.unit_price_kopecks || 0
              ),
            totalPriceKopecks:
              Number(
                item.total_price_kopecks || 0
              ),
          }))
        : [];

    console.log(
      "[AUTODEAR][VEHICLE_REPORT][PRODUCTS_OK]",
      {
        userId,
        count:
          products.length,
      }
    );

    return res.json({
      ok: true,
      products,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][VEHICLE_REPORT][PRODUCTS_UNKNOWN_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "VEHICLE_REPORT_PRODUCTS_UNKNOWN_ERROR",
    });
  }
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

/*
 * Временный диагностический endpoint.
 *
 * Принимает ТОЧНО такое же тело, как настоящее
 * распознавание СТС, но не обращается к OpenAI.
 *
 * Нужен, чтобы отделить:
 * iPhone -> AUTODEAR API upload
 * от
 * AUTODEAR API -> OpenAI Vision.
 */
/*
 * Выдаёт одноразовый signed upload token для временного СТС.
 *
 * Файл остаётся в приватном bucket ai-temp.
 * Телефону не требуется Supabase Auth-сессия для самого upload.
 */
app.post("/api/vehicle/sts-upload-url", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const userId = String(
      req.body?.userId || ""
    ).trim();

    if (
      !userId ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(userId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_USER_ID",
      });
    }

    const storageBucket = "ai-temp";

    const storagePath =
      `${userId}/sts/sts-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.jpg`;

    const {
      data,
      error,
    } = await supabase.storage
      .from(storageBucket)
      .createSignedUploadUrl(
        storagePath
      );

    if (
      error ||
      !data?.token
    ) {
      console.error(
        "[AUTODEAR][STS_SIGNED_UPLOAD][CREATE_ERROR]",
        error?.message ||
          "SIGNED_UPLOAD_TOKEN_MISSING"
      );

      return res.status(502).json({
        ok: false,
        error:
          "STS_SIGNED_UPLOAD_CREATE_FAILED",
        details:
          error?.message ||
          "SIGNED_UPLOAD_TOKEN_MISSING",
      });
    }

    console.log(
      "[AUTODEAR][STS_SIGNED_UPLOAD][CREATED]",
      {
        userId,
        storageBucket,
        storagePath,
      }
    );

    return res.json({
      ok: true,
      storageBucket,
      storagePath,
      token: data.token,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][STS_SIGNED_UPLOAD][ERROR]",
      error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error:
        "STS_SIGNED_UPLOAD_CREATE_FAILED",
    });
  }
});

app.post("/api/vehicle/read-sts-upload-probe", (req, res) => {
  const startedAt = Date.now();

  const imageBase64 = String(
    req.body?.imageBase64 ||
    req.body?.base64 ||
    ""
  ).trim();

  const mimeType = String(
    req.body?.mimeType ||
    ""
  ).trim();

  console.log(
    "[AUTODEAR][STS_UPLOAD_PROBE][OK]",
    {
      base64Chars: imageBase64.length,
      approxBytes: Math.round(
        imageBase64.length * 0.75
      ),
      mimeType,
      ms: Date.now() - startedAt,
    }
  );

  return res.json({
    ok: true,
    received: true,
    base64Chars: imageBase64.length,
    approxBytes: Math.round(
      imageBase64.length * 0.75
    ),
    mimeType,
  });
});

const parseStsMultipartIfNeeded = (
  req,
  res,
  next
) => {
  const contentType = String(
    req.headers["content-type"] || ""
  ).toLowerCase();

  if (
    !contentType.startsWith(
      "multipart/form-data"
    )
  ) {
    return next();
  }

  return stsMultipartUpload.single(
    "image"
  )(req, res, next);
};

app.post(
  "/api/vehicle/read-sts",
  parseStsMultipartIfNeeded,
  async (req, res) => {
  const stsStartedAt = Date.now();

  const stsLog = (stage, extra = {}) => {
    console.log(
      `[AUTODEAR][STS_SERVER][${stage}]`,
      {
        ms: Date.now() - stsStartedAt,
        ...extra,
      }
    );
  };

  try {
    stsLog("REQUEST_RECEIVED", {
      contentLength:
        req.headers["content-length"] || null,
    });

    if (!openai) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY_NOT_CONFIGURED",
      });
    }

    const multipartFile =
      req.file || null;

    stsLog("BODY_DEBUG", {
      bodyType: typeof req.body,
      bodyKeys:
        req.body && typeof req.body === "object"
          ? Object.keys(req.body)
          : [],
      storageBucket:
        req.body?.storageBucket || null,
      storagePath:
        req.body?.storagePath || null,
      mimeType:
        req.body?.mimeType || null,
      hasImageBase64:
        Boolean(
          req.body?.imageBase64 ||
          req.body?.base64
        ),
    });

    const storageBucket = String(
      req.body?.storageBucket || ""
    ).trim();

    const storagePath = String(
      req.body?.storagePath || ""
    ).trim();

    let imageBase64 = multipartFile
      ? multipartFile.buffer.toString(
          "base64"
        )
      : String(
          req.body?.imageBase64 ||
          req.body?.base64 ||
          ""
        ).trim();

    let mimeType = multipartFile
      ? String(
          multipartFile.mimetype ||
          "image/jpeg"
        ).trim()
      : String(
          req.body?.mimeType ||
          "image/jpeg"
        ).trim();

    let storageDownloadedBytes = null;

    if (
      !imageBase64 &&
      storageBucket &&
      storagePath
    ) {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      if (storageBucket !== "ai-temp") {
        return res.status(400).json({
          ok: false,
          error:
            "STS_STORAGE_BUCKET_INVALID",
        });
      }

      if (
        storagePath.includes("..") ||
        storagePath.startsWith("/") ||
        !storagePath.endsWith(".jpg")
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "STS_STORAGE_PATH_INVALID",
        });
      }

      stsLog("STORAGE_DOWNLOAD_BEGIN", {
        storageBucket,
        storagePath,
      });

      const {
        data: storageFile,
        error: storageDownloadError,
      } = await supabase.storage
        .from(storageBucket)
        .download(storagePath);

      if (
        storageDownloadError ||
        !storageFile
      ) {
        stsLog("STORAGE_DOWNLOAD_FAILED", {
          storageBucket,
          storagePath,
          error:
            storageDownloadError?.message ||
            "FILE_MISSING",
        });

        return res.status(502).json({
          ok: false,
          error:
            "STS_STORAGE_DOWNLOAD_FAILED",
          details:
            storageDownloadError?.message ||
            "FILE_MISSING",
        });
      }

      const storageArrayBuffer =
        await storageFile.arrayBuffer();

      const storageBuffer =
        Buffer.from(storageArrayBuffer);

      storageDownloadedBytes =
        storageBuffer.length;

      imageBase64 =
        storageBuffer.toString("base64");

      mimeType =
        storageFile.type ||
        "image/jpeg";

      stsLog("STORAGE_DOWNLOAD_OK", {
        storageBucket,
        storagePath,
        bytes:
          storageDownloadedBytes,
        mimeType,
      });
    }

    const transport = multipartFile
      ? "multipart"
      : storageBucket && storagePath
        ? "supabase_storage"
        : "json_base64";

    stsLog("INPUT_READY", {
      transport,
      fileBytes:
        multipartFile?.size ||
        storageDownloadedBytes ||
        null,
      mimeType,
      storageBucket:
        transport === "supabase_storage"
          ? storageBucket
          : null,
      storagePath:
        transport === "supabase_storage"
          ? storagePath
          : null,
    });

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

    stsLog("IMAGE_READY", {
      mimeType,
      base64Chars: imageBase64.length,
      approxBytes: Math.round(
        imageBase64.length * 0.75
      ),
    });

    const dataUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:${mimeType};base64,${imageBase64}`;

    stsLog("OPENAI_BEGIN", {
      model:
        process.env.OPENAI_STS_MODEL ||
        "gpt-4o-mini",
    });

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
              detail: "low",
            },
          ],
        },
      ],

      max_output_tokens: 1200,
    });

    stsLog("OPENAI_DONE", {
      responseId: response?.id || null,
    });

    const rawText = String(
      response.output_text ||
      ""
    );

    stsLog("OUTPUT_RECEIVED", {
      outputChars: rawText.length,
    });

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

    stsLog("RESPONSE_SENT", {
      ok: true,
      confidence:
        parsed?.confidence || "medium",
    });

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
    stsLog("ERROR", {
      message:
        error?.message ||
        String(error),
      name:
        error?.name || null,
    });

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
  let vehicleCheckJobId = null;
  let vehicleCheckRequestId = "";
  let vehicleCheckAuthenticatedUserId = "";

  try {
    const authResult =
      await resolveAuthenticatedUser(req);

    const authenticatedUserId =
      String(
        authResult?.user?.id || ""
      ).trim();

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][AUTH]",
      {
        authenticated:
          Boolean(authenticatedUserId),
        userId:
          authenticatedUserId ||
          null,
        authError:
          authResult?.error ||
          null,
      }
    );

    if (!authenticatedUserId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    const token = process.env.AVTOVINCODE_TOKEN || "";
    const mode = String(req.body.mode || "").trim();

    const requestId =
      String(
        req.body.requestId || ""
      ).trim();

    vehicleCheckRequestId =
      requestId;

    vehicleCheckAuthenticatedUserId =
      authenticatedUserId;

    const reportType =
      String(
        req.body.reportType || "basic"
      )
        .trim()
        .toLowerCase();

    if (
      ![
        "basic",
        "extended",
        "maximum",
      ].includes(reportType)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_VEHICLE_REPORT_TYPE",
      });
    }

    const hasExtendedReport =
      reportType === "extended" ||
      reportType === "maximum";

    const hasMaximumReport =
      reportType === "maximum";

    if (!requestId) {
      return res.status(400).json({
        ok: false,
        error:
          "VEHICLE_CHECK_REQUEST_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    const inputVin =
      String(
        req.body.vin || ""
      )
        .trim()
        .toUpperCase();

    const plate =
      String(
        req.body.plate ||
          req.body.gosnomer ||
          ""
      )
        .trim()
        .toUpperCase();

    /*
     * requestId делает запуск проверки
     * идемпотентным.
     *
     * Если приложение потеряет интернет,
     * закроется или повторит тот же запрос,
     * второй job для этой проверки
     * создавать нельзя.
     */
    const {
      data: existingJob,
      error: existingJobError,
    } = await supabase
      .from("vehicle_check_jobs")
      .select(
        [
          "id",
          "request_id",
          "user_id",
          "report_type",
          "mode",
          "vin",
          "plate",
          "status",
          "report_id",
          "error_code",
          "error_message",
          "created_at",
          "started_at",
          "completed_at",
          "updated_at",
        ].join(",")
      )
      .eq("request_id", requestId)
      .maybeSingle();

    if (existingJobError) {
      console.error(
        "[AUTODEAR][VEHICLE_CHECK][JOB_LOOKUP_ERROR]",
        {
          requestId,
          userId:
            authenticatedUserId,
          code:
            existingJobError.code,
          message:
            existingJobError.message,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "VEHICLE_CHECK_JOB_LOOKUP_ERROR",
      });
    }

    if (existingJob) {
      if (
        String(existingJob.user_id) !==
        authenticatedUserId
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "VEHICLE_CHECK_REQUEST_ID_OWNER_MISMATCH",
        });
      }

      if (
        existingJob.report_type !==
          reportType ||
        existingJob.mode !== mode
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "VEHICLE_CHECK_REQUEST_ID_MISMATCH",
        });
      }

      console.log(
        "[AUTODEAR][VEHICLE_CHECK][JOB_REUSED]",
        {
          requestId,
          jobId:
            existingJob.id,
          status:
            existingJob.status,
          reportId:
            existingJob.report_id ||
            null,
        }
      );

      /*
       * Готовая проверка уже существует.
       * Позже здесь будем возвращать
       * сам сохранённый отчёт.
       */
      if (
        existingJob.status ===
          "completed" &&
        existingJob.report_id
      ) {
        const {
          data: existingReport,
          error: existingReportError,
        } = await supabase
          .from("vehicle_check_reports")
          .select("*")
          .eq(
            "id",
            existingJob.report_id
          )
          .eq(
            "user_id",
            authenticatedUserId
          )
          .maybeSingle();

        if (
          existingReportError ||
          !existingReport
        ) {
          console.error(
            "[AUTODEAR][VEHICLE_CHECK][REPORT_RESTORE_ERROR]",
            {
              requestId,
              reportId:
                existingJob.report_id,
              code:
                existingReportError?.code ||
                null,
              message:
                existingReportError?.message ||
                null,
            }
          );

          return res.status(500).json({
            ok: false,
            error:
              "VEHICLE_CHECK_REPORT_RESTORE_ERROR",
          });
        }

        return res.json({
          ok: true,
          restored: true,
          requestId,
          jobId:
            existingJob.id,
          reportId:
            existingReport.id,
          reportType:
            existingReport.report_type,
          vin:
            existingReport.vin,
          plate:
            existingReport.plate,
          provider:
            existingReport.provider,
          result:
            existingReport.normalized_json,
          raw:
            existingReport.raw_json,
          ai: {
            riskLevel:
              existingReport.risk_level,
            title:
              existingReport.risk_title,
            summary:
              existingReport.ai_summary,
          },
        });
      }

      /*
       * Один и тот же requestId уже
       * выполняется. Не запускаем
       * повторные платные запросы.
       */
      if (
        existingJob.status ===
          "queued" ||
        existingJob.status ===
          "processing"
      ) {
        return res.status(202).json({
          ok: true,
          pending: true,
          requestId,
          jobId:
            existingJob.id,
          status:
            existingJob.status,
        });
      }

      if (
        existingJob.status ===
        "failed"
      ) {
        return res.status(409).json({
          ok: false,
          requestId,
          jobId:
            existingJob.id,
          error:
            existingJob.error_code ||
            "VEHICLE_CHECK_JOB_FAILED",
          message:
            existingJob.error_message ||
            null,
        });
      }
    }

    const {
      data: createdJob,
      error: createJobError,
    } = await supabase
      .from("vehicle_check_jobs")
      .insert({
        request_id:
          requestId,
        user_id:
          authenticatedUserId,
        report_type:
          reportType,
        mode,
        vin:
          inputVin || null,
        plate:
          plate || null,
        status:
          "processing",
        started_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .select(
        "id,request_id,status"
      )
      .single();

    if (
      createJobError ||
      !createdJob
    ) {
      /*
       * UNIQUE(request_id) защищает
       * даже от двух почти
       * одновременных запросов.
       */
      if (
        createJobError?.code ===
        "23505"
      ) {
        return res.status(202).json({
          ok: true,
          pending: true,
          requestId,
          status:
            "processing",
        });
      }

      console.error(
        "[AUTODEAR][VEHICLE_CHECK][JOB_CREATE_ERROR]",
        {
          requestId,
          userId:
            authenticatedUserId,
          code:
            createJobError?.code ||
            null,
          message:
            createJobError?.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "VEHICLE_CHECK_JOB_CREATE_ERROR",
      });
    }

    vehicleCheckJobId =
      createdJob.id;

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][JOB_CREATED]",
      {
        requestId,
        jobId:
          vehicleCheckJobId,
        userId:
          authenticatedUserId,
        reportType,
        mode,
      }
    );

    if (!token) {
      throw new Error(
        "AVTOVINCODE_TOKEN_NOT_CONFIGURED_ON_SERVER"
      );
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

      if (
        response.status === 402 ||
        json?.code === "INSUFFICIENT_BALANCE"
      ) {
        const balanceError =
          new Error(
            "VEHICLE_CHECK_PROVIDER_BALANCE_LOW"
          );

        balanceError.code =
          "VEHICLE_CHECK_PROVIDER_BALANCE_LOW";

        throw balanceError;
      }

      if (!response.ok || !json) {
        throw new Error(
          json?.error ||
          json?.code ||
          `AVTOVINCODE_HTTP_${response.status}`
        );
      }

      if (json?.success === 0) {
        throw new Error(
          json?.error ||
          json?.code ||
          "AVTOVINCODE_REQUEST_FAILED"
        );
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

        if (
          response.status === 402 ||
          json?.code === "INSUFFICIENT_BALANCE"
        ) {
          console.error(
            "[AUTODEAR][PROVIDER_BALANCE][CRITICAL]",
            {
              provider:
                "avtovincode",
              source:
                sourceName,
              status:
                response.status,
              code:
                json?.code ||
                "INSUFFICIENT_BALANCE",
            }
          );

          return {
            success: 0,
            unavailable: true,
            providerBalanceLow: true,
            httpStatus:
              response.status,
            code:
              json?.code ||
              "INSUFFICIENT_BALANCE",
            error:
              "VEHICLE_CHECK_PROVIDER_BALANCE_LOW",
          };
        }

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

    if (mode === "number") {
      if (!plate) {
        const error =
          new Error(
            "PLATE_REQUIRED"
          );

        error.code =
          "PLATE_REQUIRED";

        throw error;
      }

      numberResult = await callAvtoVinCod(`/gos2vin?plate=${encodeURIComponent(plate)}`);

      if (!numberResult?.success) {
        const error =
          new Error(
            numberResult?.error ||
              "VIN_BY_PLATE_NOT_FOUND"
          );

        error.code =
          "VIN_BY_PLATE_NOT_FOUND";

        throw error;
      }

      vin =
        numberResult?.vin ||
        numberResult?.record?.vin ||
        numberResult?.result?.vin ||
        numberResult?.result?.number2vin?.vin ||
        "";
    }

    if (!vin) {
      const error =
        new Error(
          "VIN_REQUIRED"
        );

      error.code =
        "VIN_REQUIRED";

      throw error;
    }

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][REPORT_TYPE]",
      {
        userId:
          authenticatedUserId,
        reportType,
        hasExtendedReport,
        hasMaximumReport,
        vin,
        plate:
          plate || null,
      }
    );

    const photoQuery =
      plate
        ? `plate=${encodeURIComponent(plate)}`
        : `vin=${encodeURIComponent(vin)}`;

    const [
      registration,
      score,
      accidents,
      mileage,
      pledge,
      elpts,
      taxi,
      sharing,
      leasing,
      photos,
    ] = await Promise.all([
      callAvtoVinCod(
        `/vin?vin=${encodeURIComponent(vin)}`
      ),

      callAvtoVinCod(
        `/score?vin=${encodeURIComponent(vin)}`
      ),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/accidents?vin=${encodeURIComponent(vin)}`,
            "accidents"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/probeg?vin=${encodeURIComponent(vin)}`,
            "mileage"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/pledge?vin=${encodeURIComponent(vin)}`,
            "pledge"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/elpts?vin=${encodeURIComponent(vin)}`,
            "elpts"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/taxi?vin=${encodeURIComponent(vin)}`,
            "taxi"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/sharing?vin=${encodeURIComponent(vin)}`,
            "sharing"
          )
        : Promise.resolve(null),

      hasExtendedReport
        ? callOptionalAvtoVinCod(
            `/lizing?vin=${encodeURIComponent(vin)}`,
            "leasing"
          )
        : Promise.resolve(null),

      hasMaximumReport
        ? callOptionalAvtoVinCod(
            `/nomerogram?${photoQuery}`,
            "photos"
          )
        : Promise.resolve(null),

    ]);

    const purchasedSources = [
      accidents,
      mileage,
      pledge,
      elpts,
      taxi,
      sharing,
      leasing,
      photos,
    ].filter(Boolean);

    const providerBalanceLow =
      purchasedSources.some(
        (source) =>
          source?.providerBalanceLow ===
          true
      );

    if (providerBalanceLow) {
      console.error(
        "[AUTODEAR][PROVIDER_BALANCE][VEHICLE_CHECK_BLOCKED]",
        {
          provider:
            "avtovincode",
          userId:
            authenticatedUserId,
          reportType,
          vin,
        }
      );

      const error =
        new Error(
          "VEHICLE_CHECK_PROVIDER_BALANCE_LOW"
        );

      error.code =
        "VEHICLE_CHECK_PROVIDER_BALANCE_LOW";

      throw error;
    }

    if (!registration?.success && !score?.success) {
      const error =
        new Error(
          registration?.error ||
            score?.error ||
            "VIN_CHECK_FAILED"
        );

      error.code =
        "VIN_CHECK_FAILED";

      throw error;
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
      reportType,
      vin,
      numberResult,
      raw: {
        registration,
        score,
        accidents,
        mileage,
        pledge,
        elpts,
        taxi,
        sharing,
        leasing,
        photos,
      },
      result: {
        gibdd: {
          vehicle: {
            vin: record.vin || vin,
            bodyNumber:
              record.bodyNumber || null,
            regNumber:
              record.regNumber ||
              plate ||
              null,
            model:
              record.model || null,
            year:
              record.year || null,
            color:
              record.color || null,

            engineVolume:
              record.engineVolume || null,
            powerHp:
              record.powerHp || null,
            powerKwt:
              record.powerKwt || null,
            engineNum:
              record.engineNum || null,
            engineType:
              record.engineType || null,

            vehicleType:
              record.vehicleType || null,
            vehicleTypeTAM:
              record.vehicleTypeTAM || null,
            category:
              record.category || null,

            ecologyClass:
              record.ecologyClass || null,
            manufacturer:
              record.manufacturer || null,

            transmissionType:
              record.transmissionType || null,
            driveUnitType:
              record.driveUnitType || null,
            wheelLocation:
              record.wheelLocation || null,

            approval:
              record.approval || null,

            maxWeight:
              record.maxWeight || null,
            weightWithoutLoading:
              record.weightWithoutLoading ||
              null,

            recordStatus:
              record.recordStatus || null,
            utilizStatus:
              record.utilizStatus || null,
            lastRegAction:
              record.lastRegAction || null,
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

        mileage:
          hasExtendedReport && mileage
            ? {
                available:
                  mileage?.success === 1,
                found:
                  Number(
                    mileage?.found || 0
                  ),
                count:
                  Array.isArray(
                    mileage?.records
                  )
                    ? mileage.records.length
                    : Number(
                        mileage?.found || 0
                      ),
                items:
                  Array.isArray(
                    mileage?.records
                  )
                    ? mileage.records
                    : [],
              }
            : null,

        pledge:
          hasExtendedReport && pledge
            ? {
                available:
                  pledge?.success === 1,
                found:
                  Number(
                    pledge?.found || 0
                  ),
                pledged:
                  Number(
                    pledge?.found || 0
                  ) > 0,
                items:
                  Array.isArray(
                    pledge?.records
                  )
                    ? pledge.records
                    : [],
              }
            : null,

        elpts:
          hasExtendedReport && elpts
            ? {
                available:
                  elpts?.success === 1,
                found:
                  Number(
                    elpts?.found || 0
                  ),
                status:
                  elpts?.status || null,
                items:
                  Array.isArray(
                    elpts?.records
                  )
                    ? elpts.records
                    : [],
              }
            : null,

        taxi:
          hasExtendedReport && taxi
            ? {
                available:
                  taxi?.success === 1,
                found:
                  Number(
                    taxi?.found || 0
                  ),
                isTaxi:
                  Boolean(
                    taxi?.isTaxi
                  ),
                items:
                  Array.isArray(
                    taxi?.records
                  )
                    ? taxi.records
                    : [],
              }
            : null,

        sharing:
          hasExtendedReport && sharing
            ? {
                available:
                  sharing?.success === 1,
                found:
                  Number(
                    sharing?.found || 0
                  ),
                isCarsharing:
                  Boolean(
                    sharing?.isCarsharing
                  ),
                company:
                  sharing?.company || null,
                archival:
                  Boolean(
                    sharing?.archival
                  ) ||
                  String(
                    sharing?.dataNote || ""
                  )
                    .toLowerCase()
                    .includes("архив"),
                dataNote:
                  sharing?.dataNote || null,
                checkedAt:
                  sharing?.checkedAt || null,
                checkedBy:
                  sharing?.checkedBy || null,
                items:
                  Array.isArray(
                    sharing?.records
                  )
                    ? sharing.records
                    : [],
              }
            : null,

        leasing:
          hasExtendedReport && leasing
            ? {
                available:
                  leasing?.success === 1,
                found:
                  Number(
                    leasing?.found || 0
                  ),
                isLeasing:
                  Boolean(
                    leasing?.isLeasing
                  ),
                items:
                  Array.isArray(
                    leasing?.records
                  )
                    ? leasing.records
                    : [],
              }
            : null,

        photos:
          hasMaximumReport && photos
            ? {
                available:
                  photos?.success === 1,
                found:
                  Number(
                    photos?.totalPhotos ??
                    photos?.found ??
                    0
                  ),
                count:
                  Array.isArray(
                    photos?.photos
                  )
                    ? photos.photos.length
                    : Number(
                        photos?.totalPhotos ??
                        photos?.found ??
                        0
                      ),
                regNumber:
                  photos?.regNumber ||
                  plate ||
                  null,
                items:
                  Array.isArray(
                    photos?.photos
                  )
                    ? photos.photos
                    : Array.isArray(
                        photos?.records
                      )
                      ? photos.records
                      : Array.isArray(
                          photos?.items
                        )
                        ? photos.items
                        : [],
              }
            : null,

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

    /*
     * Сначала сохраняем готовый отчёт на сервере.
     *
     * Это принципиально важно:
     * результат проверки не зависит от того,
     * дождалось ли приложение HTTP-ответа.
     */
    const {
      data: savedReport,
      error: savedReportError,
    } = await supabase
      .from("vehicle_check_reports")
      .insert({
        user_id:
          authenticatedUserId,
        vin:
          record.vin ||
          vin ||
          null,
        plate:
          record.regNumber ||
          plate ||
          null,
        provider:
          "avtovincode",
        price:
          0,
        status:
          "success",
        report_type:
          reportType,
        report_version:
          1,
        risk_level:
          finalReport?.ai?.riskLevel ||
          null,
        risk_title:
          finalReport?.ai?.title ||
          null,
        ai_summary:
          finalReport?.ai?.summary ||
          null,
        normalized_json:
          finalReport?.result ||
          {},
        raw_json:
          finalReport?.raw ||
          {},
        completed_at:
          new Date().toISOString(),
      })
      .select("*")
      .single();

    if (
      savedReportError ||
      !savedReport
    ) {
      console.error(
        "[AUTODEAR][VEHICLE_CHECK][REPORT_SAVE_ERROR]",
        {
          requestId,
          jobId:
            vehicleCheckJobId,
          userId:
            authenticatedUserId,
          reportType,
          code:
            savedReportError?.code ||
            null,
          message:
            savedReportError?.message ||
            null,
        }
      );

      throw new Error(
        "VEHICLE_CHECK_REPORT_SAVE_ERROR"
      );
    }

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][REPORT_SAVED]",
      {
        requestId,
        jobId:
          vehicleCheckJobId,
        reportId:
          savedReport.id,
        userId:
          authenticatedUserId,
        reportType,
      }
    );

    /*
     * Списываем ровно одну проверку.
     *
     * RPC уже идемпотентна:
     * operation_key = consume:<report_id>.
     */
    const {
      data: consumeResult,
      error: consumeError,
    } = await supabase.rpc(
      "autodear_consume_vehicle_report",
      {
        p_user_id:
          authenticatedUserId,
        p_report_type:
          reportType,
        p_report_id:
          savedReport.id,
      }
    );

    if (consumeError) {
      console.error(
        "[AUTODEAR][VEHICLE_CHECK][CONSUME_ERROR]",
        {
          requestId,
          jobId:
            vehicleCheckJobId,
          reportId:
            savedReport.id,
          userId:
            authenticatedUserId,
          reportType,
          code:
            consumeError.code ||
            null,
          message:
            consumeError.message ||
            null,
        }
      );

      throw new Error(
        consumeError.message ||
          "VEHICLE_REPORT_CONSUME_ERROR"
      );
    }

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][CONSUMED]",
      {
        requestId,
        jobId:
          vehicleCheckJobId,
        reportId:
          savedReport.id,
        reportType,
        result:
          consumeResult ||
          null,
      }
    );

    /*
     * Только после сохранения отчёта
     * и успешного списания кредита
     * проверка считается завершённой.
     */
    const {
      error: completeJobError,
    } = await supabase
      .from("vehicle_check_jobs")
      .update({
        status:
          "completed",
        report_id:
          savedReport.id,
        completed_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
        error_code:
          null,
        error_message:
          null,
      })
      .eq(
        "id",
        vehicleCheckJobId
      )
      .eq(
        "user_id",
        authenticatedUserId
      );

    if (completeJobError) {
      console.error(
        "[AUTODEAR][VEHICLE_CHECK][JOB_COMPLETE_ERROR]",
        {
          requestId,
          jobId:
            vehicleCheckJobId,
          reportId:
            savedReport.id,
          code:
            completeJobError.code ||
            null,
          message:
            completeJobError.message ||
            null,
        }
      );

      throw new Error(
        "VEHICLE_CHECK_JOB_COMPLETE_ERROR"
      );
    }

    console.log(
      "[AUTODEAR][VEHICLE_CHECK][JOB_COMPLETED]",
      {
        requestId,
        jobId:
          vehicleCheckJobId,
        reportId:
          savedReport.id,
        reportType,
      }
    );

    const responseReport = {
      ...finalReport,
      requestId,
      jobId:
        vehicleCheckJobId,
      reportId:
        savedReport.id,
      saved:
        true,
    };

    return res.json(
      responseReport
    );
  } catch (error) {
    console.error(
      "[AUTODEAR][VEHICLE_CHECK] error:",
      error
    );

    const vehicleCheckErrorCode =
      String(
        error?.code ||
        error?.message ||
        "VEHICLE_CHECK_UNKNOWN_ERROR"
      ).slice(0, 500);

    const vehicleCheckErrorMessage =
      String(
        error?.message ||
        error ||
        "Неизвестная ошибка проверки автомобиля"
      ).slice(0, 2000);

    if (
      vehicleCheckJobId &&
      supabase
    ) {
      try {
        const {
          error: failJobError,
        } = await supabase
          .from("vehicle_check_jobs")
          .update({
            status: "failed",
            error_code:
              vehicleCheckErrorCode,
            error_message:
              vehicleCheckErrorMessage,
            completed_at:
              new Date().toISOString(),
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            vehicleCheckJobId
          )
          .eq(
            "status",
            "processing"
          );

        if (failJobError) {
          console.error(
            "[AUTODEAR][VEHICLE_CHECK][JOB_FAIL_UPDATE_ERROR]",
            {
              requestId:
                vehicleCheckRequestId ||
                null,
              jobId:
                vehicleCheckJobId,
              userId:
                vehicleCheckAuthenticatedUserId ||
                null,
              code:
                failJobError.code ||
                null,
              message:
                failJobError.message ||
                null,
            }
          );
        } else {
          console.log(
            "[AUTODEAR][VEHICLE_CHECK][JOB_FAILED]",
            {
              requestId:
                vehicleCheckRequestId ||
                null,
              jobId:
                vehicleCheckJobId,
              userId:
                vehicleCheckAuthenticatedUserId ||
                null,
              errorCode:
                vehicleCheckErrorCode,
            }
          );
        }
      } catch (failJobException) {
        console.error(
          "[AUTODEAR][VEHICLE_CHECK][JOB_FAIL_EXCEPTION]",
          failJobException
        );
      }
    }

    if (
      error?.code ===
        "VEHICLE_CHECK_PROVIDER_BALANCE_LOW" ||
      error?.message ===
        "VEHICLE_CHECK_PROVIDER_BALANCE_LOW"
    ) {
      console.error(
        "[AUTODEAR][PROVIDER_BALANCE][VEHICLE_CHECK_BLOCKED]",
        {
          provider:
            "avtovincode",
        }
      );

      return res.status(503).json({
        ok: false,
        error:
          "VEHICLE_CHECK_PROVIDER_BALANCE_LOW",
      });
    }

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "VEHICLE_CHECK_UNKNOWN_ERROR",
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

    let amountKopecks = Number(
      req.body?.amountKopecks
    );

    const allowedPurposes = [
      "wallet_topup",
      "ads_wallet_topup",
      "vehicle_report_package",
    ];

    if (
      !allowedPurposes.includes(purpose) ||
      !targetId
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PAYMENT_REQUEST",
      });
    }

    let vehicleReportOrder = null;

    if (purpose === "ads_wallet_topup") {
      const adsUser =
        await requireAdsAuthUser(req);

      if (
        String(adsUser.id) !==
        targetId
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "ADS_WALLET_TOPUP_FORBIDDEN",
        });
      }
    }

    if (purpose === "vehicle_report_package") {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: "SUPABASE_NOT_CONFIGURED",
        });
      }

      const reportType = String(
        req.body?.reportType || ""
      )
        .trim()
        .toLowerCase();

      const quantity = Number(
        req.body?.quantity
      );

      if (
        ![
          "basic",
          "extended",
          "maximum",
        ].includes(reportType) ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_VEHICLE_REPORT_PACKAGE",
        });
      }

      const {
        data: product,
        error: productError,
      } = await supabase
        .from("vehicle_report_products")
        .select(
          "id,report_type,quantity,unit_price_kopecks,total_price_kopecks,is_active"
        )
        .eq("report_type", reportType)
        .eq("quantity", quantity)
        .eq("is_active", true)
        .maybeSingle();

      if (productError) {
        console.error(
          "[AUTODEAR][VEHICLE_REPORT][PRODUCT_ERROR]",
          {
            reportType,
            quantity,
            code: productError.code,
            message: productError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "VEHICLE_REPORT_PRODUCT_ERROR",
        });
      }

      if (!product) {
        return res.status(404).json({
          ok: false,
          error:
            "VEHICLE_REPORT_PRODUCT_NOT_FOUND",
        });
      }

      amountKopecks = Number(
        product.total_price_kopecks
      );

      if (
        !Number.isInteger(amountKopecks) ||
        amountKopecks <= 0
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "INVALID_VEHICLE_REPORT_PRODUCT_PRICE",
        });
      }

      const {
        data: order,
        error: orderError,
      } = await supabase
        .from("vehicle_report_orders")
        .insert({
          user_id: targetId,
          product_id: product.id,
          report_type: product.report_type,
          quantity: product.quantity,
          unit_price_kopecks:
            Number(
              product.unit_price_kopecks
            ),
          total_price_kopecks:
            amountKopecks,
          status: "pending",
        })
        .select(
          "id,user_id,product_id,report_type,quantity,unit_price_kopecks,total_price_kopecks,status"
        )
        .single();

      if (orderError || !order) {
        console.error(
          "[AUTODEAR][VEHICLE_REPORT][ORDER_CREATE_ERROR]",
          {
            targetId,
            reportType,
            quantity,
            code:
              orderError?.code || null,
            message:
              orderError?.message || null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "VEHICLE_REPORT_ORDER_CREATE_ERROR",
        });
      }

      vehicleReportOrder = order;

      console.log(
        "[AUTODEAR][VEHICLE_REPORT][ORDER_CREATED]",
        {
          orderId: order.id,
          userId: targetId,
          reportType:
            order.report_type,
          quantity:
            order.quantity,
          amountKopecks,
        }
      );
    } else {
      const minimumAmountKopecks =
        purpose === "ads_wallet_topup"
          ? 50000
          : 10000;

      if (
        !Number.isInteger(amountKopecks) ||
        amountKopecks < minimumAmountKopecks
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PAYMENT_REQUEST",
        });
      }
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
        : purpose ===
          "vehicle_report_package"
        ? "vehicle_report"
        : requestedWalletType === "business"
        ? "business"
        : "personal";

    const paymentTargetId =
      purpose ===
        "vehicle_report_package"
        ? vehicleReportOrder?.id
        : targetId;

    if (!paymentTargetId) {
      return res.status(500).json({
        ok: false,
        error:
          "PAYMENT_TARGET_ID_NOT_RESOLVED",
      });
    }

    const paymentRecord = {
      provider: "ckassa",
      purpose,
      target_id: paymentTargetId,
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

    if (
      purpose ===
        "vehicle_report_package" &&
      vehicleReportOrder
    ) {
      const {
        error: orderPaymentError,
      } = await supabase
        .from("vehicle_report_orders")
        .update({
          ckassa_payment_id:
            storedPayment.id,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          vehicleReportOrder.id
        )
        .eq(
          "user_id",
          targetId
        );

      if (orderPaymentError) {
        console.error(
          "[AUTODEAR][VEHICLE_REPORT][ORDER_PAYMENT_LINK_ERROR]",
          {
            orderId:
              vehicleReportOrder.id,
            paymentId:
              storedPayment.id,
            code:
              orderPaymentError.code,
            message:
              orderPaymentError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "VEHICLE_REPORT_ORDER_PAYMENT_LINK_ERROR",
        });
      }

      console.log(
        "[AUTODEAR][VEHICLE_REPORT][ORDER_PAYMENT_LINKED]",
        {
          orderId:
            vehicleReportOrder.id,
          paymentId:
            storedPayment.id,
        }
      );
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
      orderId:
        vehicleReportOrder?.id || null,
      amountKopecks,
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

    const creditRpcName =
      payment.purpose ===
        "vehicle_report_package"
        ? "autodear_credit_vehicle_report_ckassa_payment"
        : "autodear_credit_ckassa_payment";

    console.log(
      "[AUTODEAR][CKASSA][CREDIT_ROUTE]",
      {
        paymentId:
          payment.id,
        purpose:
          payment.purpose,
        rpc:
          creditRpcName,
      }
    );

    const {
      data: creditResult,
      error: creditError,
    } = await supabase.rpc(
      creditRpcName,
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
        data: routingPayment,
        error: routingPaymentError,
      } = await supabase
        .from("ckassa_payments")
        .select(
          "purpose,target_id"
        )
        .eq(
          "id",
          localPayment.id
        )
        .single();

      if (
        routingPaymentError ||
        !routingPayment
      ) {
        summary.errors += 1;

        console.error(
          "[AUTODEAR][CKASSA][SYNC_NEW_ROUTING_ERROR]",
          {
            paymentId:
              localPayment.id,
            code:
              routingPaymentError?.code ||
              null,
            message:
              routingPaymentError?.message ||
              "PAYMENT_ROUTING_NOT_FOUND",
          }
        );

        continue;
      }

      const syncCreditRpcName =
        routingPayment.purpose ===
          "vehicle_report_package"
          ? "autodear_credit_vehicle_report_ckassa_payment"
          : "autodear_credit_ckassa_payment";

      console.log(
        "[AUTODEAR][CKASSA][SYNC_NEW_CREDIT_ROUTE]",
        {
          paymentId:
            localPayment.id,
          purpose:
            routingPayment.purpose,
          targetId:
            routingPayment.target_id,
          rpc:
            syncCreditRpcName,
        }
      );

      const {
        data: creditResult,
        error: creditError,
      } = await supabase.rpc(
        syncCreditRpcName,
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

    const user =
      await requireAdsAuthUser(req);

    const ownerId = String(
      req.params?.ownerId || ""
    ).trim();

    if (!ownerId) {
      return res.status(400).json({
        ok: false,
        error: "OWNER_ID_REQUIRED",
      });
    }

    if (
      String(user.id) !== ownerId
    ) {
      return res.status(403).json({
        ok: false,
        error: "ADS_WALLET_FORBIDDEN",
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
    const status =
      Number(
        error?.statusCode || 500
      );

    console.error(
      "[AUTODEAR][ADS][WALLET_GET_FATAL]",
      error
    );

    return res.status(status).json({
      ok: false,
      error:
        error?.message ||
        "ADS_WALLET_GET_FATAL",
    });
  }
});





// ============================================================
// AUTODEAR ADS — SERVER CAMPAIGNS
//
// Supabase is the source of truth.
// Browser and mobile app use the same authenticated owner.
// AsyncStorage may remain only as a mobile cache.
// ============================================================

async function requireAdsAuthUser(req) {
  if (!supabaseAuth) {
    const error = new Error(
      "SUPABASE_AUTH_NOT_CONFIGURED"
    );
    error.statusCode = 500;
    throw error;
  }

  const authorization = String(
    req.headers?.authorization || ""
  ).trim();

  const match =
    authorization.match(/^Bearer\s+(.+)$/i);

  const token =
    match?.[1]
      ? String(match[1]).trim()
      : "";

  if (!token) {
    const error = new Error(
      "ADS_AUTH_REQUIRED"
    );
    error.statusCode = 401;
    throw error;
  }

  const {
    data,
    error: authError,
  } = await supabaseAuth.auth.getUser(token);

  if (
    authError ||
    !data?.user?.id
  ) {
    const error = new Error(
      "ADS_AUTH_INVALID"
    );
    error.statusCode = 401;
    throw error;
  }

  return data.user;
}


function normalizeAdsInteger(value) {
  const number = Number(value || 0);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return 0;
  }

  return Math.round(number);
}


function normalizeAdsStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((item) =>
          String(item || "").trim()
        )
        .filter(Boolean)
    ),
  ];
}


function mapAdsPlacementRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,

    format: row.format,
    title: row.title || "",
    status: row.status,

    billingModel:
      row.billing_model || "cpc",

    pricePerClickKopecks:
      Number(
        row.price_per_click_kopecks || 0
      ),

    pricePerThousandImpressionsKopecks:
      Number(
        row
          .price_per_thousand_impressions_kopecks ||
        0
      ),

    pricePerViewKopecks:
      row.price_per_view_kopecks == null
        ? undefined
        : Number(
            row.price_per_view_kopecks
          ),

    billableVideoEvent:
      row.billable_video_event ||
      undefined,

    budgetLimitKopecks:
      Number(
        row.budget_limit_kopecks || 0
      ),

    dailyLimitKopecks:
      Number(
        row.daily_limit_kopecks || 0
      ),

    destinationUrl:
      row.destination_url || "",

    ctaText:
      row.cta_text || "",

    imageUri:
      row.image_uri || null,

    videoUri:
      row.video_uri || null,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}


function mapAdsCampaignRow(
  row,
  placements = []
) {
  return {
    id: row.id,
    ownerId: row.owner_id,

    name: row.name || "",
    clientName:
      row.client_name || "",

    status: row.status,

    totalBudgetKopecks:
      Number(
        row.total_budget_kopecks || 0
      ),

    dailyBudgetKopecks:
      Number(
        row.daily_budget_kopecks || 0
      ),

    startsAt:
      row.starts_at || null,

    endsAt:
      row.ends_at || null,

    cityIds:
      normalizeAdsStringArray(
        row.city_ids
      ),

    placements:
      placements.map(
        mapAdsPlacementRow
      ),

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}


async function loadAdsCampaignPlacements(
  ownerId,
  campaignIds
) {
  if (
    !Array.isArray(campaignIds) ||
    campaignIds.length === 0
  ) {
    return new Map();
  }

  const {
    data,
    error,
  } = await supabase
    .from("ads_placements")
    .select("*")
    .eq("owner_id", ownerId)
    .in("campaign_id", campaignIds)
    .order(
      "created_at",
      {
        ascending: true,
      }
    );

  if (error) {
    throw new Error(
      `ADS_PLACEMENTS_LOAD_ERROR:${error.message}`
    );
  }

  const byCampaign =
    new Map();

  for (const row of data || []) {
    const campaignId =
      String(
        row.campaign_id || ""
      );

    const current =
      byCampaign.get(campaignId) ||
      [];

    current.push(row);

    byCampaign.set(
      campaignId,
      current
    );
  }

  return byCampaign;
}


// ------------------------------------------------------------
// LIST CAMPAIGNS
// ------------------------------------------------------------

app.get(
  "/api/ads/campaigns",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const user =
        await requireAdsAuthUser(req);

      const ownerId =
        String(user.id);

      const {
        data: rows,
        error,
      } = await supabase
        .from("ads_campaigns")
        .select("*")
        .eq(
          "owner_id",
          ownerId
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        );

      if (error) {
        console.error(
          "[AUTODEAR][ADS][CAMPAIGNS_LIST_ERROR]",
          {
            ownerId,
            code: error.code,
            message:
              error.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_CAMPAIGNS_LIST_ERROR",
        });
      }

      const campaignIds =
        (rows || []).map(
          (row) => row.id
        );

      const placements =
        await loadAdsCampaignPlacements(
          ownerId,
          campaignIds
        );

      const campaigns =
        (rows || []).map(
          (row) =>
            mapAdsCampaignRow(
              row,
              placements.get(
                row.id
              ) || []
            )
        );

      return res.json({
        ok: true,
        campaigns,
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][ADS][CAMPAIGNS_LIST_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_CAMPAIGNS_LIST_FATAL",
      });
    }
  }
);


// ------------------------------------------------------------
// CREATE CAMPAIGN
// ------------------------------------------------------------

app.post(
  "/api/ads/campaigns",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const user =
        await requireAdsAuthUser(req);

      const ownerId =
        String(user.id);

      const id =
        String(
          req.body?.id || ""
        ).trim();

      if (!id) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_ID_REQUIRED",
        });
      }

      const name =
        String(
          req.body?.name || ""
        ).trim() ||
        "Новая кампания";

      const payload = {
        id,
        owner_id:
          ownerId,

        name,

        client_name:
          String(
            req.body?.clientName ||
            ""
          ).trim(),

        status:
          "draft",

        total_budget_kopecks:
          normalizeAdsInteger(
            req.body
              ?.totalBudgetKopecks
          ),

        daily_budget_kopecks:
          normalizeAdsInteger(
            req.body
              ?.dailyBudgetKopecks
          ),

        starts_at:
          req.body?.startsAt ||
          null,

        ends_at:
          req.body?.endsAt ||
          null,

        city_ids:
          normalizeAdsStringArray(
            req.body?.cityIds
          ),
      };

      const {
        data,
        error,
      } = await supabase
        .from("ads_campaigns")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        console.error(
          "[AUTODEAR][ADS][CAMPAIGN_CREATE_ERROR]",
          {
            ownerId,
            id,
            code: error.code,
            message:
              error.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            error.code === "23505"
              ? "ADS_CAMPAIGN_ALREADY_EXISTS"
              : "ADS_CAMPAIGN_CREATE_ERROR",
        });
      }

      return res.status(201).json({
        ok: true,
        campaign:
          mapAdsCampaignRow(
            data,
            []
          ),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][ADS][CAMPAIGN_CREATE_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_CAMPAIGN_CREATE_FATAL",
      });
    }
  }
);


// ------------------------------------------------------------
// UPDATE CAMPAIGN
// ------------------------------------------------------------

app.put(
  "/api/ads/campaigns/:campaignId",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const user =
        await requireAdsAuthUser(req);

      const ownerId =
        String(user.id);

      const campaignId =
        String(
          req.params?.campaignId ||
          ""
        ).trim();

      if (!campaignId) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_ID_REQUIRED",
        });
      }

      const patch = {};

      if (
        req.body?.name !==
        undefined
      ) {
        patch.name =
          String(
            req.body.name || ""
          ).trim();
      }

      if (
        req.body?.clientName !==
        undefined
      ) {
        patch.client_name =
          String(
            req.body.clientName ||
            ""
          ).trim();
      }

      if (
        req.body?.status !==
        undefined
      ) {
        const allowedStatuses =
          new Set([
            "draft",
            "moderation",
            "active",
            "paused",
            "completed",
            "rejected",
            "archived",
          ]);

        const status =
          String(
            req.body.status || ""
          );

        if (
          !allowedStatuses.has(
            status
          )
        ) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                "ADS_CAMPAIGN_STATUS_INVALID",
            });
        }

        patch.status =
          status;
      }

      if (
        req.body
          ?.totalBudgetKopecks !==
        undefined
      ) {
        patch.total_budget_kopecks =
          normalizeAdsInteger(
            req.body
              .totalBudgetKopecks
          );
      }

      if (
        req.body
          ?.dailyBudgetKopecks !==
        undefined
      ) {
        patch.daily_budget_kopecks =
          normalizeAdsInteger(
            req.body
              .dailyBudgetKopecks
          );
      }

      if (
        req.body?.startsAt !==
        undefined
      ) {
        patch.starts_at =
          req.body.startsAt ||
          null;
      }

      if (
        req.body?.endsAt !==
        undefined
      ) {
        patch.ends_at =
          req.body.endsAt ||
          null;
      }

      if (
        req.body?.cityIds !==
        undefined
      ) {
        patch.city_ids =
          normalizeAdsStringArray(
            req.body.cityIds
          );
      }

      if (
        Object.keys(patch)
          .length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_PATCH_EMPTY",
        });
      }

      const {
        data,
        error,
      } = await supabase
        .from("ads_campaigns")
        .update(patch)
        .eq(
          "id",
          campaignId
        )
        .eq(
          "owner_id",
          ownerId
        )
        .select("*")
        .maybeSingle();

      if (error) {
        console.error(
          "[AUTODEAR][ADS][CAMPAIGN_UPDATE_ERROR]",
          {
            ownerId,
            campaignId,
            code: error.code,
            message:
              error.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_UPDATE_ERROR",
        });
      }

      if (!data) {
        return res.status(404).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_NOT_FOUND",
        });
      }

      const placements =
        await loadAdsCampaignPlacements(
          ownerId,
          [campaignId]
        );

      return res.json({
        ok: true,
        campaign:
          mapAdsCampaignRow(
            data,
            placements.get(
              campaignId
            ) || []
          ),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][ADS][CAMPAIGN_UPDATE_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_CAMPAIGN_UPDATE_FATAL",
      });
    }
  }
);


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
