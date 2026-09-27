require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const multer = require("multer");
const crypto = require("crypto");

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

const adsCreativeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const businessCardPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const vehicleCheckCache = new Map();
const geocodeCache = new Map();
const routeDistanceCache = new Map();

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

/*
 * Financial / privileged Supabase client.
 *
 * IMPORTANT:
 * Never fall back to anon here.
 * Bonus spending RPC is executable only by service_role.
 */
const supabaseServiceRoleKey =
  String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

const supabaseServiceRole =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(
        supabaseUrl,
        supabaseServiceRoleKey,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        }
      )
    : null;


/*
 * AUTODEAR bonus economics.
 *
 * Deal rewards are calculated only from revenue actually earned
 * by AUTODEAR, never from the customer's gross service bill.
 *
 * These are server-side safety limits. The client must never be
 * trusted to provide or override them.
 */
const AUTODEAR_BONUS_ECONOMICS = Object.freeze({
  customerCashbackPercent: 10,
  maxDealBonusRevenuePercent: 25,
  maxDealBonus: 250,
  lifetimeDays: 365,
});

function calculateAutodearDealBonus(platformRevenue) {
  const revenue =
    Number(platformRevenue);

  if (
    !Number.isFinite(revenue) ||
    revenue <= 0
  ) {
    return 0;
  }

  const requested =
    Math.max(
      0,
      Math.round(
        revenue *
          AUTODEAR_BONUS_ECONOMICS
            .customerCashbackPercent /
          100
      )
    );

  const revenueSafetyCap =
    Math.max(
      0,
      Math.floor(
        revenue *
          AUTODEAR_BONUS_ECONOMICS
            .maxDealBonusRevenuePercent /
          100
      )
    );

  const absoluteCap =
    Math.max(
      0,
      Math.floor(
        AUTODEAR_BONUS_ECONOMICS
          .maxDealBonus
      )
    );

  return Math.min(
    requested,
    revenueSafetyCap,
    absoluteCap
  );
}

function isTransientSupabaseReadError(error) {
  const message =
    String(
      error?.message ||
      ""
    )
      .trim()
      .toLowerCase();

  return (
    message.includes(
      "gateway timeout"
    ) ||
    message.includes(
      "bad gateway"
    ) ||
    message.includes(
      "service unavailable"
    ) ||
    message.includes(
      "fetch failed"
    ) ||
    message.includes(
      "econnreset"
    ) ||
    message.includes(
      "etimedout"
    )
  );
}

async function supabaseReadWithRetry(
  operation,
  context = "unknown"
) {
  const firstResult =
    await operation();

  if (
    !firstResult?.error ||
    !isTransientSupabaseReadError(
      firstResult.error
    )
  ) {
    return firstResult;
  }

  console.warn(
    "[AUTODEAR][SUPABASE_READ_RETRY]",
    {
      context,
      attempt: 2,
      message:
        firstResult.error?.message ||
        null,
    }
  );

  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        350
      )
  );

  return operation();
}

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

/*
 * AUTODEAR Auth registration proxy.
 *
 * На реальном iPhone прямой POST к Supabase /auth/v1/signup
 * может обрываться на транспортном уровне.
 *
 * Поэтому мобильное приложение создаёт аккаунт через
 * api.autodear.ru, а сервер уже выполняет штатный
 * Supabase Auth signUp.
 *
 * ВАЖНО:
 * здесь используется supabaseAuth (anon key), а не
 * service-role admin API. Таким образом сохраняются
 * обычные правила регистрации Supabase.
 */
app.post("/api/auth/register", async (req, res) => {
  const startedAt = Date.now();

  const name =
    String(req.body?.name || "").trim();

  const email =
    String(req.body?.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(req.body?.password || "");

  const phone =
    String(req.body?.phone || "").trim();

  const role =
    String(req.body?.role || "user").trim();

  const city =
    String(req.body?.city || "").trim();

  console.log(
    "[AUTODEAR][AUTH_REGISTER][BEGIN]",
    {
      email,
      role,
      hasName: Boolean(name),
      hasPhone: Boolean(phone),
    }
  );

  if (!supabaseAuth) {
    return res.status(503).json({
      ok: false,
      error: "AUTH_SERVICE_NOT_CONFIGURED",
      message:
        "Сервис регистрации временно недоступен.",
    });
  }

  if (!email || !password || !name) {
    return res.status(400).json({
      ok: false,
      error: "AUTH_REGISTER_FIELDS_REQUIRED",
      message:
        "Заполните имя, email и пароль.",
    });
  }

  if (
    role !== "user" &&
    role !== "business"
  ) {
    return res.status(400).json({
      ok: false,
      error: "AUTH_REGISTER_ROLE_INVALID",
      message:
        "Недопустимый тип аккаунта.",
    });
  }

  try {
    const {
      data,
      error,
    } = await supabaseAuth.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          phone,
          role,
        },
      },
    });

    if (error) {
      console.warn(
        "[AUTODEAR][AUTH_REGISTER][SUPABASE_ERROR]",
        {
          email,
          status:
            error.status || null,
          message:
            error.message || null,
          ms:
            Date.now() - startedAt,
        }
      );

      const status =
        Number(error.status) >= 400 &&
        Number(error.status) < 500
          ? Number(error.status)
          : 400;

      return res.status(status).json({
        ok: false,
        error: "AUTH_REGISTER_FAILED",
        message:
          error.message ||
          "Не удалось создать аккаунт.",
      });
    }

    const user =
      data?.user || null;

    const session =
      data?.session || null;

    if (!user?.id) {
      console.warn(
        "[AUTODEAR][AUTH_REGISTER][NO_USER]",
        {
          email,
          ms:
            Date.now() - startedAt,
        }
      );

      return res.status(502).json({
        ok: false,
        error: "AUTH_REGISTER_NO_USER",
        message:
          "Supabase не вернул созданного пользователя.",
      });
    }

    /*
     * Профиль создаём на backend после успешного
     * Supabase Auth signUp.
     *
     * Это важно для мобильных клиентов:
     * успешная регистрация больше не зависит от
     * отдельного клиентского profiles.upsert.
     */
    if (!supabase) {
      console.error(
        "[AUTODEAR][AUTH_REGISTER][PROFILE_CLIENT_MISSING]",
        {
          email,
          userId: user.id,
        }
      );

      return res.status(503).json({
        ok: false,
        error: "AUTH_PROFILE_SERVICE_NOT_CONFIGURED",
        message:
          "Аккаунт создан, но не удалось создать профиль.",
      });
    }

    const {
      error: profileError,
    } = await supabase
      .from("profiles")
      .upsert(
        {
          id: user.id,
          auth_user_id: user.id,
          name,
          email,
          phone,
          role,
          city,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "id",
        }
      );

    if (profileError) {
      console.error(
        "[AUTODEAR][AUTH_REGISTER][PROFILE_ERROR]",
        {
          email,
          userId: user.id,
          code:
            profileError.code || null,
          message:
            profileError.message || null,
          ms:
            Date.now() - startedAt,
        }
      );

      return res.status(500).json({
        ok: false,
        error: "AUTH_REGISTER_PROFILE_FAILED",
        message:
          "Аккаунт создан, но не удалось создать профиль.",
      });
    }

    console.log(
      "[AUTODEAR][AUTH_REGISTER][OK]",
      {
        email,
        userId: user.id,
        hasSession:
          Boolean(session?.access_token),
        profileCreated: true,
        ms:
          Date.now() - startedAt,
      }
    );

    /*
     * Регистрационный endpoint подтверждает только
     * успешное создание аккаунта.
     *
     * Не отправляем обратно через Cloudflare/React Native
     * большой Supabase user + session payload:
     * на реальном iPhone тело успешного HTTP 200 иногда
     * обрывалось после получения заголовков.
     *
     * После 204 мобильное приложение выполняет обычный
     * signInWithPassword напрямую через Supabase.
     */
    return res.status(204).end();
  } catch (error) {
    console.error(
      "[AUTODEAR][AUTH_REGISTER][EXCEPTION]",
      {
        email,
        message:
          error?.message ||
          String(error),
        ms:
          Date.now() - startedAt,
      }
    );

    return res.status(500).json({
      ok: false,
      error: "AUTH_REGISTER_INTERNAL_ERROR",
      message:
        "Не удалось выполнить регистрацию.",
    });
  }
});

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

// ADMIN_STAFF_AUTH_V1
//
// Все опасные административные операции AUTODEAR
// должны проходить через реальный Supabase Auth token.
//
// Клиентский roleSwitcherStore НЕ является источником
// полномочий и здесь намеренно не используется.
//
async function resolveStaffAccess(
  req,
  requiredRole = "admin"
) {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const authUserId =
    String(
      authUser?.id || ""
    ).trim();

  if (!authUserId) {
    return {
      ok: false,
      status: 401,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    };
  }

  /*
   * staff_accounts доступен только service_role.
   * Не разрешаем административному API молча
   * работать через anon key.
   */
  const serviceRoleKey =
    String(
      process.env
        .SUPABASE_SERVICE_ROLE_KEY ||
      ""
    ).trim();

  if (
    !supabase ||
    !serviceRoleKey
  ) {
    console.error(
      "[AUTODEAR][ADMIN][SERVICE_ROLE_MISSING]",
      {
        authUserId,
        hasSupabase:
          Boolean(supabase),
        hasServiceRole:
          Boolean(serviceRoleKey),
      }
    );

    return {
      ok: false,
      status: 500,
      error:
        "STAFF_SERVICE_ROLE_NOT_CONFIGURED",
    };
  }

  const {
    data: staff,
    error: staffError,
  } =
    await supabase
      .from("staff_accounts")
      .select(
        [
          "auth_user_id",
          "email",
          "roles",
          "is_active",
        ].join(",")
      )
      .eq(
        "auth_user_id",
        authUserId
      )
      .maybeSingle();

  if (staffError) {
    console.error(
      "[AUTODEAR][ADMIN][STAFF_LOOKUP_ERROR]",
      {
        authUserId,
        code:
          staffError.code || null,
        message:
          staffError.message || null,
      }
    );

    return {
      ok: false,
      status: 500,
      error:
        "STAFF_LOOKUP_FAILED",
    };
  }

  if (
    !staff ||
    staff.is_active !== true
  ) {
    console.warn(
      "[AUTODEAR][ADMIN][ACCESS_DENIED]",
      {
        authUserId,
        reason:
          !staff
            ? "STAFF_NOT_FOUND"
            : "STAFF_DISABLED",
      }
    );

    return {
      ok: false,
      status: 403,
      error:
        !staff
          ? "STAFF_ACCESS_REQUIRED"
          : "STAFF_ACCOUNT_DISABLED",
    };
  }

  const roles =
    Array.isArray(
      staff.roles
    )
      ? staff.roles
          .map(
            (role) =>
              String(
                role || ""
              )
                .trim()
                .toLowerCase()
          )
          .filter(Boolean)
      : [];

  const normalizedRequiredRole =
    String(
      requiredRole || ""
    )
      .trim()
      .toLowerCase();

  if (
    normalizedRequiredRole &&
    !roles.includes(
      normalizedRequiredRole
    )
  ) {
    console.warn(
      "[AUTODEAR][ADMIN][ROLE_DENIED]",
      {
        authUserId,
        requiredRole:
          normalizedRequiredRole,
        roles,
      }
    );

    return {
      ok: false,
      status: 403,
      error:
        "STAFF_ROLE_REQUIRED",
    };
  }

  return {
    ok: true,
    status: 200,

    actor: {
      authUserId,
      email:
        String(
          staff.email ||
          authUser?.email ||
          ""
        ).trim(),
      roles,
    },
  };
}


/*
 * Безопасная read-only проверка служебной сессии.
 *
 * Нужна прежде чем подключать реальные операции
 * блокировки объявлений и аккаунтов.
 */
app.get(
  "/api/admin/me",
  async (req, res) => {
    try {
      const access =
        await resolveStaffAccess(
          req,
          "admin"
        );

      if (!access.ok) {
        return res
          .status(
            access.status || 403
          )
          .json({
            ok: false,
            error:
              access.error ||
              "STAFF_ACCESS_DENIED",
          });
      }

      return res.json({
        ok: true,

        staff: {
          authUserId:
            access.actor.authUserId,

          email:
            access.actor.email,

          roles:
            access.actor.roles,
        },
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][ADMIN][ME_ERROR]",
        {
          message:
            error?.message ||
            String(error),
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "ADMIN_SESSION_CHECK_FAILED",
        });
    }
  }
);

// ADMIN_LISTING_MODERATION_V1

const ADMIN_LISTING_ACTIONS = {
  request_changes: {
    status: "action_required",
    moderationAction:
      "request_changes",
    title:
      "Объявление требует исправления",
  },

  block: {
    status: "rejected",
    moderationAction:
      "blocked",
    title:
      "Объявление заблокировано",
  },

  remove: {
    status: "archive",
    moderationAction:
      "removed",
    title:
      "Объявление снято с публикации",
  },
};

const ADMIN_LISTING_REASON_CODES =
  new Set([
    "fraud_suspicion",
    "false_information",
    "duplicate",
    "wrong_category",
    "prohibited",
    "incorrect_price",
    "rules_violation",
    "other",
  ]);


function adminModerationUuidOrNull(
  value
) {
  const normalized =
    String(
      value || ""
    ).trim();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
  ) {
    return null;
  }

  return normalized;
}


async function resolveAdminListingOwner(
  ownerId
) {
  const normalizedOwnerId =
    String(
      ownerId || ""
    ).trim();

  if (!normalizedOwnerId) {
    return {
      ownerId: "",
      authUserId: null,
      email: "",
    };
  }

  const ownerUuid =
    adminModerationUuidOrNull(
      normalizedOwnerId
    );

  if (
    !ownerUuid ||
    !supabase
  ) {
    return {
      ownerId:
        normalizedOwnerId,
      authUserId:
        ownerUuid,
      email: "",
    };
  }

  try {
    const {
      data: profile,
      error,
    } =
      await supabase
        .from("profiles")
        .select(
          "id,auth_user_id,email"
        )
        .or(
          [
            `auth_user_id.eq.${ownerUuid}`,
            `id.eq.${ownerUuid}`,
          ].join(",")
        )
        .limit(1)
        .maybeSingle();

    if (error) {
      console.warn(
        "[AUTODEAR][ADMIN][LISTING_OWNER_PROFILE_LOOKUP]",
        {
          ownerId:
            normalizedOwnerId,
          code:
            error.code || null,
          message:
            error.message || null,
        }
      );
    }

    return {
      ownerId:
        normalizedOwnerId,

      authUserId:
        adminModerationUuidOrNull(
          profile?.auth_user_id
        ) ||
        ownerUuid,

      email:
        String(
          profile?.email || ""
        ).trim(),
    };
  } catch (error) {
    console.warn(
      "[AUTODEAR][ADMIN][LISTING_OWNER_PROFILE_FATAL]",
      {
        ownerId:
          normalizedOwnerId,
        message:
          error?.message ||
          String(error),
      }
    );

    return {
      ownerId:
        normalizedOwnerId,
      authUserId:
        ownerUuid,
      email: "",
    };
  }
}


async function sendAdminListingModerationPush({
  ownerAuthUserId,
  ownerEmail,
  listingId,
  title,
  body,
}) {
  const authId =
    String(
      ownerAuthUserId || ""
    ).trim();

  const email =
    String(
      ownerEmail || ""
    )
      .trim()
      .toLowerCase();

  if (
    !supabase ||
    (!authId && !email)
  ) {
    return {
      ok: true,
      sent: 0,
      reason:
        "RECIPIENT_NOT_RESOLVED",
    };
  }

  let query =
    supabase
      .from(
        "device_push_tokens"
      )
      .select(
        [
          "expo_push_token",
          "user_id",
          "user_email",
        ].join(",")
      )
      .eq(
        "is_active",
        true
      );

  if (
    authId &&
    email
  ) {
    query =
      query.or(
        `user_id.eq.${authId},user_email.eq.${email}`
      );
  } else if (authId) {
    query =
      query.eq(
        "user_id",
        authId
      );
  } else {
    query =
      query.eq(
        "user_email",
        email
      );
  }

  const {
    data: rows,
    error,
  } =
    await query;

  if (error) {
    throw error;
  }

  const tokens =
    Array.from(
      new Set(
        (
          Array.isArray(rows)
            ? rows
            : []
        )
          .map(
            (row) =>
              String(
                row?.expo_push_token ||
                ""
              ).trim()
          )
          .filter(Boolean)
      )
    );

  if (!tokens.length) {
    return {
      ok: true,
      sent: 0,
      reason:
        "NO_PUSH_TOKENS",
    };
  }

  return sendAutodearExpoPush({
    tokens,

    title,

    body,

    data: {
      type:
        "listing_moderation",

      eventType:
        "listing_moderation",

      category:
        "listing",

      listingId,

      relatedType:
        "listing",

      relatedId:
        listingId,

      route:
        `/listing/${encodeURIComponent(
          listingId
        )}`,
    },
  });
}



// ADMIN_COMPLAINT_EVIDENCE_V1
//
// Фото жалобы лежат в приватном Storage.
// Администратор получает только временные signed URL
// после реальной server-side проверки staff access.

app.get(
  "/api/admin/moderation/complaints/:complaintId/attachments",
  async (req, res) => {
    const access =
      await resolveStaffAccess(
        req,
        "admin"
      );

    if (!access.ok) {
      return res
        .status(
          access.status || 403
        )
        .json({
          ok: false,
          error:
            access.error ||
            "STAFF_ACCESS_DENIED",
        });
    }

    if (!supabaseServiceRole) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "STAFF_SERVICE_ROLE_NOT_CONFIGURED",
        });
    }

    const complaintId =
      String(
        req.params?.complaintId ||
          ""
      ).trim();

    if (
      !adminModerationUuidOrNull(
        complaintId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "COMPLAINT_ID_INVALID",
        });
    }

    try {
      const {
        data: rows,
        error: rowsError,
      } =
        await supabaseServiceRole
          .from(
            "complaint_attachments"
          )
          .select(
            [
              "id",
              "complaint_id",
              "storage_bucket",
              "storage_path",
              "mime_type",
              "file_size_bytes",
              "created_at",
            ].join(",")
          )
          .eq(
            "complaint_id",
            complaintId
          )
          .order(
            "created_at",
            {
              ascending: true,
            }
          );

      if (rowsError) {
        console.error(
          "[AUTODEAR][ADMIN][COMPLAINT_ATTACHMENTS_LOAD_FAILED]",
          {
            complaintId,
            message:
              rowsError.message ||
              null,
          }
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "COMPLAINT_ATTACHMENTS_LOAD_FAILED",
          });
      }

      const attachments = [];

      for (
        const row of
        Array.isArray(rows)
          ? rows
          : []
      ) {
        const bucket =
          String(
            row?.storage_bucket ||
              "complaint-attachments"
          ).trim();

        const storagePath =
          String(
            row?.storage_path ||
              ""
          ).trim();

        if (!storagePath) {
          continue;
        }

        const {
          data: signed,
          error: signedError,
        } =
          await supabaseServiceRole
            .storage
            .from(bucket)
            .createSignedUrl(
              storagePath,
              10 * 60
            );

        if (
          signedError ||
          !signed?.signedUrl
        ) {
          console.warn(
            "[AUTODEAR][ADMIN][COMPLAINT_ATTACHMENT_SIGN_FAILED]",
            {
              complaintId,
              attachmentId:
                row?.id || null,
              bucket,
              storagePath,
              message:
                signedError
                  ?.message ||
                null,
            }
          );

          continue;
        }

        attachments.push({
          id:
            row.id,

          complaintId:
            row.complaint_id,

          mimeType:
            row.mime_type ||
            null,

          fileSizeBytes:
            row.file_size_bytes ||
            null,

          createdAt:
            row.created_at ||
            null,

          url:
            signed.signedUrl,
        });
      }

      return res.json({
        ok: true,
        attachments,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][ADMIN][COMPLAINT_ATTACHMENTS_FATAL]",
        {
          complaintId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "COMPLAINT_ATTACHMENTS_FATAL",
        });
    }
  }
);


// ADMIN_ACCOUNT_MODERATION_V1
//
// Реальная блокировка аккаунта выполняется только сервером.
// Клиентский roleSwitcher не является источником полномочий.
//
// ACCOUNT_BLOCK_GATE_V2
//
// Источник истины блокировки:
// public.profiles.account_status.
//
// Supabase Auth НЕ блокируем через ban_duration:
// пользователь должен иметь возможность корректно войти,
// получить статус модерации и увидеть полноэкранное
// уведомление AUTODEAR с причиной, сроком и кнопкой выхода.
//
// Бессрочная блокировка AUTODEAR:
// account_status = blocked + blocked_until = null.

const ADMIN_ACCOUNT_BLOCK_DURATIONS = {
  "24h": {
    banDuration: "24h",
    milliseconds:
      24 * 60 * 60 * 1000,
  },

  "7d": {
    banDuration: "168h",
    milliseconds:
      7 * 24 * 60 * 60 * 1000,
  },

  "30d": {
    banDuration: "720h",
    milliseconds:
      30 * 24 * 60 * 60 * 1000,
  },

  permanent: {
    banDuration: "876000h",
    milliseconds: null,
  },
};


const ADMIN_ACCOUNT_REASON_CODES =
  new Set([
    "fraud_suspicion",
    "spam",
    "threats_or_abuse",
    "suspicious_activity",
    "rules_violation",
    "other",

    // Разблокировка.
    "review_completed",
    "appeal_accepted",
    "moderation_mistake",
  ]);


async function resolveAdminAccountProfile(
  targetId
) {
  const targetUuid =
    adminModerationUuidOrNull(
      targetId
    );

  if (!targetUuid) {
    return {
      profile: null,
      error:
        "ACCOUNT_ID_INVALID",
    };
  }

  if (!supabaseServiceRole) {
    return {
      profile: null,
      error:
        "STAFF_SERVICE_ROLE_NOT_CONFIGURED",
    };
  }

  const selectFields = [
    "id",
    "auth_user_id",
    "name",
    "email",
    "role",
    "account_status",
    "moderation_reason",
    "blocked_at",
    "blocked_until",
    "blocked_by_auth_user_id",
    "moderation_updated_at",
  ].join(",");

  let {
    data: profile,
    error,
  } =
    await supabaseServiceRole
      .from("profiles")
      .select(selectFields)
      .eq(
        "auth_user_id",
        targetUuid
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    return {
      profile: null,
      error:
        "ACCOUNT_PROFILE_LOAD_FAILED",
      details:
        error.message || null,
    };
  }

  if (!profile) {
    const result =
      await supabaseServiceRole
        .from("profiles")
        .select(selectFields)
        .eq(
          "id",
          targetUuid
        )
        .limit(1)
        .maybeSingle();

    profile =
      result.data || null;

    error =
      result.error || null;

    if (error) {
      return {
        profile: null,
        error:
          "ACCOUNT_PROFILE_LOAD_FAILED",
        details:
          error.message || null,
      };
    }
  }

  if (!profile) {
    return {
      profile: null,
      error:
        "ACCOUNT_PROFILE_NOT_FOUND",
    };
  }

  const authUserId =
    adminModerationUuidOrNull(
      profile.auth_user_id
    );

  if (!authUserId) {
    return {
      profile: null,
      error:
        "ACCOUNT_AUTH_USER_NOT_RESOLVED",
    };
  }

  return {
    profile: {
      ...profile,
      auth_user_id:
        authUserId,
    },
    error: null,
  };
}


// ACCOUNT_MODERATION_STATUS_V1
//
// Обычный авторизованный пользователь может узнать только
// собственный статус модерации.
//
// Этот endpoint используется:
// - сразу после успешного входа;
// - после восстановления сессии;
// - при возврате приложения из background.
//
// Временная блокировка автоматически снимается после срока.

app.get(
  "/api/account/moderation-status",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(
        req
      );

    const authUserId =
      adminModerationUuidOrNull(
        authResult?.user?.id
      );

    if (!authUserId) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
    }

    if (!supabaseServiceRole) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "STAFF_SERVICE_ROLE_NOT_CONFIGURED",
        });
    }

    try {
      const selectFields = [
        "id",
        "auth_user_id",
        "account_status",
        "moderation_reason",
        "blocked_at",
        "blocked_until",
        "moderation_updated_at",
      ].join(",");

      const {
        data: profile,
        error: profileError,
      } =
        await supabaseServiceRole
          .from("profiles")
          .select(selectFields)
          .eq(
            "auth_user_id",
            authUserId
          )
          .limit(1)
          .maybeSingle();

      if (profileError) {
        console.error(
          "[AUTODEAR][ACCOUNT][MODERATION_STATUS_LOAD_FAILED]",
          {
            authUserId,
            message:
              profileError.message ||
              null,
          }
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "ACCOUNT_MODERATION_STATUS_LOAD_FAILED",
          });
      }

      /*
       * Старые аккаунты без строки profiles
       * не считаем заблокированными.
       */
      if (!profile) {
        return res.json({
          ok: true,

          account: {
            status:
              "active",

            moderationReason:
              "",

            blockedAt:
              null,

            blockedUntil:
              null,

            expired:
              false,
          },
        });
      }

      const status =
        String(
          profile.account_status ||
            "active"
        )
          .trim()
          .toLowerCase();

      const blockedUntil =
        profile.blocked_until ||
        null;

      const blockedUntilMs =
        blockedUntil
          ? new Date(
              blockedUntil
            ).getTime()
          : NaN;

      const expired =
        status === "blocked" &&
        Boolean(blockedUntil) &&
        Number.isFinite(
          blockedUntilMs
        ) &&
        blockedUntilMs <=
          Date.now();

      /*
       * Временный срок закончился.
       * Снимаем блокировку автоматически.
       */
      if (expired) {
        const nowIso =
          new Date()
            .toISOString();

        const {
          data: restored,
          error: restoreError,
        } =
          await supabaseServiceRole
            .from("profiles")
            .update({
              account_status:
                "active",

              moderation_reason:
                null,

              blocked_at:
                null,

              blocked_until:
                null,

              blocked_by_auth_user_id:
                null,

              moderation_updated_at:
                nowIso,
            })
            .eq(
              "id",
              profile.id
            )
            .select(
              selectFields
            )
            .single();

        if (restoreError) {
          console.error(
            "[AUTODEAR][ACCOUNT][AUTO_UNBLOCK_FAILED]",
            {
              authUserId,
              message:
                restoreError.message ||
                null,
            }
          );

          /*
           * При ошибке снятия не разрешаем обходить
           * действующий blocked state.
           */
          return res.json({
            ok: true,

            account: {
              status:
                "blocked",

              moderationReason:
                profile
                  .moderation_reason ||
                "",

              blockedAt:
                profile.blocked_at ||
                null,

              blockedUntil,

              expired:
                true,
            },
          });
        }

        console.log(
          "[AUTODEAR][ACCOUNT][AUTO_UNBLOCKED]",
          {
            authUserId,
            profileId:
              profile.id,
            expiredAt:
              blockedUntil,
          }
        );

        return res.json({
          ok: true,

          account: {
            status:
              restored
                ?.account_status ||
              "active",

            moderationReason:
              "",

            blockedAt:
              null,

            blockedUntil:
              null,

            expired:
              true,
          },
        });
      }

      return res.json({
        ok: true,

        account: {
          status,

          moderationReason:
            profile
              .moderation_reason ||
            "",

          blockedAt:
            profile.blocked_at ||
            null,

          blockedUntil,

          expired:
            false,
        },
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][ACCOUNT][MODERATION_STATUS_FATAL]",
        {
          authUserId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "ACCOUNT_MODERATION_STATUS_FATAL",
        });
    }
  }
);


app.get(
  "/api/admin/moderation/accounts/:targetId",
  async (req, res) => {
    const access =
      await resolveStaffAccess(
        req,
        "admin"
      );

    if (!access.ok) {
      return res
        .status(
          access.status || 403
        )
        .json({
          ok: false,
          error:
            access.error ||
            "STAFF_ACCESS_DENIED",
        });
    }

    const targetId =
      String(
        req.params?.targetId ||
          ""
      ).trim();

    const resolved =
      await resolveAdminAccountProfile(
        targetId
      );

    if (!resolved.profile) {
      const notFound =
        resolved.error ===
        "ACCOUNT_PROFILE_NOT_FOUND";

      return res
        .status(
          notFound
            ? 404
            : 400
        )
        .json({
          ok: false,
          error:
            resolved.error ||
            "ACCOUNT_NOT_RESOLVED",
        });
    }

    const profile =
      resolved.profile;

    /*
     * LEGACY_AUTH_BAN_RELEASE_ON_ADMIN_READ_V1
     *
     * До ACCOUNT_BLOCK_GATE_V2 часть заблокированных
     * пользователей могла иметь Supabase Auth ban.
     *
     * При открытии такого аккаунта администратором
     * снимаем старый Auth-ban в фоне, сохраняя
     * profiles.account_status = blocked.
     */
    if (
      String(
        profile.account_status ||
          ""
      ).toLowerCase() ===
      "blocked"
    ) {
      void supabaseServiceRole
        .auth
        .admin
        .updateUserById(
          profile.auth_user_id,
          {
            ban_duration:
              "none",
          }
        )
        .then(
          ({ error }) => {
            if (error) {
              console.warn(
                "[AUTODEAR][ADMIN][LEGACY_AUTH_BAN_READ_RELEASE_FAILED]",
                {
                  targetAuthUserId:
                    profile
                      .auth_user_id,
                  message:
                    error.message ||
                    null,
                }
              );
            }
          }
        )
        .catch(
          (error) => {
            console.warn(
              "[AUTODEAR][ADMIN][LEGACY_AUTH_BAN_READ_RELEASE_ERROR]",
              {
                targetAuthUserId:
                  profile
                    .auth_user_id,
                message:
                  error?.message ||
                  String(error),
              }
            );
          }
        );
    }

    return res.json({
      ok: true,

      account: {
        profileId:
          profile.id,

        authUserId:
          profile.auth_user_id,

        name:
          profile.name || "",

        email:
          profile.email || "",

        role:
          profile.role || "user",

        status:
          profile.account_status ||
          "active",

        moderationReason:
          profile.moderation_reason ||
          "",

        blockedAt:
          profile.blocked_at ||
          null,

        blockedUntil:
          profile.blocked_until ||
          null,
      },
    });
  }
);


app.post(
  "/api/admin/moderation/accounts/:targetId/action",
  async (req, res) => {
    const targetId =
      String(
        req.params?.targetId ||
          ""
      ).trim();

    const action =
      String(
        req.body?.action ||
          ""
      )
        .trim()
        .toLowerCase();

    const duration =
      String(
        req.body?.duration ||
          ""
      )
        .trim()
        .toLowerCase();

    const reasonCode =
      String(
        req.body?.reasonCode ||
          ""
      )
        .trim()
        .toLowerCase();

    const reasonText =
      String(
        req.body?.reasonText ||
          ""
      ).trim();

    const complaintId =
      String(
        req.body?.complaintId ||
          ""
      ).trim();

    if (
      action !== "block" &&
      action !== "unblock"
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "ADMIN_ACCOUNT_ACTION_INVALID",
        });
    }

    const durationConfig =
      action === "block"
        ? ADMIN_ACCOUNT_BLOCK_DURATIONS[
            duration
          ]
        : null;

    if (
      action === "block" &&
      !durationConfig
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "ADMIN_ACCOUNT_DURATION_INVALID",
        });
    }

    if (
      !ADMIN_ACCOUNT_REASON_CODES
        .has(reasonCode)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "MODERATION_REASON_CODE_INVALID",
        });
    }

    if (
      reasonText.length < 3 ||
      reasonText.length > 1000
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "MODERATION_REASON_REQUIRED",
        });
    }

    const access =
      await resolveStaffAccess(
        req,
        "admin"
      );

    if (!access.ok) {
      return res
        .status(
          access.status || 403
        )
        .json({
          ok: false,
          error:
            access.error ||
            "STAFF_ACCESS_DENIED",
        });
    }

    if (!supabaseServiceRole) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "STAFF_SERVICE_ROLE_NOT_CONFIGURED",
        });
    }

    const actorAuthUserId =
      adminModerationUuidOrNull(
        access.actor
          ?.authUserId
      );

    if (!actorAuthUserId) {
      return res
        .status(403)
        .json({
          ok: false,
          error:
            "ADMIN_ACTOR_NOT_RESOLVED",
        });
    }

    const resolved =
      await resolveAdminAccountProfile(
        targetId
      );

    if (!resolved.profile) {
      const notFound =
        resolved.error ===
        "ACCOUNT_PROFILE_NOT_FOUND";

      return res
        .status(
          notFound
            ? 404
            : 400
        )
        .json({
          ok: false,
          error:
            resolved.error ||
            "ACCOUNT_NOT_RESOLVED",
        });
    }

    const profile =
      resolved.profile;

    const targetAuthUserId =
      profile.auth_user_id;

    if (
      targetAuthUserId ===
      actorAuthUserId
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "ADMIN_SELF_BLOCK_FORBIDDEN",
        });
    }

    const {
      data: targetStaff,
      error: targetStaffError,
    } =
      await supabaseServiceRole
        .from("staff_accounts")
        .select(
          "auth_user_id,is_active,roles"
        )
        .eq(
          "auth_user_id",
          targetAuthUserId
        )
        .eq(
          "is_active",
          true
        )
        .maybeSingle();

    if (targetStaffError) {
      console.error(
        "[AUTODEAR][ADMIN][ACCOUNT_STAFF_CHECK_FAILED]",
        {
          targetAuthUserId,
          message:
            targetStaffError.message ||
            null,
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "ACCOUNT_STAFF_CHECK_FAILED",
        });
    }

    if (targetStaff) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "STAFF_ACCOUNT_BLOCK_FORBIDDEN",
        });
    }

    const now =
      new Date();

    const nowIso =
      now.toISOString();

    const blockedUntil =
      action === "block" &&
      durationConfig
        ?.milliseconds != null
        ? new Date(
            now.getTime() +
              durationConfig
                .milliseconds
          ).toISOString()
        : null;

    const nextProfileState =
      action === "block"
        ? {
            account_status:
              "blocked",

            moderation_reason:
              reasonText,

            blocked_at:
              nowIso,

            blocked_until:
              blockedUntil,

            blocked_by_auth_user_id:
              actorAuthUserId,

            moderation_updated_at:
              nowIso,
          }
        : {
            account_status:
              "active",

            moderation_reason:
              reasonText,

            blocked_at:
              null,

            blocked_until:
              null,

            blocked_by_auth_user_id:
              null,

            moderation_updated_at:
              nowIso,
          };

    const {
      data: updatedProfile,
      error: profileUpdateError,
    } =
      await supabaseServiceRole
        .from("profiles")
        .update(
          nextProfileState
        )
        .eq(
          "id",
          profile.id
        )
        .select(
          [
            "id",
            "auth_user_id",
            "name",
            "email",
            "role",
            "account_status",
            "moderation_reason",
            "blocked_at",
            "blocked_until",
            "blocked_by_auth_user_id",
            "moderation_updated_at",
          ].join(",")
        )
        .single();

    if (profileUpdateError) {
      console.error(
        "[AUTODEAR][ADMIN][ACCOUNT_PROFILE_UPDATE_FAILED]",
        {
          targetAuthUserId,
          action,
          message:
            profileUpdateError
              .message ||
            null,
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "ACCOUNT_PROFILE_UPDATE_FAILED",
        });
    }

    /*
     * ACCOUNT_AUTH_BAN_REMOVED_V2
     *
     * AUTODEAR блокирует доступ через profiles.account_status.
     * Supabase Auth должен оставаться доступным, иначе
     * пользователь не сможет войти и увидеть причину блокировки.
     *
     * Одновременно снимаем возможный legacy-ban от старой схемы.
     * Не ждём этот запрос, чтобы административное действие
     * не зависело от задержек Supabase Auth Admin API.
     */
    void supabaseServiceRole
      .auth
      .admin
      .updateUserById(
        targetAuthUserId,
        {
          ban_duration:
            "none",
        }
      )
      .then(
        ({ error }) => {
          if (error) {
            console.warn(
              "[AUTODEAR][ADMIN][LEGACY_AUTH_BAN_RELEASE_FAILED]",
              {
                targetAuthUserId,
                message:
                  error.message ||
                  null,
              }
            );
          }
        }
      )
      .catch(
        (error) => {
          console.warn(
            "[AUTODEAR][ADMIN][LEGACY_AUTH_BAN_RELEASE_ERROR]",
            {
              targetAuthUserId,
              message:
                error?.message ||
                String(error),
            }
          );
        }
      );

    const warnings = [];

    const {
      error: auditError,
    } =
      await supabaseServiceRole
        .from(
          "moderation_actions"
        )
        .insert({
          actor_auth_user_id:
            actorAuthUserId,

          actor_role:
            "admin",

          action_type:
            action === "block"
              ? "account_block"
              : "account_unblock",

          target_type:
            "account",

          target_id:
            targetAuthUserId,

          target_owner_auth_user_id:
            targetAuthUserId,

          reason_code:
            reasonCode,

          reason_text:
            reasonText,

          metadata: {
            complaintId:
              complaintId ||
              null,

            requestedTargetId:
              targetId,

            profileId:
              profile.id,

            duration:
              action === "block"
                ? duration
                : null,

            blockedUntil,
          },
        });

    if (auditError) {
      warnings.push(
        "AUDIT_LOG_FAILED"
      );

      console.error(
        "[AUTODEAR][ADMIN][ACCOUNT_AUDIT_FAILED]",
        {
          targetAuthUserId,
          action,
          message:
            auditError.message ||
            null,
        }
      );
    }

    console.log(
      "[AUTODEAR][ADMIN][ACCOUNT_MODERATED]",
      {
        targetAuthUserId,
        action,
        duration:
          action === "block"
            ? duration
            : null,
        actorAuthUserId,
        complaintId:
          complaintId || null,
      }
    );

    return res.json({
      ok: true,

      account: {
        profileId:
          updatedProfile.id,

        authUserId:
          targetAuthUserId,

        name:
          updatedProfile.name ||
          "",

        status:
          updatedProfile
            .account_status ||
          (
            action === "block"
              ? "blocked"
              : "active"
          ),

        moderationReason:
          updatedProfile
            .moderation_reason ||
          "",

        blockedAt:
          updatedProfile
            .blocked_at ||
          null,

        blockedUntil:
          updatedProfile
            .blocked_until ||
          null,

        authBannedUntil:
          null,
      },

      moderation: {
        action,

        duration:
          action === "block"
            ? duration
            : null,

        reasonCode,
        reasonText,
        actorAuthUserId,
        moderatedAt:
          nowIso,
      },

      warnings,
    });
  }
);


app.post(
  "/api/admin/moderation/listings/:listingId/action",
  async (req, res) => {
    const listingId =
      String(
        req.params?.listingId ||
        ""
      ).trim();

    const action =
      String(
        req.body?.action ||
        ""
      )
        .trim()
        .toLowerCase();

    const reasonCode =
      String(
        req.body?.reasonCode ||
        ""
      )
        .trim()
        .toLowerCase();

    const reasonText =
      String(
        req.body?.reasonText ||
        ""
      ).trim();

    const complaintId =
      String(
        req.body?.complaintId ||
        ""
      ).trim();

    if (!listingId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "LISTING_ID_REQUIRED",
        });
    }

    const actionConfig =
      ADMIN_LISTING_ACTIONS[
        action
      ];

    if (!actionConfig) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "ADMIN_LISTING_ACTION_INVALID",
        });
    }

    if (
      !ADMIN_LISTING_REASON_CODES
        .has(reasonCode)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "MODERATION_REASON_CODE_INVALID",
        });
    }

    if (
      reasonText.length < 3
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "MODERATION_REASON_REQUIRED",
        });
    }

    const access =
      await resolveStaffAccess(
        req,
        "admin"
      );

    if (!access.ok) {
      return res
        .status(
          access.status || 403
        )
        .json({
          ok: false,
          error:
            access.error ||
            "STAFF_ACCESS_DENIED",
        });
    }

    if (!supabase) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
    }

    const actorAuthUserId =
      String(
        access.actor
          ?.authUserId ||
        ""
      ).trim();

    const nowIso =
      new Date()
        .toISOString();

    try {
      const {
        data: listing,
        error:
          listingError,
      } =
        await supabase
          .from("listings")
          .select(
            [
              "id",
              "owner_id",
              "title",
              "status",
              "payload",
              "moderation_action",
              "moderation_reason",
              "moderated_at",
              "moderated_by_auth_user_id",
              "removed_at",
            ].join(",")
          )
          .eq(
            "id",
            listingId
          )
          .maybeSingle();

      if (listingError) {
        console.error(
          "[AUTODEAR][ADMIN][LISTING_LOAD_ERROR]",
          {
            listingId,
            code:
              listingError.code ||
              null,
            message:
              listingError.message ||
              null,
          }
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "ADMIN_LISTING_LOAD_FAILED",
          });
      }

      if (!listing) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "LISTING_NOT_FOUND",
          });
      }

      const owner =
        await resolveAdminListingOwner(
          listing.owner_id
        );

      const oldPayload =
        listing.payload &&
        typeof listing.payload ===
          "object" &&
        !Array.isArray(
          listing.payload
        )
          ? listing.payload
          : {};

      const nextPayload = {
        ...oldPayload,

        status:
          actionConfig.status,

        moderationRejectReason:
          reasonText,

        moderationAction:
          actionConfig
            .moderationAction,

        moderatedAt:
          nowIso,
      };

      if (
        action === "remove"
      ) {
        nextPayload.removedAt =
          nowIso;
      } else {
        delete nextPayload.removedAt;
      }

      const listingPatch = {
        status:
          actionConfig.status,

        moderation_action:
          actionConfig
            .moderationAction,

        moderation_reason:
          reasonText,

        moderated_at:
          nowIso,

        moderated_by_auth_user_id:
          actorAuthUserId,

        removed_at:
          action === "remove"
            ? nowIso
            : null,

        payload:
          nextPayload,
      };

      const {
        data: updated,
        error:
          updateError,
      } =
        await supabase
          .from("listings")
          .update(
            listingPatch
          )
          .eq(
            "id",
            listingId
          )
          .select(
            [
              "id",
              "owner_id",
              "status",
              "moderation_action",
              "moderation_reason",
              "moderated_at",
              "removed_at",
            ].join(",")
          )
          .maybeSingle();

      if (updateError) {
        console.error(
          "[AUTODEAR][ADMIN][LISTING_UPDATE_ERROR]",
          {
            listingId,
            action,
            code:
              updateError.code ||
              null,
            message:
              updateError.message ||
              null,
          }
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "ADMIN_LISTING_UPDATE_FAILED",
          });
      }

      if (!updated) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "LISTING_NOT_FOUND_AFTER_UPDATE",
          });
      }

      const auditRow = {
        actor_auth_user_id:
          actorAuthUserId,

        actor_role:
          "admin",

        action_type:
          actionConfig
            .moderationAction,

        target_type:
          "listing",

        target_id:
          listingId,

        target_owner_auth_user_id:
          owner.authUserId,

        reason_code:
          reasonCode,

        reason_text:
          reasonText,

        metadata: {
          complaintId:
            complaintId ||
            null,

          listingTitle:
            String(
              listing.title ||
              oldPayload?.title ||
              ""
            ).trim() ||
            null,

          previousStatus:
            listing.status ||
            null,

          nextStatus:
            actionConfig.status,
        },
      };

      const {
        error:
          auditError,
      } =
        await supabase
          .from(
            "moderation_actions"
          )
          .insert(
            auditRow
          );

      if (auditError) {
        console.error(
          "[AUTODEAR][ADMIN][AUDIT_INSERT_ERROR]",
          {
            listingId,
            action,
            code:
              auditError.code ||
              null,
            message:
              auditError.message ||
              null,
          }
        );

        const {
          error:
            rollbackError,
        } =
          await supabase
            .from("listings")
            .update({
              status:
                listing.status,

              payload:
                listing.payload,

              moderation_action:
                listing
                  .moderation_action,

              moderation_reason:
                listing
                  .moderation_reason,

              moderated_at:
                listing
                  .moderated_at,

              moderated_by_auth_user_id:
                listing
                  .moderated_by_auth_user_id,

              removed_at:
                listing
                  .removed_at,
            })
            .eq(
              "id",
              listingId
            );

        if (rollbackError) {
          console.error(
            "[AUTODEAR][ADMIN][AUDIT_ROLLBACK_CRITICAL]",
            {
              listingId,
              code:
                rollbackError.code ||
                null,
              message:
                rollbackError.message ||
                null,
            }
          );
        }

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "MODERATION_AUDIT_FAILED",
            rolledBack:
              !rollbackError,
          });
      }

      const notificationTitle =
        actionConfig.title;

      const notificationBody =
        `Причина: ${reasonText}`;

      let notificationCreated =
        false;

      let pushSent = 0;

      const warnings = [];

      const recipientId =
        String(
          owner.authUserId ||
          owner.ownerId ||
          ""
        ).trim();

      if (recipientId) {
        const {
          error:
            notificationError,
        } =
          await supabase
            .from(
              "notifications"
            )
            .insert({
              recipient_role:
                "user",

              recipient_id:
                recipientId,

              title:
                notificationTitle,

              body:
                notificationBody,

              type:
                "listing_moderation",

              related_type:
                "listing",

              related_id:
                listingId,
            });

        if (
          notificationError
        ) {
          console.warn(
            "[AUTODEAR][ADMIN][LISTING_NOTIFICATION_ERROR]",
            {
              listingId,
              recipientId,
              code:
                notificationError
                  .code ||
                null,
              message:
                notificationError
                  .message ||
                null,
            }
          );

          warnings.push(
            "NOTIFICATION_CREATE_FAILED"
          );
        } else {
          notificationCreated =
            true;
        }

        try {
          const pushResult =
            await sendAdminListingModerationPush({
              ownerAuthUserId:
                owner.authUserId,

              ownerEmail:
                owner.email,

              listingId,

              title:
                notificationTitle,

              body:
                notificationBody,
            });

          pushSent =
            Number(
              pushResult?.sent ||
              0
            );
        } catch (pushError) {
          console.warn(
            "[AUTODEAR][ADMIN][LISTING_PUSH_ERROR]",
            {
              listingId,
              recipientId,
              message:
                pushError?.message ||
                String(
                  pushError
                ),
            }
          );

          warnings.push(
            "PUSH_SEND_FAILED"
          );
        }
      } else {
        warnings.push(
          "LISTING_OWNER_RECIPIENT_NOT_RESOLVED"
        );
      }

      console.log(
        "[AUTODEAR][ADMIN][LISTING_MODERATED]",
        {
          listingId,
          action,
          reasonCode,
          actorAuthUserId,
          ownerAuthUserId:
            owner.authUserId,
          notificationCreated,
          pushSent,
        }
      );

      return res.json({
        ok: true,

        listing: updated,

        moderation: {
          action,
          reasonCode,
          reasonText,
          actorAuthUserId,
          moderatedAt:
            nowIso,
        },

        delivery: {
          notificationCreated,
          pushSent,
        },

        warnings,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][ADMIN][LISTING_MODERATION_FATAL]",
        {
          listingId,
          action,
          message:
            error?.message ||
            String(error),
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "ADMIN_LISTING_MODERATION_FAILED",
        });
    }
  }
);

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




app.get("/api/business/services", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        [
          "id",
          "owner_id",
          "name",
          "legal_name",
          "services",
          "directions",
          "service_prices",
        ].join(",")
      )
      .eq("owner_id", userId)
      .order(
        "created_at",
        {
          ascending: true,
        }
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SERVICES_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SERVICES_STATIONS_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    const stationIds =
      ownedStations
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    let links = [];

    if (stationIds.length) {
      const {
        data: serviceLinks,
        error: linksError,
      } = await supabase
        .from("station_services")
        .select(
          [
            "id",
            "station_id",
            "service_id",
            "title",
            "direction",
          ].join(",")
        )
        .in(
          "station_id",
          stationIds
        );

      if (linksError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][SERVICES_LINKS_ERROR]",
          {
            userId,
            code:
              linksError.code ||
              null,
            message:
              linksError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_SERVICES_LINKS_FAILED",
        });
      }

      links =
        Array.isArray(serviceLinks)
          ? serviceLinks
          : [];
    }

    const {
      data: catalogRows,
      error: catalogError,
    } = await supabase
      .from("services")
      .select(
        [
          "id",
          "title",
          "category",
          "moderation_required",
        ].join(",")
      )
      .order(
        "title",
        {
          ascending: true,
        }
      );

    if (catalogError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SERVICES_CATALOG_LOAD_ERROR]",
        {
          userId,
          code:
            catalogError.code ||
            null,
          message:
            catalogError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "SERVICE_CATALOG_LOAD_FAILED",
      });
    }


    const businesses =
      ownedStations.map(
        (station) => {
          const stationId =
            String(
              station?.id || ""
            );

          const stationLinks =
            links
              .filter(
                (link) =>
                  String(
                    link?.station_id ||
                    ""
                  ) === stationId
              )
              .map(
                (link) => ({
                  id:
                    link.id ||
                    null,

                  stationId:
                    link.station_id ||
                    stationId,

                  serviceId:
                    link.service_id ||
                    null,

                  title:
                    link.title ||
                    "Услуга",

                  direction:
                    link.direction ||
                    null,
                })
              );

          return {
            id:
              stationId,

            name:
              station?.name ||
              station?.legal_name ||
              "Бизнес AUTODEAR",

            directions:
              Array.isArray(
                station?.directions
              )
                ? station.directions
                : [],

            services:
              stationLinks,

            servicePrices:
              station?.service_prices &&
              typeof station.service_prices ===
                "object"
                ? station.service_prices
                : {},
          };
        }
      );

    console.log(
      "[AUTODEAR][WEB_BUSINESS][SERVICES_OK]",
      {
        userId,
        businesses:
          businesses.length,
        links:
          links.length,
      }
    );

    const catalog =
      (
        Array.isArray(
          catalogRows
        )
          ? catalogRows
          : []
      )
        /*
         * Business UI shows only approved
         * global catalog entries.
         *
         * moderation_required=true remains
         * outside normal business selection
         * until moderation approves it.
         */
        .filter(
          (service) =>
            service
              ?.moderation_required !==
            true
        )
        .map(
          (service) => ({
            id:
              service.id,

            serviceId:
              service.id,

            title:
              service.title ||
              "Услуга",

            direction:
              service.category ||
              "autoservice",

            priceFrom:
              null,
          })
        );


    return res.json({
      ok: true,

      businesses,

      catalog,

      catalogCount:
        catalog.length,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][SERVICES_UNEXPECTED]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_SERVICES_FAILED",
    });
  }
});


app.patch(
  "/api/business/services/:businessId",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const authUser =
      authResult?.user || null;

    const userId =
      String(
        authUser?.id || ""
      ).trim();

    const businessId =
      String(
        req.params.businessId || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!businessId) {
      return res.status(400).json({
        ok: false,
        error:
          "BUSINESS_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      /*
       * SECURITY:
       * Never trust businessId from browser.
       * The station must belong to the
       * authenticated Supabase user.
       */
      const {
        data: station,
        error: stationError,
      } = await supabase
        .from("stations")
        .select(
          [
            "id",
            "owner_id",
            "name",
            "legal_name",
            "service_prices",
          ].join(",")
        )
        .eq(
          "id",
          businessId
        )
        .eq(
          "owner_id",
          userId
        )
        .maybeSingle();

      if (stationError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][SERVICES_OWNER_ERROR]",
          {
            userId,
            businessId,
            code:
              stationError.code ||
              null,
            message:
              stationError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LOOKUP_FAILED",
        });
      }

      if (!station) {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_ACCESS_DENIED",
        });
      }

      const requestedServices =
        Array.isArray(
          req.body?.services
        )
          ? req.body.services
          : null;

      if (!requestedServices) {
        return res.status(400).json({
          ok: false,
          error:
            "SERVICES_REQUIRED",
        });
      }

      /*
       * Browser may select only services that
       * already exist in the global catalog.
       * Creating new global services is reserved
       * for the moderation/admin workflow.
       */
      const requestedMap =
        new Map();

      for (
        const raw of
        requestedServices
      ) {
        const serviceId =
          String(
            raw?.serviceId ||
            raw?.id ||
            ""
          ).trim();

        if (!serviceId) {
          continue;
        }

        requestedMap.set(
          serviceId,
          {
            serviceId,

            title:
              String(
                raw?.title || ""
              ).trim(),

            direction:
              String(
                raw?.direction || ""
              ).trim(),
          }
        );
      }

      const requestedIds =
        Array.from(
          requestedMap.keys()
        );

      let catalogRows = [];

      if (requestedIds.length) {
        const {
          data: catalog,
          error: catalogError,
        } = await supabase
          .from("services")
          .select(
            [
              "id",
              "title",
              "category",
            ].join(",")
          )
          .in(
            "id",
            requestedIds
          );

        if (catalogError) {
          console.error(
            "[AUTODEAR][WEB_BUSINESS][SERVICE_CATALOG_ERROR]",
            {
              userId,
              businessId,
              code:
                catalogError.code ||
                null,
              message:
                catalogError.message ||
                null,
            }
          );

          return res.status(500).json({
            ok: false,
            error:
              "SERVICE_CATALOG_LOOKUP_FAILED",
          });
        }

        catalogRows =
          Array.isArray(catalog)
            ? catalog
            : [];

        const validIds =
          new Set(
            catalogRows.map(
              (item) =>
                String(
                  item?.id || ""
                )
            )
          );

        const invalidIds =
          requestedIds.filter(
            (id) =>
              !validIds.has(id)
          );

        if (invalidIds.length) {
          return res.status(400).json({
            ok: false,
            error:
              "UNKNOWN_SERVICE",
            invalidServiceIds:
              invalidIds,
          });
        }
      }

      const {
        error: deleteError,
      } = await supabase
        .from("station_services")
        .delete()
        .eq(
          "station_id",
          businessId
        );

      if (deleteError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][SERVICES_CLEAR_ERROR]",
          {
            userId,
            businessId,
            code:
              deleteError.code ||
              null,
            message:
              deleteError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_SERVICES_CLEAR_FAILED",
        });
      }

      const rows =
        catalogRows.map(
          (catalogItem) => {
            const serviceId =
              String(
                catalogItem?.id || ""
              );

            const requested =
              requestedMap.get(
                serviceId
              ) || {};

            const title =
              String(
                catalogItem?.title ||
                requested.title ||
                "Услуга"
              ).trim();

            const direction =
              String(
                requested.direction ||
                catalogItem?.category ||
                ""
              ).trim();

            return {
              id:
                `${businessId}_${serviceId}`,

              station_id:
                businessId,

              service_id:
                serviceId,

              title,

              direction,
            };
          }
        );

      if (rows.length) {
        const {
          error: insertError,
        } = await supabase
          .from("station_services")
          .upsert(rows);

        if (insertError) {
          console.error(
            "[AUTODEAR][WEB_BUSINESS][SERVICES_SAVE_ERROR]",
            {
              userId,
              businessId,
              code:
                insertError.code ||
                null,
              message:
                insertError.message ||
                null,
            }
          );

          return res.status(500).json({
            ok: false,
            error:
              "BUSINESS_SERVICES_SAVE_FAILED",
          });
        }
      }

      const titles =
        rows.map(
          (row) =>
            row.title
        );

      const directions =
        Array.from(
          new Set(
            rows
              .map(
                (row) =>
                  row.direction
              )
              .filter(Boolean)
          )
        );

      const stationPatch = {
        services:
          titles,

        directions,

        updated_at:
          new Date()
            .toISOString(),
      };

      if (
        req.body?.servicePrices &&
        typeof req.body.servicePrices ===
          "object" &&
        !Array.isArray(
          req.body.servicePrices
        )
      ) {
        stationPatch.service_prices =
          req.body.servicePrices;
      }

      const {
        error: stationUpdateError,
      } = await supabase
        .from("stations")
        .update(
          stationPatch
        )
        .eq(
          "id",
          businessId
        )
        .eq(
          "owner_id",
          userId
        );

      if (stationUpdateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][SERVICES_STATION_UPDATE_ERROR]",
          {
            userId,
            businessId,
            code:
              stationUpdateError.code ||
              null,
            message:
              stationUpdateError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_SERVICES_STATION_UPDATE_FAILED",
        });
      }

      console.log(
        "[AUTODEAR][WEB_BUSINESS][SERVICES_UPDATED]",
        {
          userId,
          businessId,
          services:
            rows.length,
          directions:
            directions.length,
        }
      );

      return res.json({
        ok: true,

        business: {
          id:
            businessId,

          name:
            station?.name ||
            station?.legal_name ||
            "Бизнес AUTODEAR",

          services:
            rows.map(
              (row) => ({
                id:
                  row.id,

                stationId:
                  row.station_id,

                serviceId:
                  row.service_id,

                title:
                  row.title,

                direction:
                  row.direction,
              })
            ),

          directions,

          servicePrices:
            stationPatch.service_prices ||
            station?.service_prices ||
            {},
        },
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SERVICES_UPDATE_UNEXPECTED]",
        {
          userId,
          businessId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SERVICES_UPDATE_FAILED",
      });
    }
  }
);


app.get("/api/business/availability", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,owner_id,name,legal_name"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_STATIONS_ERROR]",
        stationsError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    if (!ownedStations.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const stationIds =
      ownedStations
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    const {
      data: rows,
      error: availabilityError,
    } = await supabase
      .from("business_availability")
      .select("*")
      .in(
        "business_id",
        stationIds
      );

    if (availabilityError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_LOAD_ERROR]",
        availabilityError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_AVAILABILITY_LOAD_FAILED",
      });
    }

    const availabilityByBusiness =
      new Map(
        (
          Array.isArray(rows)
            ? rows
            : []
        ).map((row) => [
          String(
            row.business_id
          ),
          row,
        ])
      );

    const availability =
      ownedStations.map(
        (station) => {
          const businessId =
            String(
              station.id
            );

          const row =
            availabilityByBusiness.get(
              businessId
            );

          return {
            businessId,

            businessName:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",

            workingDays:
              row?.working_days || {
                mon: true,
                tue: true,
                wed: true,
                thu: true,
                fri: true,
                sat: true,
                sun: false,
              },

            openTime:
              row?.open_time ||
              "09:00",

            closeTime:
              row?.close_time ||
              "18:00",

            breakEnabled:
              row?.break_enabled !==
              false,

            breakStart:
              row?.break_start ||
              "13:00",

            breakEnd:
              row?.break_end ||
              "14:00",

            slotMinutes:
              Number(
                row?.slot_minutes ||
                60
              ),

            postsCount:
              Number(
                row?.posts_count ||
                1
              ),

            closedDates:
              row?.closed_dates ||
              {},

            fullyBookedDates:
              row?.fully_booked_dates ||
              {},

            blockedSlots:
              row?.blocked_slots ||
              {},

            updatedAt:
              row?.updated_at ||
              null,
          };
        }
      );

    return res.json({
      ok: true,
      availability,
      count:
        availability.length,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_AVAILABILITY_FAILED",
    });
  }
});


app.patch("/api/business/availability/:businessId", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
    ).trim();

  const businessId =
    String(
      req.params?.businessId ||
      ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!businessId) {
    return res.status(400).json({
      ok: false,
      error:
        "BUSINESS_ID_REQUIRED",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        "SUPABASE_NOT_CONFIGURED",
    });
  }

  try {
    /*
     * SECURITY:
     * Never trust a business id merely
     * because it came from the browser.
     * The station must belong to the
     * authenticated Supabase user.
     */
    const {
      data: station,
      error: stationError,
    } = await supabase
      .from("stations")
      .select(
        "id,owner_id,name,legal_name"
      )
      .eq(
        "id",
        businessId
      )
      .eq(
        "owner_id",
        userId
      )
      .maybeSingle();

    if (stationError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_PATCH_STATION_ERROR]",
        stationError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    if (!station) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const {
      data: current,
      error: currentError,
    } = await supabase
      .from("business_availability")
      .select("*")
      .eq(
        "business_id",
        businessId
      )
      .maybeSingle();

    if (currentError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_PATCH_LOAD_ERROR]",
        currentError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_AVAILABILITY_LOAD_FAILED",
      });
    }

    const body =
      req.body || {};

    const next = {
      business_id:
        businessId,

      working_days:
        body.workingDays ??
        current?.working_days ??
        {
          mon: true,
          tue: true,
          wed: true,
          thu: true,
          fri: true,
          sat: true,
          sun: false,
        },

      open_time:
        body.openTime ??
        current?.open_time ??
        "09:00",

      close_time:
        body.closeTime ??
        current?.close_time ??
        "18:00",

      break_enabled:
        body.breakEnabled ??
        current?.break_enabled ??
        true,

      break_start:
        body.breakStart ??
        current?.break_start ??
        "13:00",

      break_end:
        body.breakEnd ??
        current?.break_end ??
        "14:00",

      slot_minutes:
        Number(
          body.slotMinutes ??
          current?.slot_minutes ??
          60
        ),

      posts_count:
        Number(
          body.postsCount ??
          current?.posts_count ??
          1
        ),

      closed_dates:
        body.closedDates ??
        current?.closed_dates ??
        {},

      fully_booked_dates:
        body.fullyBookedDates ??
        current?.fully_booked_dates ??
        {},

      blocked_slots:
        body.blockedSlots ??
        current?.blocked_slots ??
        {},

      updated_at:
        new Date().toISOString(),
    };

    if (
      !Number.isInteger(
        next.slot_minutes
      ) ||
      next.slot_minutes < 15
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "SLOT_MINUTES_INVALID",
      });
    }

    if (
      !Number.isInteger(
        next.posts_count
      ) ||
      next.posts_count < 1
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "POSTS_COUNT_INVALID",
      });
    }

    const timePattern =
      /^\d{2}:\d{2}$/;

    for (
      const value
      of [
        next.open_time,
        next.close_time,
        next.break_start,
        next.break_end,
      ]
    ) {
      if (
        !timePattern.test(
          String(value)
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_TIME_INVALID",
        });
      }
    }

    const {
      data: saved,
      error: saveError,
    } = await supabase
      .from(
        "business_availability"
      )
      .upsert(
        next,
        {
          onConflict:
            "business_id",
        }
      )
      .select("*")
      .single();

    if (saveError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_SAVE_ERROR]",
        saveError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_AVAILABILITY_SAVE_FAILED",
      });
    }

    return res.json({
      ok: true,

      availability: {
        businessId:
          saved.business_id,

        businessName:
          station.name ||
          station.legal_name ||
          "Бизнес AUTODEAR",

        workingDays:
          saved.working_days ||
          {},

        openTime:
          saved.open_time,

        closeTime:
          saved.close_time,

        breakEnabled:
          saved.break_enabled !==
          false,

        breakStart:
          saved.break_start,

        breakEnd:
          saved.break_end,

        slotMinutes:
          Number(
            saved.slot_minutes ||
            60
          ),

        postsCount:
          Number(
            saved.posts_count ||
            1
          ),

        closedDates:
          saved.closed_dates ||
          {},

        fullyBookedDates:
          saved.fully_booked_dates ||
          {},

        blockedSlots:
          saved.blocked_slots ||
          {},

        updatedAt:
          saved.updated_at ||
          null,
      },
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][AVAILABILITY_PATCH_FATAL]",
      {
        userId,
        businessId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_AVAILABILITY_SAVE_FAILED",
    });
  }
});





app.get("/api/business/card", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * Source of truth for the public business
     * card is stations.
     *
     * Browser does not supply an owner id.
     * We always resolve stations using the
     * authenticated Supabase user.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("*")
      .eq(
        "owner_id",
        userId
      )
      .order(
        "created_at",
        {
          ascending: true,
        }
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][CARD_LOAD_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CARD_LOAD_FAILED",
      });
    }

    const businesses =
      (
        Array.isArray(stations)
          ? stations
          : []
      ).map((station) => ({
        id:
          station.id,

        name:
          station.name ||
          "",

        legalName:
          station.legal_name ||
          "",

        businessType:
          station.business_type ||
          "",

        phone:
          station.phone ||
          "",

        email:
          station.email ||
          "",

        city:
          station.city ||
          "",

        address:
          station.address ||
          "",

        addressFull:
          station.address_full ||
          station.address ||
          "",

        latitude:
          station.latitude == null
            ? null
            : Number(
                station.latitude
              ),

        longitude:
          station.longitude == null
            ? null
            : Number(
                station.longitude
              ),

        timezone:
          station.timezone ||
          "",

        workHours:
          station.work_hours ||
          "",

        workSchedule:
          Array.isArray(
            station.work_schedule
          )
            ? station.work_schedule
            : [],

        works24x7:
          station.works_24_7 === true,

        description:
          station.description ||
          "",

        priceVisible:
          station.price_visible === true,

        onlineBookingEnabled:
          station.online_booking_enabled === true,

        internalCalendarEnabled:
          station.internal_calendar_enabled !==
          false,

        experienceYears:
          Number(
            station.experience_years ||
            0
          ),

        warrantyDays:
          Number(
            station.warranty_days ||
            0
          ),

        photo:
          station.photo_url ||
          station.photo ||
          station.image ||
          "",

        gallery:
          Array.isArray(
            station.gallery
          )
            ? station.gallery
            : (
                Array.isArray(
                  station.photos
                )
                  ? station.photos
                  : (
                      Array.isArray(
                        station.images
                      )
                        ? station.images
                        : []
                    )
              ),

        siteUrl:
          station.site_url ||
          "",

        vkUrl:
          station.vk_url ||
          "",

        maxUrl:
          station.max_url ||
          "",

        isActive:
          station.is_active === true,

        status:
          station.status ||
          "",

        createdAt:
          station.created_at ||
          null,

        updatedAt:
          station.updated_at ||
          null,
      }));

    return res.json({
      ok: true,
      businesses,
      count:
        businesses.length,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][CARD_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_CARD_LOAD_FAILED",
    });
  }
});


app.post(
  "/api/business/card/:businessId/photo",
  businessCardPhotoUpload.single("image"),
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const authUser =
      authResult?.user || null;

    const userId =
      String(
        authUser?.id || ""
      ).trim();

    const businessId =
      String(
        req.params?.businessId || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!businessId) {
      return res.status(400).json({
        ok: false,
        error:
          "BUSINESS_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      /*
       * Никогда не доверяем businessId,
       * полученному из браузера.
       */
      const {
        data: station,
        error: stationError,
      } = await supabase
        .from("stations")
        .select("id,owner_id")
        .eq("id", businessId)
        .eq("owner_id", userId)
        .maybeSingle();

      if (stationError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][PHOTO_OWNER_ERROR]",
          stationError
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CARD_LOOKUP_FAILED",
        });
      }

      if (!station) {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_ACCESS_REQUIRED",
        });
      }

      const file = req.file;

      if (!file?.buffer?.length) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_PHOTO_REQUIRED",
        });
      }

      const mimeType =
        String(
          file.mimetype || ""
        ).toLowerCase();

      const extensionByMime = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };

      const extension =
        extensionByMime[mimeType];

      if (!extension) {
        return res.status(415).json({
          ok: false,
          error:
            "BUSINESS_PHOTO_TYPE_UNSUPPORTED",
        });
      }

      const bucket =
        "business-photos";

      const storagePath =
        `${userId}/main_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}.${extension}`;

      const {
        error: uploadError,
      } = await supabase.storage
        .from(bucket)
        .upload(
          storagePath,
          file.buffer,
          {
            contentType: mimeType,
            upsert: false,
          }
        );

      if (uploadError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][PHOTO_UPLOAD_ERROR]",
          uploadError
        );

        return res.status(502).json({
          ok: false,
          error:
            "BUSINESS_PHOTO_UPLOAD_FAILED",
        });
      }

      const {
        data: publicData,
      } = supabase.storage
        .from(bucket)
        .getPublicUrl(storagePath);

      const photoUrl =
        String(
          publicData?.publicUrl || ""
        ).trim();

      if (!photoUrl) {
        return res.status(502).json({
          ok: false,
          error:
            "BUSINESS_PHOTO_URL_FAILED",
        });
      }

      /*
       * Сразу делаем новое изображение
       * основной фотографией станции.
       */
      const {
        error: updateError,
      } = await supabase
        .from("stations")
        .update({
          photo_url: photoUrl,
        })
        .eq("id", businessId)
        .eq("owner_id", userId);

      if (updateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][PHOTO_CARD_UPDATE_ERROR]",
          updateError
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_PHOTO_CARD_UPDATE_FAILED",
        });
      }

      return res.json({
        ok: true,
        businessId,
        photoUrl,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][PHOTO_FATAL]",
        {
          userId,
          businessId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_PHOTO_UPLOAD_FAILED",
      });
    }
  }
);


app.patch("/api/business/card/:businessId", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
    ).trim();

  const businessId =
    String(
      req.params?.businessId ||
      ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!businessId) {
    return res.status(400).json({
      ok: false,
      error:
        "BUSINESS_ID_REQUIRED",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        "SUPABASE_NOT_CONFIGURED",
    });
  }

  try {
    /*
     * SECURITY:
     * businessId from browser is never trusted
     * by itself. The requested station must
     * belong to the authenticated owner.
     */
    const {
      data: station,
      error: stationError,
    } = await supabase
      .from("stations")
      .select("*")
      .eq(
        "id",
        businessId
      )
      .eq(
        "owner_id",
        userId
      )
      .maybeSingle();

    if (stationError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][CARD_OWNER_ERROR]",
        {
          userId,
          businessId,
          code:
            stationError.code ||
            null,
          message:
            stationError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CARD_LOOKUP_FAILED",
      });
    }

    if (!station) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const body =
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body)
        ? req.body
        : {};

    const patch = {};

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "name"
      )
    ) {
      const name =
        String(
          body.name || ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_NAME_REQUIRED",
        });
      }

      patch.name = name;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "phone"
      )
    ) {
      const phone =
        String(
          body.phone || ""
        ).trim();

      if (
        phone.replace(
          /\D/g,
          ""
        ).length < 11
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_PHONE_INVALID",
        });
      }

      patch.phone = phone;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "city"
      )
    ) {
      patch.city =
        String(
          body.city || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "address"
      )
    ) {
      const address =
        String(
          body.address || ""
        ).trim();

      if (!address) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_ADDRESS_REQUIRED",
        });
      }

      patch.address =
        address;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "addressFull"
      )
    ) {
      patch.address_full =
        String(
          body.addressFull || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "description"
      )
    ) {
      patch.description =
        String(
          body.description || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "workHours"
      )
    ) {
      patch.work_hours =
        String(
          body.workHours || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "workSchedule"
      )
    ) {
      if (
        !Array.isArray(
          body.workSchedule
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_WORK_SCHEDULE_INVALID",
        });
      }

      patch.work_schedule =
        body.workSchedule;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "works24x7"
      )
    ) {
      patch.works_24_7 =
        body.works24x7 === true;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "priceVisible"
      )
    ) {
      patch.price_visible =
        body.priceVisible === true;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "onlineBookingEnabled"
      )
    ) {
      patch.online_booking_enabled =
        body.onlineBookingEnabled ===
        true;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "isActive"
      )
    ) {
      const isActive =
        body.isActive === true;

      patch.is_active =
        isActive;

      patch.status =
        isActive
          ? "active"
          : "inactive";
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "experienceYears"
      )
    ) {
      const value =
        Number(
          body.experienceYears
        );

      if (
        !Number.isFinite(value) ||
        value < 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_EXPERIENCE_INVALID",
        });
      }

      patch.experience_years =
        value;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "warrantyDays"
      )
    ) {
      const value =
        Number(
          body.warrantyDays
        );

      if (
        !Number.isFinite(value) ||
        value < 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_WARRANTY_INVALID",
        });
      }

      patch.warranty_days =
        value;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "siteUrl"
      )
    ) {
      patch.site_url =
        String(
          body.siteUrl || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "vkUrl"
      )
    ) {
      patch.vk_url =
        String(
          body.vkUrl || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "maxUrl"
      )
    ) {
      patch.max_url =
        String(
          body.maxUrl || ""
        ).trim();
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "latitude"
      )
    ) {
      const latitude =
        body.latitude == null ||
        body.latitude === ""
          ? null
          : Number(
              body.latitude
            );

      if (
        latitude != null &&
        (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LATITUDE_INVALID",
        });
      }

      patch.latitude =
        latitude;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "longitude"
      )
    ) {
      const longitude =
        body.longitude == null ||
        body.longitude === ""
          ? null
          : Number(
              body.longitude
            );

      if (
        longitude != null &&
        (
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LONGITUDE_INVALID",
        });
      }

      patch.longitude =
        longitude;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "timezone"
      )
    ) {
      patch.timezone =
        String(
          body.timezone || ""
        ).trim();
    }

    /*
     * Photo upload itself will be handled
     * separately. This endpoint accepts only
     * already stored/public photo URLs.
     */
    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "photo"
      )
    ) {
      const photo =
        String(
          body.photo || ""
        ).trim();

      patch.image =
        photo;

      patch.photo =
        photo;

      patch.photo_url =
        photo;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "gallery"
      )
    ) {
      if (
        !Array.isArray(
          body.gallery
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_GALLERY_INVALID",
        });
      }

      const gallery =
        body.gallery
          .map(
            (item) =>
              String(
                item || ""
              ).trim()
          )
          .filter(Boolean);

      patch.gallery =
        gallery;

      patch.photos =
        gallery;

      patch.images =
        gallery;
    }

    if (
      !Object.keys(patch).length
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "BUSINESS_CARD_PATCH_EMPTY",
      });
    }

    patch.updated_at =
      new Date().toISOString();

    const {
      data: updated,
      error: updateError,
    } = await supabase
      .from("stations")
      .update(
        patch
      )
      .eq(
        "id",
        businessId
      )
      .eq(
        "owner_id",
        userId
      )
      .select("*")
      .single();

    if (updateError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][CARD_UPDATE_ERROR]",
        {
          userId,
          businessId,
          code:
            updateError.code ||
            null,
          message:
            updateError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CARD_UPDATE_FAILED",
      });
    }

    return res.json({
      ok: true,

      business: {
        id:
          updated.id,

        name:
          updated.name ||
          "",

        legalName:
          updated.legal_name ||
          "",

        phone:
          updated.phone ||
          "",

        email:
          updated.email ||
          "",

        city:
          updated.city ||
          "",

        address:
          updated.address ||
          "",

        addressFull:
          updated.address_full ||
          updated.address ||
          "",

        latitude:
          updated.latitude == null
            ? null
            : Number(
                updated.latitude
              ),

        longitude:
          updated.longitude == null
            ? null
            : Number(
                updated.longitude
              ),

        timezone:
          updated.timezone ||
          "",

        workHours:
          updated.work_hours ||
          "",

        workSchedule:
          Array.isArray(
            updated.work_schedule
          )
            ? updated.work_schedule
            : [],

        works24x7:
          updated.works_24_7 === true,

        description:
          updated.description ||
          "",

        priceVisible:
          updated.price_visible === true,

        onlineBookingEnabled:
          updated.online_booking_enabled === true,

        experienceYears:
          Number(
            updated.experience_years ||
            0
          ),

        warrantyDays:
          Number(
            updated.warranty_days ||
            0
          ),

        photo:
          updated.photo_url ||
          updated.photo ||
          updated.image ||
          "",

        gallery:
          Array.isArray(
            updated.gallery
          )
            ? updated.gallery
            : [],

        siteUrl:
          updated.site_url ||
          "",

        vkUrl:
          updated.vk_url ||
          "",

        maxUrl:
          updated.max_url ||
          "",

        isActive:
          updated.is_active === true,

        status:
          updated.status ||
          "",

        updatedAt:
          updated.updated_at ||
          null,
      },
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][CARD_UPDATE_FATAL]",
      {
        userId,
        businessId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_CARD_UPDATE_FAILED",
    });
  }
});


app.get("/api/business/reviews", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * SECURITY:
     * Never trust a station id supplied by
     * the browser. Resolve every business
     * through the authenticated owner.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,name,legal_name,city,address"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVIEWS_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    const stationIds =
      ownedStations
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    /*
     * Reviews historically support both
     * target_type = station/business and
     * station_id. Fetch the owner's review
     * universe using both relationships,
     * then de-duplicate by review id.
     */
    const [
      stationReviewsResult,
      targetReviewsResult,
    ] = await Promise.all([
      supabase
        .from("reviews")
        .select(
          [
            "id",
            "target_type",
            "target_id",
            "author_id",
            "source_type",
            "source_id",
            "station_id",
            "stars",
            "text",
            "verified",
            "status",
            "created_at",
            "updated_at",
          ].join(",")
        )
        .in(
          "station_id",
          stationIds
        )
        .eq(
          "status",
          "published"
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        ),

      supabase
        .from("reviews")
        .select(
          [
            "id",
            "target_type",
            "target_id",
            "author_id",
            "source_type",
            "source_id",
            "station_id",
            "stars",
            "text",
            "verified",
            "status",
            "created_at",
            "updated_at",
          ].join(",")
        )
        .in(
          "target_type",
          [
            "station",
            "business",
          ]
        )
        .in(
          "target_id",
          stationIds
        )
        .eq(
          "status",
          "published"
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        ),
    ]);

    if (stationReviewsResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVIEWS_STATION_QUERY_ERROR]",
        {
          userId,
          stationIds,
          code:
            stationReviewsResult.error.code ||
            null,
          message:
            stationReviewsResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REVIEWS_LOAD_FAILED",
      });
    }

    if (targetReviewsResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVIEWS_TARGET_QUERY_ERROR]",
        {
          userId,
          stationIds,
          code:
            targetReviewsResult.error.code ||
            null,
          message:
            targetReviewsResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REVIEWS_LOAD_FAILED",
      });
    }

    const stationMap =
      new Map(
        ownedStations.map(
          (station) => [
            String(station.id),
            station,
          ]
        )
      );

    const reviewMap =
      new Map();

    [
      ...(Array.isArray(
        stationReviewsResult.data
      )
        ? stationReviewsResult.data
        : []),

      ...(Array.isArray(
        targetReviewsResult.data
      )
        ? targetReviewsResult.data
        : []),
    ].forEach((review) => {
      const reviewId =
        String(
          review?.id || ""
        ).trim();

      if (reviewId) {
        reviewMap.set(
          reviewId,
          review
        );
      }
    });

    const reviews =
      Array.from(
        reviewMap.values()
      )
        .map((review) => {
          const stationId =
            String(
              review?.station_id ||
              (
                [
                  "station",
                  "business",
                ].includes(
                  String(
                    review?.target_type ||
                    ""
                  )
                )
                  ? review?.target_id
                  : ""
              ) ||
              ""
            ).trim();

          const station =
            stationMap.get(
              stationId
            ) || null;

          return {
            id:
              review.id,

            stationId,

            stationName:
              station?.name ||
              station?.legal_name ||
              "Бизнес AUTODEAR",

            authorId:
              review.author_id ||
              null,

            sourceType:
              review.source_type ||
              null,

            sourceId:
              review.source_id ||
              null,

            stars:
              Number(
                review.stars ||
                0
              ),

            text:
              String(
                review.text ||
                ""
              ),

            verified:
              review.verified ===
              true,

            status:
              review.status ||
              "published",

            createdAt:
              review.created_at ||
              null,

            updatedAt:
              review.updated_at ||
              review.created_at ||
              null,
          };
        })
        .sort(
          (a, b) =>
            String(
              b.createdAt || ""
            ).localeCompare(
              String(
                a.createdAt || ""
              )
            )
        );

    const total =
      reviews.length;

    const verified =
      reviews.filter(
        (review) =>
          review.verified === true
      ).length;

    const rating =
      total
        ? Math.round(
            (
              reviews.reduce(
                (sum, review) =>
                  sum +
                  Number(
                    review.stars ||
                    0
                  ),
                0
              ) /
              total
            ) *
            10
          ) / 10
        : 0;

    return res.json({
      ok: true,

      summary: {
        total,
        verified,
        rating,
      },

      reviews,

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,

            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",

            city:
              station.city ||
              "",

            address:
              station.address ||
              "",
          })
        ),
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REVIEWS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REVIEWS_LOAD_FAILED",
    });
  }
});


app.patch("/api/business/reviews/read", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * SECURITY:
     * The browser does not send station ids.
     * Resolve businesses only through the
     * authenticated owner.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id,owner_id")
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVIEWS_READ_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const stationIds =
      (
        Array.isArray(stations)
          ? stations
          : []
      )
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    /*
     * Mark only unread review events belonging
     * to this authenticated owner's businesses.
     *
     * The review rows themselves are untouched.
     */
    const {
      data: updatedRows,
      error: updateError,
    } = await supabase
      .from("notifications")
      .update({
        is_read: true,
      })
      .eq(
        "recipient_role",
        "business"
      )
      .eq(
        "type",
        "business_new_review"
      )
      .eq(
        "is_read",
        false
      )
      .in(
        "recipient_id",
        stationIds
      )
      .select("id");

    if (updateError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVIEWS_READ_UPDATE_ERROR]",
        {
          userId,
          stationIds,
          code:
            updateError.code ||
            null,
          message:
            updateError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REVIEWS_MARK_READ_FAILED",
      });
    }

    const markedRead =
      Array.isArray(updatedRows)
        ? updatedRows.length
        : 0;

    console.log(
      "[AUTODEAR][WEB_BUSINESS][REVIEWS_MARKED_READ]",
      {
        userId,
        stationIds,
        markedRead,
      }
    );

    return res.json({
      ok: true,
      markedRead,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REVIEWS_READ_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REVIEWS_MARK_READ_FAILED",
    });
  }
});



app.get("/api/business/notifications", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * SECURITY:
     * Browser does not decide which business
     * notifications it is allowed to see.
     * Resolve stations from authenticated owner.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,name,legal_name"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][NOTIFICATIONS_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    const stationIds =
      ownedStations
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    /*
     * Reviews have their own section and badge.
     * Do not duplicate business_new_review here.
     */
    const {
      data: rows,
      error: notificationsError,
    } = await supabase
      .from("notifications")
      .select(
        [
          "id",
          "recipient_role",
          "recipient_id",
          "title",
          "body",
          "type",
          "related_type",
          "related_id",
          "is_read",
          "created_at",
        ].join(",")
      )
      .eq(
        "recipient_role",
        "business"
      )
      .neq(
        "type",
        "business_new_review"
      )
      .in(
        "recipient_id",
        stationIds
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(200);

    if (notificationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][NOTIFICATIONS_LOAD_ERROR]",
        {
          userId,
          stationIds,
          code:
            notificationsError.code ||
            null,
          message:
            notificationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_NOTIFICATIONS_LOAD_FAILED",
      });
    }

    const stationMap =
      new Map(
        ownedStations.map(
          (station) => [
            String(
              station.id
            ),
            station,
          ]
        )
      );

    const notifications =
      (
        Array.isArray(rows)
          ? rows
          : []
      ).map((row) => {
        const recipientId =
          String(
            row?.recipient_id || ""
          ).trim();

        const station =
          stationMap.get(
            recipientId
          ) || null;

        return {
          id:
            row.id,

          businessId:
            recipientId,

          businessName:
            station?.name ||
            station?.legal_name ||
            "Бизнес AUTODEAR",

          title:
            String(
              row?.title ||
              "Уведомление"
            ),

          body:
            String(
              row?.body || ""
            ),

          type:
            row?.type ||
            "system",

          relatedType:
            row?.related_type ||
            null,

          relatedId:
            row?.related_id ||
            null,

          isRead:
            row?.is_read === true,

          createdAt:
            row?.created_at ||
            null,
        };
      });

    const unread =
      notifications.filter(
        (item) =>
          item.isRead !== true
      ).length;

    return res.json({
      ok: true,

      summary: {
        total:
          notifications.length,

        unread,
      },

      notifications,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][NOTIFICATIONS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_NOTIFICATIONS_LOAD_FAILED",
    });
  }
});


app.patch(
  "/api/business/notifications/:id/read",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const authUser =
      authResult?.user || null;

    const userId =
      String(
        authUser?.id || ""
      ).trim();

    const notificationId =
      String(
        req.params?.id || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!notificationId) {
      return res.status(400).json({
        ok: false,
        error:
          "NOTIFICATION_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      const {
        data: stations,
        error: stationsError,
      } = await supabase
        .from("stations")
        .select("id")
        .eq(
          "owner_id",
          userId
        );

      if (stationsError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LOOKUP_FAILED",
        });
      }

      const stationIds =
        (
          Array.isArray(stations)
            ? stations
            : []
        )
          .map(
            (station) =>
              String(
                station?.id || ""
              ).trim()
          )
          .filter(Boolean);

      if (!stationIds.length) {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_ACCESS_REQUIRED",
        });
      }

      /*
       * Update succeeds only if notification
       * belongs to one of this owner's stations.
       */
      const {
        data: updatedRows,
        error: updateError,
      } = await supabase
        .from("notifications")
        .update({
          is_read: true,
        })
        .eq(
          "id",
          notificationId
        )
        .eq(
          "recipient_role",
          "business"
        )
        .neq(
          "type",
          "business_new_review"
        )
        .in(
          "recipient_id",
          stationIds
        )
        .select("id");

      if (updateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][NOTIFICATION_READ_ERROR]",
          {
            userId,
            notificationId,
            code:
              updateError.code ||
              null,
            message:
              updateError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_NOTIFICATION_READ_FAILED",
        });
      }

      if (
        !Array.isArray(
          updatedRows
        ) ||
        !updatedRows.length
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_NOTIFICATION_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        notificationId,
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][NOTIFICATION_READ_FATAL]",
        {
          userId,
          notificationId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_NOTIFICATION_READ_FAILED",
      });
    }
  }
);


app.patch(
  "/api/business/notifications/read-all",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const authUser =
      authResult?.user || null;

    const userId =
      String(
        authUser?.id || ""
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

    try {
      const {
        data: stations,
        error: stationsError,
      } = await supabase
        .from("stations")
        .select("id")
        .eq(
          "owner_id",
          userId
        );

      if (stationsError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LOOKUP_FAILED",
        });
      }

      const stationIds =
        (
          Array.isArray(stations)
            ? stations
            : []
        )
          .map(
            (station) =>
              String(
                station?.id || ""
              ).trim()
          )
          .filter(Boolean);

      if (!stationIds.length) {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_ACCESS_REQUIRED",
        });
      }

      const {
        data: updatedRows,
        error: updateError,
      } = await supabase
        .from("notifications")
        .update({
          is_read: true,
        })
        .eq(
          "recipient_role",
          "business"
        )
        .eq(
          "is_read",
          false
        )
        .neq(
          "type",
          "business_new_review"
        )
        .in(
          "recipient_id",
          stationIds
        )
        .select("id");

      if (updateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][NOTIFICATIONS_READ_ALL_ERROR]",
          {
            userId,
            stationIds,
            code:
              updateError.code ||
              null,
            message:
              updateError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_NOTIFICATIONS_READ_ALL_FAILED",
        });
      }

      return res.json({
        ok: true,

        markedRead:
          Array.isArray(
            updatedRows
          )
            ? updatedRows.length
            : 0,
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][NOTIFICATIONS_READ_ALL_FATAL]",
        {
          userId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_NOTIFICATIONS_READ_ALL_FAILED",
      });
    }
  }
);



app.get("/api/business/chats", async (req, res) => {
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

  try {
    /*
     * SECURITY:
     * A business sees only chats where
     * business_owner_id is the authenticated user.
     */
    const {
      data: rows,
      error,
    } = await supabase
      .from("chats")
      .select("*")
      .eq(
        "business_owner_id",
        userId
      )
      .order(
        "updated_at",
        {
          ascending: false,
        }
      )
      .limit(200);

    if (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][CHATS_LOAD_ERROR]",
        {
          userId,
          code:
            error.code || null,
          message:
            error.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CHATS_LOAD_FAILED",
      });
    }

    const chats =
      (
        Array.isArray(rows)
          ? rows
          : []
      ).map((row) => ({
        id:
          row.id,

        chatType:
          row.chat_type ||
          "service",

        stationId:
          row.station_id ||
          null,

        businessOwnerId:
          row.business_owner_id ||
          null,

        userId:
          row.user_id ||
          null,

        buyerId:
          row.buyer_id ||
          null,

        sellerId:
          row.seller_id ||
          null,

        userName:
          row.user_name ||
          "Клиент AUTODEAR",

        userPhone:
          row.user_phone ||
          null,

        userAvatarUrl:
          row.user_avatar_url ||
          null,

        businessPhoto:
          row.business_photo ||
          null,

        businessAvatarUrl:
          row.business_avatar_url ||
          null,

        sellerAvatarUrl:
          row.seller_avatar_url ||
          null,

        sellerName:
          row.seller_name ||
          null,

        listingId:
          row.listing_id ||
          null,

        listingTitle:
          row.listing_title ||
          null,

        listingPrice:
          row.listing_price ||
          null,

        lastMessage:
          row.last_message ||
          "",

        unread:
          Number(
            row.business_unread ||
            0
          ),

        userTyping:
          Boolean(
            row.user_typing
          ),

        businessTyping:
          Boolean(
            row.business_typing
          ),

        userLastSeen:
          row.user_last_seen ||
          null,

        businessLastSeen:
          row.business_last_seen ||
          null,

        userInChat:
          Boolean(
            row.user_in_chat
          ),

        businessInChat:
          Boolean(
            row.business_in_chat
          ),

        updatedAt:
          row.updated_at ||
          null,

        archivedBy:
          Array.isArray(
            row.archived_by
          )
            ? row.archived_by
            : [],
      }));

    return res.json({
      ok: true,
      chats,
      count:
        chats.length,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][CHATS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_CHATS_LOAD_FAILED",
    });
  }
});


/*
 * Web business chat presence.
 *
 * The browser uses the same `chats` presence fields
 * as the mobile application:
 *
 * business_typing
 * business_last_seen
 * business_in_chat
 */
app.patch(
  "/api/business/chats/:chatId/presence",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    const chatId =
      String(
        req.params?.chatId || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error:
          "CHAT_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      const {
        data: chat,
        error: chatError,
      } = await supabase
        .from("chats")
        .select(
          "id,business_owner_id"
        )
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        )
        .maybeSingle();

      if (chatError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][PRESENCE_LOOKUP_ERROR]",
          {
            userId,
            chatId,
            code:
              chatError.code || null,
            message:
              chatError.message || null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_LOOKUP_FAILED",
        });
      }

      if (!chat) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_CHAT_NOT_FOUND",
        });
      }

      const patch = {
        business_last_seen:
          new Date().toISOString(),
      };

      if (
        typeof req.body?.typing ===
        "boolean"
      ) {
        patch.business_typing =
          req.body.typing;
      }

      if (
        typeof req.body?.inChat ===
        "boolean"
      ) {
        patch.business_in_chat =
          req.body.inChat;
      }

      const {
        data: updated,
        error: updateError,
      } = await supabase
        .from("chats")
        .update(patch)
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        )
        .select(
          "id,business_typing,business_last_seen,business_in_chat"
        )
        .maybeSingle();

      if (updateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][PRESENCE_UPDATE_ERROR]",
          {
            userId,
            chatId,
            code:
              updateError.code || null,
            message:
              updateError.message || null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_PRESENCE_UPDATE_FAILED",
        });
      }

      return res.json({
        ok: true,

        presence: {
          businessTyping:
            Boolean(
              updated?.business_typing
            ),

          businessLastSeen:
            updated?.business_last_seen ||
            null,

          businessInChat:
            Boolean(
              updated?.business_in_chat
            ),
        },
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][PRESENCE_FATAL]",
        {
          userId,
          chatId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CHAT_PRESENCE_FAILED",
      });
    }
  }
);


app.get(
  "/api/business/chats/:chatId/messages",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    const chatId =
      String(
        req.params?.chatId || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error:
          "CHAT_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      const {
        data: chat,
        error: chatError,
      } = await supabase
        .from("chats")
        .select("*")
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        )
        .maybeSingle();

      if (chatError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_LOOKUP_FAILED",
        });
      }

      if (!chat) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_CHAT_NOT_FOUND",
        });
      }

      const {
        data: rows,
        error: messagesError,
      } = await supabase
        .from("chat_messages")
        .select("*")
        .eq(
          "chat_id",
          chatId
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        )
        .limit(1000);

      if (messagesError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][MESSAGES_LOAD_ERROR]",
          {
            userId,
            chatId,
            code:
              messagesError.code ||
              null,
            message:
              messagesError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_MESSAGES_LOAD_FAILED",
        });
      }

      const messages =
        (
          Array.isArray(rows)
            ? rows
            : []
        )
          .filter((row) => {
            if (
              row?.deleted_for_everyone ===
              true
            ) {
              return false;
            }

            const hiddenFor =
              Array.isArray(
                row?.hidden_for
              )
                ? row.hidden_for.map(
                    String
                  )
                : [];

            return !hiddenFor.includes(
              userId
            );
          })
          .map((row) => ({
            id:
              row.id,

            chatId:
              row.chat_id,

            senderId:
              row.sender_id,

            senderRole:
              row.sender_role ||
              null,

            text:
              row.text ||
              "",

            attachments:
              Array.isArray(
                row.attachments
              )
                ? row.attachments
                : [],

            status:
              row.status ||
              "sent",

            deliveredAt:
              row.delivered_at ||
              null,

            readAt:
              row.read_at ||
              null,

            createdAt:
              row.created_at ||
              null,
          }));

      return res.json({
        ok: true,

        chat: {
          id:
            chat.id,

          userId:
            chat.user_id ||
            null,

          userName:
            chat.user_name ||
            "Клиент AUTODEAR",

          userPhone:
            chat.user_phone ||
            null,

          userAvatarUrl:
            chat.user_avatar_url ||
            null,

          listingTitle:
            chat.listing_title ||
            null,

          chatType:
            chat.chat_type ||
            "service",
        },

        messages,
        count:
          messages.length,
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][MESSAGES_FATAL]",
        {
          userId,
          chatId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_MESSAGES_LOAD_FAILED",
      });
    }
  }
);


app.post(
  "/api/business/chats/:chatId/messages",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    const chatId =
      String(
        req.params?.chatId || ""
      ).trim();

    const text =
      String(
        req.body?.text || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error:
          "CHAT_ID_REQUIRED",
      });
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        error:
          "MESSAGE_TEXT_REQUIRED",
      });
    }

    if (text.length > 10000) {
      return res.status(400).json({
        ok: false,
        error:
          "MESSAGE_TEXT_TOO_LONG",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      const {
        data: chat,
        error: chatError,
      } = await supabase
        .from("chats")
        .select("*")
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        )
        .maybeSingle();

      if (chatError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_LOOKUP_FAILED",
        });
      }

      if (!chat) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_CHAT_NOT_FOUND",
        });
      }

      const now =
        new Date().toISOString();

      const messageId =
        `web_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;

      const {
        data: message,
        error: insertError,
      } = await supabase
        .from("chat_messages")
        .insert({
          id:
            messageId,

          chat_id:
            chatId,

          sender_id:
            userId,

          sender_role:
            "business",

          text,

          attachments:
            [],

          status:
            "sent",

          created_at:
            now,
        })
        .select("*")
        .single();

      if (insertError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][MESSAGE_SEND_ERROR]",
          {
            userId,
            chatId,
            code:
              insertError.code ||
              null,
            message:
              insertError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_MESSAGE_SEND_FAILED",
        });
      }

      const {
        error: chatUpdateError,
      } = await supabase
        .from("chats")
        .update({
          last_message:
            text,

          updated_at:
            now,

          user_unread:
            1,

          business_unread:
            0,

          unread:
            1,
        })
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        );

      if (chatUpdateError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][MESSAGE_CHAT_UPDATE_ERROR]",
          {
            userId,
            chatId,
            code:
              chatUpdateError.code ||
              null,
            message:
              chatUpdateError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_MESSAGE_CHAT_UPDATE_FAILED",
        });
      }

      return res.json({
        ok: true,

        message: {
          id:
            message.id,

          chatId:
            message.chat_id,

          senderId:
            message.sender_id,

          senderRole:
            message.sender_role,

          text:
            message.text,

          attachments:
            Array.isArray(
              message.attachments
            )
              ? message.attachments
              : [],

          status:
            message.status ||
            "sent",

          createdAt:
            message.created_at ||
            now,
        },
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][MESSAGE_SEND_FATAL]",
        {
          userId,
          chatId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_MESSAGE_SEND_FAILED",
      });
    }
  }
);


app.post(
  "/api/business/chats/:chatId/read",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(req);

    const userId =
      String(
        authResult?.user?.id || ""
      ).trim();

    const chatId =
      String(
        req.params?.chatId || ""
      ).trim();

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error:
          "CHAT_ID_REQUIRED",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error:
          "SUPABASE_NOT_CONFIGURED",
      });
    }

    try {
      const {
        data: chat,
        error: chatError,
      } = await supabase
        .from("chats")
        .select(
          "id,business_owner_id"
        )
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        )
        .maybeSingle();

      if (chatError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_LOOKUP_FAILED",
        });
      }

      if (!chat) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_CHAT_NOT_FOUND",
        });
      }

      const now =
        new Date().toISOString();

      const {
        error: messagesError,
      } = await supabase
        .from("chat_messages")
        .update({
          status:
            "read",

          delivered_at:
            now,

          read_at:
            now,
        })
        .eq(
          "chat_id",
          chatId
        )
        .neq(
          "sender_id",
          userId
        );

      if (messagesError) {
        console.error(
          "[AUTODEAR][WEB_BUSINESS][MESSAGE_READ_ERROR]",
          messagesError
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_MESSAGES_READ_FAILED",
        });
      }

      const {
        error: chatUpdateError,
      } = await supabase
        .from("chats")
        .update({
          business_unread:
            0,
        })
        .eq(
          "id",
          chatId
        )
        .eq(
          "business_owner_id",
          userId
        );

      if (chatUpdateError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CHAT_READ_FAILED",
        });
      }

      return res.json({
        ok: true,
        chatId,
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][CHAT_READ_FATAL]",
        {
          userId,
          chatId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CHAT_READ_FAILED",
      });
    }
  }
);


app.get("/api/business/signals", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * SECURITY:
     * Browser never supplies business ids.
     * Resolve every business from the
     * authenticated Supabase owner first.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,owner_id,name,legal_name"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SIGNALS_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    if (!ownedStations.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const stationIds =
      ownedStations
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    /*
     * New client requests:
     *
     * A new AUTODEAR request lives in
     * business_requests until the business
     * confirms it.
     *
     * Only after confirmation does the mobile
     * bridge create business_bookings.
     *
     * Therefore the "Записи" badge must count
     * NEW requests, not calendar bookings.
     */
    const bookingsPromise =
      supabase
        .from("business_requests")
        .select(
          "id",
          {
            count: "exact",
            head: true,
          }
        )
        .in(
          "business_id",
          stationIds
        )
        .eq(
          "status",
          "new"
        );

    /*
     * Unread business chats:
     * chats use business_owner_id = auth user id.
     *
     * We count conversations requiring attention,
     * not the number of individual messages.
     */
    const messagesPromise =
      supabase
        .from("chats")
        .select(
          "id",
          {
            count: "exact",
            head: true,
          }
        )
        .eq(
          "business_owner_id",
          userId
        )
        .gt(
          "business_unread",
          0
        );

    /*
     * Business notifications:
     * recipient_id is the concrete station/business id.
     *
     * Global business notifications with recipient_id NULL
     * are intentionally NOT included here because they are
     * not tied to a specific authenticated business yet.
     */
    /*
     * New business reviews are stored as
     * dedicated unread notification events.
     *
     * Keep them separate from the generic
     * notifications counter so one review
     * does not light up two menu badges.
     */
    const reviewsPromise =
      supabase
        .from("notifications")
        .select(
          "id",
          {
            count: "exact",
            head: true,
          }
        )
        .eq(
          "recipient_role",
          "business"
        )
        .eq(
          "is_read",
          false
        )
        .eq(
          "type",
          "business_new_review"
        )
        .in(
          "recipient_id",
          stationIds
        );

    const notificationsPromise =
      supabase
        .from("notifications")
        .select(
          "id",
          {
            count: "exact",
            head: true,
          }
        )
        .eq(
          "recipient_role",
          "business"
        )
        .eq(
          "is_read",
          false
        )
        .neq(
          "type",
          "business_new_review"
        )
        .in(
          "recipient_id",
          stationIds
        );

    const [
      bookingsResult,
      messagesResult,
      reviewsResult,
      notificationsResult,
    ] = await Promise.all([
      bookingsPromise,
      messagesPromise,
      reviewsPromise,
      notificationsPromise,
    ]);

    if (bookingsResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SIGNALS_BOOKINGS_ERROR]",
        {
          userId,
          stationIds,
          code:
            bookingsResult.error.code ||
            null,
          message:
            bookingsResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SIGNALS_BOOKINGS_FAILED",
      });
    }

    if (messagesResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SIGNALS_MESSAGES_ERROR]",
        {
          userId,
          code:
            messagesResult.error.code ||
            null,
          message:
            messagesResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SIGNALS_MESSAGES_FAILED",
      });
    }

    if (reviewsResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SIGNALS_REVIEWS_ERROR]",
        {
          userId,
          stationIds,
          code:
            reviewsResult.error.code ||
            null,
          message:
            reviewsResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SIGNALS_REVIEWS_FAILED",
      });
    }

    if (notificationsResult.error) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][SIGNALS_NOTIFICATIONS_ERROR]",
        {
          userId,
          stationIds,
          code:
            notificationsResult.error.code ||
            null,
          message:
            notificationsResult.error.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_SIGNALS_NOTIFICATIONS_FAILED",
      });
    }

    const signals = {
      bookings:
        Number(
          bookingsResult.count ||
          0
        ),

      messages:
        Number(
          messagesResult.count ||
          0
        ),

      reviews:
        Number(
          reviewsResult.count ||
          0
        ),

      notifications:
        Number(
          notificationsResult.count ||
          0
        ),
    };

    return res.json({
      ok: true,

      signals,

      total:
        signals.bookings +
        signals.messages +
        signals.reviews +
        signals.notifications,

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,

            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",
          })
        ),
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][SIGNALS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_SIGNALS_FAILED",
    });
  }
});



/*
 * AUTODEAR WEB BUSINESS REVENUE
 *
 * Источник истины:
 * public.business_revenue_entries
 *
 * Безопасность:
 * браузер не выбирает произвольный business_id.
 * Сначала определяем станции текущего пользователя.
 */

app.get("/api/business/revenue", async (req, res) => {
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

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,name,legal_name"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVENUE_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code || null,
          message:
            stationsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    if (!ownedStations.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const stationIds =
      ownedStations
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    const {
      data: entries,
      error: entriesError,
    } = await supabase
      .from("business_revenue_entries")
      .select("*")
      .in(
        "business_id",
        stationIds
      )
      .order(
        "earned_at",
        {
          ascending: false,
        }
      )
      .limit(1000);

    if (entriesError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVENUE_LOAD_ERROR]",
        {
          userId,
          stationIds,
          code:
            entriesError.code || null,
          message:
            entriesError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REVENUE_LOAD_FAILED",
      });
    }

    const rows =
      Array.isArray(entries)
        ? entries
        : [];

    const now =
      new Date();

    const localDateKey =
      (value) => {
        const d =
          new Date(value);

        if (
          Number.isNaN(
            d.getTime()
          )
        ) {
          return "";
        }

        const year =
          d.getUTCFullYear();

        const month =
          String(
            d.getUTCMonth() + 1
          ).padStart(2, "0");

        const day =
          String(
            d.getUTCDate()
          ).padStart(2, "0");

        return `${year}-${month}-${day}`;
      };

    const todayKey =
      localDateKey(now);

    const monthKey =
      todayKey.slice(0, 7);

    let totalKopecks = 0;
    let todayKopecks = 0;
    let monthKopecks = 0;
    let autodearKopecks = 0;
    let manualKopecks = 0;

    for (const row of rows) {
      const amount =
        Number(
          row?.amount_kopecks ||
          0
        );

      totalKopecks += amount;

      const earnedKey =
        localDateKey(
          row?.earned_at
        );

      if (
        earnedKey ===
        todayKey
      ) {
        todayKopecks +=
          amount;
      }

      if (
        earnedKey.startsWith(
          monthKey
        )
      ) {
        monthKopecks +=
          amount;
      }

      if (
        row?.source ===
        "autodear"
      ) {
        autodearKopecks +=
          amount;
      } else {
        manualKopecks +=
          amount;
      }
    }

    return res.json({
      ok: true,

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,

            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",
          })
        ),

      summary: {
        totalKopecks,
        todayKopecks,
        monthKopecks,
        autodearKopecks,
        manualKopecks,
        operations:
          rows.length,
      },

      entries:
        rows.map(
          (row) => ({
            id:
              row.id,

            businessId:
              row.business_id,

            bookingId:
              row.booking_id ||
              null,

            source:
              row.source ||
              "manual",

            customerId:
              row.customer_id ||
              null,

            customerName:
              row.customer_name ||
              "Клиент",

            service:
              row.service ||
              "",

            car:
              row.car ||
              "",

            amountKopecks:
              Number(
                row.amount_kopecks ||
                0
              ),

            earnedAt:
              row.earned_at ||
              null,

            note:
              row.note ||
              "",

            createdAt:
              row.created_at ||
              null,

            updatedAt:
              row.updated_at ||
              null,
          })
        ),
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REVENUE_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REVENUE_FAILED",
    });
  }
});


app.post("/api/business/revenue", async (req, res) => {
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

  const bookingId =
    String(
      req.body?.bookingId || ""
    ).trim();

  const requestedBusinessId =
    String(
      req.body?.businessId || ""
    ).trim();

  const amountKopecks =
    Number(
      req.body?.amountKopecks
    );

  const manualSource =
    String(
      req.body?.source ||
      "manual"
    )
      .trim()
      .toLowerCase();

  const customerName =
    String(
      req.body?.customerName ||
      ""
    ).trim();

  const service =
    String(
      req.body?.service ||
      ""
    ).trim();

  const car =
    String(
      req.body?.car ||
      ""
    ).trim();

  const note =
    String(
      req.body?.note ||
      ""
    ).trim();

  if (
    !Number.isInteger(
      amountKopecks
    ) ||
    amountKopecks <= 0
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "REVENUE_AMOUNT_INVALID",
    });
  }

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id")
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const stationIds =
      (
        Array.isArray(stations)
          ? stations
          : []
      )
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    let businessId = "";
    let source = "manual";
    let customerId = null;
    let finalCustomerName =
      customerName;
    let finalService =
      service;
    let finalCar =
      car;

    if (bookingId) {
      const {
        data: booking,
        error: bookingError,
      } = await supabase
        .from("business_bookings")
        .select("*")
        .eq(
          "id",
          bookingId
        )
        .in(
          "business_id",
          stationIds
        )
        .maybeSingle();

      if (bookingError) {
        return res.status(500).json({
          ok: false,
          error:
            "BOOKING_LOOKUP_FAILED",
        });
      }

      if (!booking) {
        return res.status(404).json({
          ok: false,
          error:
            "BOOKING_NOT_FOUND",
        });
      }

      if (
        booking.status !==
        "completed"
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "BOOKING_NOT_COMPLETED",
        });
      }

      businessId =
        String(
          booking.business_id
        );

      source =
        booking.source ===
        "autodear"
          ? "autodear"
          : "manual";

      customerId =
        booking.customer_id ||
        null;

      finalCustomerName =
        booking.customer_name ||
        customerName ||
        "";

      finalService =
        booking.service ||
        service ||
        "";

      finalCar =
        booking.car ||
        car ||
        "";

    } else {
      if (
        !stationIds.includes(
          requestedBusinessId
        )
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_ACCESS_REQUIRED",
        });
      }

      if (
        manualSource !==
        "manual"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "REVENUE_SOURCE_INVALID",
        });
      }

      businessId =
        requestedBusinessId;

      source =
        "manual";
    }

    const now =
      new Date().toISOString();

    const entryId =
      `revenue_${crypto.randomUUID()}`;

    const {
      data: inserted,
      error: insertError,
    } = await supabase
      .from("business_revenue_entries")
      .insert({
        id:
          entryId,

        business_id:
          businessId,

        booking_id:
          bookingId ||
          null,

        source,

        customer_id:
          customerId,

        customer_name:
          finalCustomerName,

        service:
          finalService,

        car:
          finalCar,

        amount_kopecks:
          amountKopecks,

        earned_at:
          now,

        note,

        created_by:
          userId,

        created_at:
          now,

        updated_at:
          now,
      })
      .select("*")
      .single();

    if (insertError) {
      const duplicate =
        insertError.code ===
        "23505";

      if (duplicate) {
        return res.status(409).json({
          ok: false,
          error:
            "REVENUE_ALREADY_RECORDED",
        });
      }

      console.error(
        "[AUTODEAR][WEB_BUSINESS][REVENUE_CREATE_ERROR]",
        {
          userId,
          bookingId:
            bookingId ||
            null,
          code:
            insertError.code ||
            null,
          message:
            insertError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REVENUE_CREATE_FAILED",
      });
    }

    return res.status(201).json({
      ok: true,

      entry: {
        id:
          inserted.id,

        businessId:
          inserted.business_id,

        bookingId:
          inserted.booking_id ||
          null,

        source:
          inserted.source,

        customerName:
          inserted.customer_name ||
          "",

        service:
          inserted.service ||
          "",

        car:
          inserted.car ||
          "",

        amountKopecks:
          Number(
            inserted.amount_kopecks ||
            0
          ),

        earnedAt:
          inserted.earned_at ||
          null,

        note:
          inserted.note ||
          "",
      },
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REVENUE_CREATE_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REVENUE_CREATE_FAILED",
    });
  }
});


/*
 * WEB BUSINESS — CLIENT REQUESTS
 *
 * Returns AUTODEAR client requests belonging only
 * to stations owned by the authenticated user.
 *
 * SECURITY:
 * The browser does not supply business_id.
 * Station ids are resolved from auth user -> stations.
 */
app.get("/api/business/requests", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,owner_id,name,legal_name"
      )
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUESTS_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code || null,
          message:
            stationsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    if (!ownedStations.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const stationIds =
      ownedStations
        .map(
          (station) =>
            String(
              station?.id || ""
            ).trim()
        )
        .filter(Boolean);

    const {
      data: requests,
      error: requestsError,
    } = await supabase
      .from("business_requests")
      .select("*")
      .in(
        "business_id",
        stationIds
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      );

    if (requestsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUESTS_ERROR]",
        {
          userId,
          stationIds,
          code:
            requestsError.code || null,
          message:
            requestsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REQUESTS_LOAD_FAILED",
      });
    }

    const rows =
      Array.isArray(requests)
        ? requests
        : [];

    return res.json({
      ok: true,

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,
            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",
          })
        ),

      requests:
        rows.map(
          (request) => ({
            id:
              request.id,

            businessId:
              request.business_id,

            stationId:
              request.station_id ||
              request.business_id,

            businessName:
              request.business_name ||
              "",

            customerId:
              request.customer_id ||
              "",

            customerName:
              request.customer_name ||
              "Клиент AUTODEAR",

            customerPhone:
              request.customer_phone ||
              "",

            car:
              request.car ||
              "",

            carYear:
              request.car_year ||
              "",

            plate:
              request.plate ||
              "",

            vin:
              request.vin ||
              "",

            service:
              request.service ||
              "",

            serviceCategory:
              request.service_category ||
              "",

            serviceReason:
              request.service_reason ||
              "",

            date:
              request.date ||
              "",

            time:
              request.time ||
              "",

            comment:
              request.comment ||
              "",

            status:
              request.status ||
              "new",

            createdAt:
              request.created_at ||
              null,
          })
        ),
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REQUESTS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REQUESTS_LOAD_FAILED",
    });
  }
});



/*
 * WEB BUSINESS — CONFIRM CLIENT REQUEST
 * 20260825
 *
 * business_requests:
 *   new -> confirmed
 *
 * Confirmation also creates exactly one
 * business_bookings row for the request.
 *
 * SECURITY:
 * - browser never chooses business_id;
 * - authenticated user must own the station;
 * - request must belong to that station.
 *
 * IDEMPOTENCY:
 * request_id links the request to its calendar
 * booking. Repeated confirmation reuses the
 * existing booking instead of creating a duplicate.
 */

/*
 * WEB BUSINESS — CANCEL INCOMING REQUEST
 *
 * Входящая заявка ещё не является business_booking.
 * Поэтому отменяем её непосредственно в
 * business_requests.
 *
 * В модели мобильного приложения отмена бизнесом
 * соответствует status = "rejected".
 */
app.patch("/api/business/requests/:id/cancel", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const userId =
    String(
      authResult?.user?.id || ""
    ).trim();

  const requestId =
    String(
      req.params?.id || ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!requestId) {
    return res.status(400).json({
      ok: false,
      error:
        "REQUEST_ID_REQUIRED",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        "SUPABASE_NOT_CONFIGURED",
    });
  }

  try {
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id")
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const stationIds =
      (
        Array.isArray(stations)
          ? stations
          : []
      )
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const {
      data: request,
      error: requestError,
    } = await supabase
      .from("business_requests")
      .select(
        "id,business_id,status"
      )
      .eq(
        "id",
        requestId
      )
      .in(
        "business_id",
        stationIds
      )
      .maybeSingle();

    if (requestError) {
      return res.status(500).json({
        ok: false,
        error:
          "REQUEST_LOOKUP_FAILED",
      });
    }

    if (!request) {
      return res.status(404).json({
        ok: false,
        error:
          "REQUEST_NOT_FOUND",
      });
    }

    if (
      request.status !== "new" &&
      request.status !== "rescheduled"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "REQUEST_STATUS_INVALID",
      });
    }

    const {
      data: updatedRequest,
      error: updateError,
    } = await supabase
      .from("business_requests")
      .update({
        status: "rejected",
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        requestId
      )
      .in(
        "business_id",
        stationIds
      )
      .select("*")
      .single();

    if (
      updateError ||
      !updatedRequest
    ) {
      return res.status(500).json({
        ok: false,
        error:
          "REQUEST_CANCEL_FAILED",
      });
    }

    return res.json({
      ok: true,
      request: updatedRequest,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REQUEST_CANCEL]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "REQUEST_CANCEL_FAILED",
    });
  }
});


app.patch("/api/business/requests/:id/confirm", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
    ).trim();

  const requestId =
    String(
      req.params?.id || ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!requestId) {
    return res.status(400).json({
      ok: false,
      error:
        "REQUEST_ID_REQUIRED",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        "SUPABASE_NOT_CONFIGURED",
    });
  }

  try {
    /*
     * Resolve stations from authenticated owner.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id")
      .eq(
        "owner_id",
        userId
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code || null,
          message:
            stationsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const stationIds =
      (
        Array.isArray(stations)
          ? stations
          : []
      )
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    /*
     * The request itself determines the station.
     */
    const {
      data: request,
      error: requestError,
    } = await supabase
      .from("business_requests")
      .select("*")
      .eq(
        "id",
        requestId
      )
      .in(
        "business_id",
        stationIds
      )
      .maybeSingle();

    if (requestError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_LOOKUP_ERROR]",
        {
          userId,
          requestId,
          code:
            requestError.code || null,
          message:
            requestError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REQUEST_LOOKUP_FAILED",
      });
    }

    if (!request) {
      return res.status(404).json({
        ok: false,
        error:
          "BUSINESS_REQUEST_NOT_FOUND",
      });
    }

    const businessId =
      String(
        request.station_id ||
        request.business_id ||
        ""
      ).trim();

    if (
      !businessId ||
      !stationIds.includes(
        businessId
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    /*
     * First check whether this request already has
     * a calendar booking.
     */
    const {
      data: existingBooking,
      error: existingBookingError,
    } = await supabase
      .from("business_bookings")
      .select("*")
      .eq(
        "request_id",
        requestId
      )
      .in(
        "business_id",
        stationIds
      )
      .maybeSingle();

    if (existingBookingError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_BOOKING_LOOKUP_ERROR]",
        {
          userId,
          requestId,
          code:
            existingBookingError.code ||
            null,
          message:
            existingBookingError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BOOKING_LOOKUP_FAILED",
      });
    }

    let booking =
      existingBooking || null;

    /*
     * Create calendar booking only once.
     */
    if (!booking) {
      const now =
        new Date().toISOString();

      const bookingId =
        `booking_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;

      const bookingDate =
        String(
          request.date || ""
        )
          .trim()
          .slice(0, 10);

      const startTime =
        String(
          request.time || ""
        )
          .trim()
          .slice(0, 5);

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          bookingDate
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_DATE_INVALID",
        });
      }

      if (
        !/^\d{2}:\d{2}$/.test(
          startTime
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_TIME_INVALID",
        });
      }

      const {
        data: createdBooking,
        error: createBookingError,
      } = await supabase
        .from("business_bookings")
        .insert({
          id:
            bookingId,

          business_id:
            businessId,

          request_id:
            requestId,

          customer_id:
            request.customer_id ||
            null,

          customer_name:
            request.customer_name ||
            "Клиент AUTODEAR",

          customer_phone:
            "",

          car:
            request.car ||
            "",

          plate:
            "",

          vin:
            request.vin ||
            "",

          service:
            request.service ||
            "",

          comment:
            request.comment ||
            "",

          booking_date:
            bookingDate,

          start_time:
            startTime,

          duration_minutes:
            60,

          post_number:
            1,

          source:
            "autodear",

          status:
            "confirmed",

          customer_confirmation_status:
            "confirmed",

          customer_confirmed_at:
            now,

          created_by:
            request.customer_id ||
            null,

          updated_at:
            now,
        })
        .select("*")
        .single();

      if (createBookingError) {
        const isConflict =
          createBookingError.code ===
            "23P01" ||
          String(
            createBookingError.message ||
            ""
          ).includes(
            "business_bookings_no_overlap"
          );

        if (isConflict) {
          return res.status(409).json({
            ok: false,
            error:
              "BOOKING_CONFLICT",
          });
        }

        /*
         * If request_id is protected by UNIQUE,
         * another confirmation may have created
         * the booking between lookup and insert.
         */
        if (
          createBookingError.code ===
          "23505"
        ) {
          const {
            data: duplicateBooking,
            error: duplicateLookupError,
          } = await supabase
            .from("business_bookings")
            .select("*")
            .eq(
              "request_id",
              requestId
            )
            .in(
              "business_id",
              stationIds
            )
            .maybeSingle();

          if (
            !duplicateLookupError &&
            duplicateBooking
          ) {
            booking =
              duplicateBooking;
          } else {
            console.error(
              "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_DUPLICATE_LOOKUP_ERROR]",
              {
                userId,
                requestId,
                createCode:
                  createBookingError.code ||
                  null,
                createMessage:
                  createBookingError.message ||
                  null,
              }
            );

            return res.status(500).json({
              ok: false,
              error:
                "BOOKING_CREATE_FAILED",
            });
          }
        } else {
          console.error(
            "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_BOOKING_CREATE_ERROR]",
            {
              userId,
              requestId,
              businessId,
              code:
                createBookingError.code ||
                null,
              message:
                createBookingError.message ||
                null,
            }
          );

          return res.status(500).json({
            ok: false,
            error:
              "BOOKING_CREATE_FAILED",
          });
        }
      } else {
        booking =
          createdBooking;
      }
    }

    /*
     * Calendar booking exists now.
     * Only now may the request become confirmed.
     */
    const {
      data: updatedRequest,
      error: requestUpdateError,
    } = await supabase
      .from("business_requests")
      .update({
        status:
          "confirmed",
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        requestId
      )
      .in(
        "business_id",
        stationIds
      )
      .select("*")
      .single();

    if (requestUpdateError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_UPDATE_ERROR]",
        {
          userId,
          requestId,
          code:
            requestUpdateError.code ||
            null,
          message:
            requestUpdateError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_REQUEST_UPDATE_FAILED",
      });
    }

    console.log(
      "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRMED]",
      {
        userId,
        requestId,
        businessId,
        bookingId:
          booking?.id || null,
      }
    );

    return res.json({
      ok: true,

      request: {
        id:
          updatedRequest.id,
        status:
          updatedRequest.status,
        businessId:
          updatedRequest.business_id,
      },

      booking: {
        id:
          booking?.id || null,

        businessId:
          booking?.business_id ||
          businessId,

        requestId:
          booking?.request_id ||
          requestId,

        customerName:
          booking?.customer_name ||
          request.customer_name ||
          "Клиент AUTODEAR",

        service:
          booking?.service ||
          request.service ||
          "",

        date:
          booking?.booking_date ||
          request.date ||
          "",

        startTime:
          booking?.start_time ||
          request.time ||
          "",

        source:
          booking?.source ||
          "autodear",

        status:
          booking?.status ||
          "confirmed",
      },
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][REQUEST_CONFIRM_FATAL]",
      {
        userId,
        requestId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_REQUEST_CONFIRM_FAILED",
    });
  }
});


app.get("/api/business/bookings", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    /*
     * SECURITY:
     * The browser never chooses business_id.
     * We first resolve stations owned by the
     * authenticated Supabase user.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id,owner_id,name,legal_name")
      .eq("owner_id", userId);

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][BOOKINGS_STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code || null,
          message:
            stationsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    if (!ownedStations.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const stationIds =
      ownedStations
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    const {
      data: bookings,
      error: bookingsError,
    } = await supabase
      .from("business_bookings")
      .select("*")
      .in(
        "business_id",
        stationIds
      )
      .order(
        "booking_date",
        {
          ascending: true,
        }
      )
      .order(
        "start_time",
        {
          ascending: true,
        }
      );

    if (bookingsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][BOOKINGS_ERROR]",
        {
          userId,
          stationIds,
          code:
            bookingsError.code || null,
          message:
            bookingsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_BOOKINGS_LOAD_FAILED",
      });
    }

    const rows =
      Array.isArray(bookings)
        ? bookings
        : [];

    return res.json({
      ok: true,

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,
            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",
          })
        ),

      bookings:
        rows.map(
          (booking) => ({
            id:
              booking.id,

            businessId:
              booking.business_id,

            requestId:
              booking.request_id ||
              null,

            customerId:
              booking.customer_id ||
              null,

            customerName:
              booking.customer_name ||
              "Клиент AUTODEAR",

            customerPhone:
              booking.customer_phone ||
              null,

            car:
              booking.car ||
              null,

            plate:
              booking.plate ||
              null,

            vin:
              booking.vin ||
              null,

            service:
              booking.service ||
              null,

            comment:
              booking.comment ||
              null,

            date:
              booking.booking_date ||
              null,

            startTime:
              booking.start_time ||
              null,

            durationMinutes:
              Number(
                booking.duration_minutes ||
                60
              ),

            postNumber:
              Number(
                booking.post_number ||
                1
              ),

            source:
              booking.source ||
              null,

            status:
              booking.status ||
              "confirmed",

            customerConfirmationStatus:
              booking.customer_confirmation_status ||
              null,

            createdAt:
              booking.created_at ||
              null,

            updatedAt:
              booking.updated_at ||
              null,
          })
        ),

      count:
        rows.length,
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][BOOKINGS_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BUSINESS_BOOKINGS_FAILED",
    });
  }
});



app.patch("/api/business/bookings/:id", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
    ).trim();

  const bookingId =
    String(
      req.params?.id || ""
    ).trim();

  if (!userId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!bookingId) {
    return res.status(400).json({
      ok: false,
      error:
        "BOOKING_ID_REQUIRED",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        "SUPABASE_NOT_CONFIGURED",
    });
  }

  const allowedStatuses =
    new Set([
      "new",
      "confirmed",
      "in_progress",
      "completed",
      "cancelled",
    ]);

  try {
    /*
     * SECURITY:
     * The authenticated user may update
     * bookings only for stations they own.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select("id")
      .eq("owner_id", userId);

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][BOOKING_PATCH_STATIONS_ERROR]",
        stationsError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_LOOKUP_FAILED",
      });
    }

    const stationIds =
      (
        Array.isArray(stations)
          ? stations
          : []
      )
        .map((station) =>
          String(
            station?.id || ""
          ).trim()
        )
        .filter(Boolean);

    if (!stationIds.length) {
      return res.status(403).json({
        ok: false,
        error:
          "BUSINESS_ACCESS_REQUIRED",
      });
    }

    const {
      data: current,
      error: currentError,
    } = await supabase
      .from("business_bookings")
      .select("*")
      .eq("id", bookingId)
      .in(
        "business_id",
        stationIds
      )
      .maybeSingle();

    if (currentError) {
      console.error(
        "[AUTODEAR][WEB_BUSINESS][BOOKING_LOOKUP_ERROR]",
        currentError
      );

      return res.status(500).json({
        ok: false,
        error:
          "BOOKING_LOOKUP_FAILED",
      });
    }

    if (!current) {
      return res.status(404).json({
        ok: false,
        error:
          "BOOKING_NOT_FOUND",
      });
    }

    const patch = {};

    if (
      req.body?.status != null
    ) {
      const status =
        String(
          req.body.status
        )
          .trim()
          .toLowerCase();

      if (
        !allowedStatuses.has(
          status
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_STATUS_INVALID",
        });
      }

      patch.status =
        status;
    }

    if (
      req.body?.date != null
    ) {
      const date =
        String(
          req.body.date
        )
          .trim()
          .slice(0, 10);

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          date
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_DATE_INVALID",
        });
      }

      patch.booking_date =
        date;
    }

    if (
      req.body?.startTime != null
    ) {
      const startTime =
        String(
          req.body.startTime
        )
          .trim()
          .slice(0, 5);

      if (
        !/^\d{2}:\d{2}$/.test(
          startTime
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_TIME_INVALID",
        });
      }

      patch.start_time =
        startTime;
    }

    if (
      req.body?.durationMinutes != null
    ) {
      const durationMinutes =
        Number(
          req.body.durationMinutes
        );

      if (
        !Number.isFinite(
          durationMinutes
        ) ||
        durationMinutes < 15
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_DURATION_INVALID",
        });
      }

      patch.duration_minutes =
        Math.round(
          durationMinutes
        );
    }

    if (
      req.body?.postNumber != null
    ) {
      const postNumber =
        Number(
          req.body.postNumber
        );

      if (
        !Number.isInteger(
          postNumber
        ) ||
        postNumber < 1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BOOKING_POST_INVALID",
        });
      }

      patch.post_number =
        postNumber;
    }

    if (
      !Object.keys(patch).length
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "BOOKING_PATCH_EMPTY",
      });
    }

    patch.updated_at =
      new Date().toISOString();

    const {
      data: updated,
      error: updateError,
    } = await supabase
      .from("business_bookings")
      .update(patch)
      .eq("id", bookingId)
      .in(
        "business_id",
        stationIds
      )
      .select("*")
      .single();

    if (updateError) {
      const isConflict =
        updateError.code ===
          "23P01" ||
        String(
          updateError.message || ""
        ).includes(
          "business_bookings_no_overlap"
        );

      if (isConflict) {
        return res.status(409).json({
          ok: false,
          error:
            "BOOKING_CONFLICT",
        });
      }

      console.error(
        "[AUTODEAR][WEB_BUSINESS][BOOKING_PATCH_ERROR]",
        {
          bookingId,
          userId,
          code:
            updateError.code ||
            null,
          message:
            updateError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BOOKING_UPDATE_FAILED",
      });
    }

    console.log(
      "[AUTODEAR][WEB_BUSINESS][BOOKING_UPDATED]",
      {
        userId,
        bookingId,
        status:
          updated?.status ||
          null,
      }
    );

    return res.json({
      ok: true,

      booking: {
        id:
          updated.id,

        businessId:
          updated.business_id,

        customerName:
          updated.customer_name ||
          "Клиент AUTODEAR",

        customerPhone:
          updated.customer_phone ||
          null,

        car:
          updated.car ||
          null,

        plate:
          updated.plate ||
          null,

        vin:
          updated.vin ||
          null,

        service:
          updated.service ||
          null,

        comment:
          updated.comment ||
          null,

        date:
          updated.booking_date ||
          null,

        startTime:
          updated.start_time ||
          null,

        durationMinutes:
          Number(
            updated.duration_minutes ||
            60
          ),

        postNumber:
          Number(
            updated.post_number ||
            1
          ),

        status:
          updated.status ||
          "confirmed",

        updatedAt:
          updated.updated_at ||
          null,
      },
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_BUSINESS][BOOKING_PATCH_FATAL]",
      {
        userId,
        bookingId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BOOKING_UPDATE_FAILED",
    });
  }
});




app.post("/api/account/link-existing", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const currentUser =
    authResult?.user || null;

  const currentAuthUserId =
    String(
      currentUser?.id || ""
    ).trim();

  if (!currentAuthUserId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!supabase || !supabaseAuth) {
    return res.status(500).json({
      ok: false,
      error:
        "AUTH_SERVICE_NOT_CONFIGURED",
    });
  }

  const email =
    String(
      req.body?.email || ""
    )
      .trim()
      .toLowerCase();

  const password =
    String(
      req.body?.password || ""
    );

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error:
        "CREDENTIALS_REQUIRED",
    });
  }

  try {
    /*
     * Проверяем пароль подключаемого аккаунта
     * отдельным server-side auth client.
     *
     * Текущая мобильная сессия при этом
     * НЕ меняется.
     */
    const {
      data: signInData,
      error: signInError,
    } =
      await supabaseAuth.auth
        .signInWithPassword({
          email,
          password,
        });

    const linkedUser =
      signInData?.user || null;

    const linkedAuthUserId =
      String(
        linkedUser?.id || ""
      ).trim();

    /*
     * Серверному auth client сессия
     * после проверки больше не нужна.
     */
    try {
      await supabaseAuth.auth.signOut();
    } catch (_) {
      // ignore
    }

    if (
      signInError ||
      !linkedAuthUserId
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "INVALID_CREDENTIALS",
      });
    }

    if (
      linkedAuthUserId ===
      currentAuthUserId
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "SAME_ACCOUNT",
      });
    }

    /*
     * Определяем профиль подключаемого
     * auth user.
     */
    const {
      data: linkedProfile,
      error: linkedProfileError,
    } = await supabase
      .from("profiles")
      .select(
        [
          "id",
          "auth_user_id",
          "name",
          "email",
          "phone",
          "role",
        ].join(",")
      )
      .or(
        [
          `auth_user_id.eq.${linkedAuthUserId}`,
          `id.eq.${linkedAuthUserId}`,
        ].join(",")
      )
      .limit(1)
      .maybeSingle();

    if (linkedProfileError) {
      console.error(
        "[AUTODEAR][ACCOUNT_LINK][PROFILE_ERROR]",
        {
          currentAuthUserId,
          linkedAuthUserId,
          message:
            linkedProfileError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "LINKED_PROFILE_LOOKUP_FAILED",
      });
    }

    /*
     * Ищем бизнес подключаемого пользователя.
     * Бизнес может существовать даже если
     * legacy profile имеет неточную role.
     */
    const {
      data: linkedStations,
      error: linkedStationsError,
    } = await supabase
      .from("stations")
      .select(
        [
          "id",
          "owner_id",
          "name",
          "legal_name",
          "business_type",
          "phone",
          "email",
        ].join(",")
      )
      .eq(
        "owner_id",
        linkedAuthUserId
      )
      .order(
        "created_at",
        {
          ascending: true,
        }
      );

    if (linkedStationsError) {
      console.error(
        "[AUTODEAR][ACCOUNT_LINK][BUSINESS_ERROR]",
        {
          currentAuthUserId,
          linkedAuthUserId,
          message:
            linkedStationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "LINKED_BUSINESS_LOOKUP_FAILED",
      });
    }

    const businesses =
      Array.isArray(linkedStations)
        ? linkedStations
        : [];

    const linkedRole =
      String(
        linkedProfile?.role ||
        linkedUser?.user_metadata?.role ||
        ""
      )
        .trim()
        .toLowerCase();

    if (
      !linkedProfile &&
      businesses.length === 0
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "AUTODEAR_ACCOUNT_NOT_FOUND",
      });
    }

    /*
     * Если у auth user есть бизнесы,
     * создаём связь для каждого бизнеса.
     *
     * Если это обычный личный профиль —
     * создаём account-level связь без
     * business_id.
     */
    const rows = [];

    if (businesses.length) {
      for (const business of businesses) {
        rows.push({
          owner_auth_user_id:
            currentAuthUserId,

          linked_auth_user_id:
            linkedAuthUserId,

          business_id:
            business.id,

          link_type:
            "business",

          owner_email:
            currentUser?.email || null,

          owner_phone:
            currentUser?.phone || null,

          linked_email:
            linkedUser?.email ||
            linkedProfile?.email ||
            null,

          linked_phone:
            linkedUser?.phone ||
            linkedProfile?.phone ||
            null,

          verified_at:
            new Date().toISOString(),

          updated_at:
            new Date().toISOString(),
        });
      }
    } else {
      rows.push({
        owner_auth_user_id:
          currentAuthUserId,

        linked_auth_user_id:
          linkedAuthUserId,

        business_id:
          null,

        link_type:
          linkedRole === "business"
            ? "business"
            : "personal",

        owner_email:
          currentUser?.email || null,

        owner_phone:
          currentUser?.phone || null,

        linked_email:
          linkedUser?.email ||
          linkedProfile?.email ||
          null,

        linked_phone:
          linkedUser?.phone ||
          linkedProfile?.phone ||
          null,

        verified_at:
          new Date().toISOString(),

        updated_at:
          new Date().toISOString(),
      });
    }

    /*
     * Не полагаемся пока на неизвестный
     * unique constraint account_links:
     * сначала проверяем существующую связь.
     */
    const createdLinks = [];

    for (const row of rows) {
      let query =
        supabase
          .from("account_links")
          .select("*")
          .eq(
            "owner_auth_user_id",
            row.owner_auth_user_id
          )
          .eq(
            "linked_auth_user_id",
            row.linked_auth_user_id
          )
          .eq(
            "link_type",
            row.link_type
          );

      if (row.business_id) {
        query =
          query.eq(
            "business_id",
            row.business_id
          );
      } else {
        query =
          query.is(
            "business_id",
            null
          );
      }

      const {
        data: existingLink,
        error: existingLinkError,
      } =
        await query
          .limit(1)
          .maybeSingle();

      if (existingLinkError) {
        throw existingLinkError;
      }

      if (existingLink) {
        createdLinks.push(
          existingLink
        );
        continue;
      }

      const {
        data: insertedLink,
        error: insertError,
      } = await supabase
        .from("account_links")
        .insert(row)
        .select("*")
        .single();

      if (insertError) {
        throw insertError;
      }

      createdLinks.push(
        insertedLink
      );
    }

    console.log(
      "[AUTODEAR][ACCOUNT_LINK][OK]",
      {
        currentAuthUserId,
        linkedAuthUserId,
        businesses:
          businesses.length,
        links:
          createdLinks.length,
      }
    );

    return res.json({
      ok: true,

      linkedAuthUserId,

      accountType:
        businesses.length
          ? "business"
          : "personal",

      businesses:
        businesses.map(
          (business) => ({
            id:
              business.id,

            name:
              business.name ||
              business.legal_name ||
              "Бизнес AUTODEAR",

            businessType:
              business.business_type ||
              null,
          })
        ),

      links:
        createdLinks,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][ACCOUNT_LINK][UNEXPECTED]",
      {
        currentAuthUserId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "ACCOUNT_LINK_FAILED",
    });
  }
});


app.get("/api/account/workspaces", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const authUserId =
    String(
      authUser?.id || ""
    ).trim();

  if (!authUserId) {
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

  try {
    /*
     * AUTO-LINK:
     *
     * If personal and business auth accounts have
     * the same normalized email AND phone, AUTODEAR
     * can safely connect them automatically.
     *
     * One matching field alone is NOT enough.
     */

    const normalizeAccountEmail =
      (value) =>
        String(value || "")
          .trim()
          .toLowerCase();

    const normalizeAccountPhone =
      (value) => {
        let digits =
          String(value || "")
            .replace(/\D/g, "");

        if (
          digits.length === 11 &&
          digits.startsWith("8")
        ) {
          digits =
            `7${digits.slice(1)}`;
        }

        if (
          digits.length === 10
        ) {
          digits =
            `7${digits}`;
        }

        return digits;
      };


    const currentEmail =
      normalizeAccountEmail(
        authUser?.email ||
        authUser?.user_metadata?.email ||
        ""
      );

    const currentPhone =
      normalizeAccountPhone(
        authUser?.phone ||
        authUser?.user_metadata?.phone ||
        ""
      );


    /*
     * We only attempt automatic discovery when
     * BOTH confirmed contact identifiers exist.
     */
    if (
      currentEmail &&
      currentPhone
    ) {
      const {
        data: matchingProfiles,
        error: matchingProfilesError,
      } = await supabase
        .from("profiles")
        .select(
          [
            "id",
            "auth_user_id",
            "name",
            "email",
            "phone",
            "role",
          ].join(",")
        )
        .neq(
          "auth_user_id",
          authUserId
        );

      if (matchingProfilesError) {
        console.warn(
          "[AUTODEAR][ACCOUNT_AUTO_LINK][PROFILE_SCAN_ERROR]",
          {
            authUserId,
            message:
              matchingProfilesError.message ||
              null,
          }
        );
      } else {
        const exactMatches =
          (
            Array.isArray(
              matchingProfiles
            )
              ? matchingProfiles
              : []
          ).filter(
            (profile) => {
              const profileAuthId =
                String(
                  profile?.auth_user_id ||
                  profile?.id ||
                  ""
                ).trim();

              if (!profileAuthId) {
                return false;
              }

              const profileEmail =
                normalizeAccountEmail(
                  profile?.email
                );

              const profilePhone =
                normalizeAccountPhone(
                  profile?.phone
                );

              return (
                profileEmail ===
                  currentEmail &&
                profilePhone ===
                  currentPhone
              );
            }
          );


        for (
          const matchedProfile of
          exactMatches
        ) {
          const matchedAuthUserId =
            String(
              matchedProfile
                ?.auth_user_id ||
              matchedProfile?.id ||
              ""
            ).trim();

          if (
            !matchedAuthUserId ||
            matchedAuthUserId ===
              authUserId
          ) {
            continue;
          }


          const currentProfileRole =
            String(
              authUser?.user_metadata
                ?.role ||
              ""
            )
              .trim()
              .toLowerCase();

          const matchedRole =
            String(
              matchedProfile?.role ||
              ""
            )
              .trim()
              .toLowerCase();


          /*
           * Only opposite personal/business sides
           * are eligible for automatic linking.
           *
           * Legacy data may have inaccurate role,
           * therefore actual station ownership is
           * also checked below.
           */
          const {
            data: matchedStations,
            error: matchedStationsError,
          } = await supabase
            .from("stations")
            .select(
              [
                "id",
                "owner_id",
                "name",
                "legal_name",
              ].join(",")
            )
            .eq(
              "owner_id",
              matchedAuthUserId
            );

          if (matchedStationsError) {
            console.warn(
              "[AUTODEAR][ACCOUNT_AUTO_LINK][STATIONS_ERROR]",
              {
                authUserId,
                matchedAuthUserId,
                message:
                  matchedStationsError
                    .message ||
                  null,
              }
            );

            continue;
          }


          const matchedBusinesses =
            Array.isArray(
              matchedStations
            )
              ? matchedStations
              : [];


          /*
           * Determine which auth id should be the
           * canonical personal owner of the link.
           *
           * If current auth user is personal, it
           * remains owner.
           *
           * If current auth user is business and
           * matched profile is personal, matched
           * auth user becomes owner.
           */
          let ownerAuthUserId =
            authUserId;

          let linkedAuthUserId =
            matchedAuthUserId;


          if (
            currentProfileRole ===
              "business" &&
            matchedRole ===
              "user"
          ) {
            ownerAuthUserId =
              matchedAuthUserId;

            linkedAuthUserId =
              authUserId;
          }


          /*
           * Auto-link only when one side clearly
           * represents business ownership.
           */
          const businessSideExists =
            matchedBusinesses.length > 0 ||
            matchedRole ===
              "business" ||
            currentProfileRole ===
              "business";

          if (!businessSideExists) {
            continue;
          }


          if (
            matchedBusinesses.length
          ) {
            for (
              const business of
              matchedBusinesses
            ) {
              const businessId =
                String(
                  business?.id || ""
                ).trim();

              if (!businessId) {
                continue;
              }

              const {
                data: existingLink,
                error: existingLinkError,
              } = await supabase
                .from("account_links")
                .select("id")
                .eq(
                  "owner_auth_user_id",
                  ownerAuthUserId
                )
                .eq(
                  "linked_auth_user_id",
                  linkedAuthUserId
                )
                .eq(
                  "business_id",
                  businessId
                )
                .limit(1)
                .maybeSingle();

              if (existingLinkError) {
                console.warn(
                  "[AUTODEAR][ACCOUNT_AUTO_LINK][EXISTING_LINK_ERROR]",
                  {
                    ownerAuthUserId,
                    linkedAuthUserId,
                    businessId,
                    message:
                      existingLinkError
                        .message ||
                      null,
                  }
                );

                continue;
              }

              if (existingLink) {
                continue;
              }

              const {
                error: insertError,
              } = await supabase
                .from("account_links")
                .insert({
                  owner_auth_user_id:
                    ownerAuthUserId,

                  linked_auth_user_id:
                    linkedAuthUserId,

                  business_id:
                    businessId,

                  link_type:
                    "business",

                  owner_email:
                    ownerAuthUserId ===
                    authUserId
                      ? currentEmail
                      : normalizeAccountEmail(
                          matchedProfile
                            ?.email
                        ),

                  owner_phone:
                    ownerAuthUserId ===
                    authUserId
                      ? currentPhone
                      : normalizeAccountPhone(
                          matchedProfile
                            ?.phone
                        ),

                  linked_email:
                    linkedAuthUserId ===
                    authUserId
                      ? currentEmail
                      : normalizeAccountEmail(
                          matchedProfile
                            ?.email
                        ),

                  linked_phone:
                    linkedAuthUserId ===
                    authUserId
                      ? currentPhone
                      : normalizeAccountPhone(
                          matchedProfile
                            ?.phone
                        ),

                  verified_at:
                    new Date()
                      .toISOString(),

                  updated_at:
                    new Date()
                      .toISOString(),
                });

              if (insertError) {
                console.warn(
                  "[AUTODEAR][ACCOUNT_AUTO_LINK][INSERT_ERROR]",
                  {
                    ownerAuthUserId,
                    linkedAuthUserId,
                    businessId,
                    message:
                      insertError.message ||
                      null,
                  }
                );

                continue;
              }

              console.log(
                "[AUTODEAR][ACCOUNT_AUTO_LINK][CREATED]",
                {
                  ownerAuthUserId,
                  linkedAuthUserId,
                  businessId,
                  reason:
                    "email_and_phone_match",
                }
              );
            }
          }
        }
      }
    }

    /*
     * 1. Current profile.
     */
    const {
      data: currentProfile,
      error: currentProfileError,
    } = await supabaseReadWithRetry(
      () =>
        supabase
          .from("profiles")
          .select(
            [
              "id",
              "auth_user_id",
              "name",
              "email",
              "phone",
              "role",
              "city",
              "avatar_url",
            ].join(",")
          )
          .or(
            `auth_user_id.eq.${authUserId},id.eq.${authUserId}`
          )
          .limit(1)
          .maybeSingle(),
      "account_workspaces_current_profile"
    );

    if (currentProfileError) {
      console.error(
        "[AUTODEAR][ACCOUNT_WORKSPACES][PROFILE_ERROR]",
        {
          authUserId,
          code:
            currentProfileError.code ||
            null,
          message:
            currentProfileError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "ACCOUNT_PROFILE_LOOKUP_FAILED",
      });
    }


    /*
     * 2. Find every account link where this auth
     * user participates on either side.
     */
    const {
      data: directLinks,
      error: linksError,
    } = await supabase
      .from("account_links")
      .select("*")
      .or(
        [
          `owner_auth_user_id.eq.${authUserId}`,
          `linked_auth_user_id.eq.${authUserId}`,
        ].join(",")
      );

    if (linksError) {
      console.error(
        "[AUTODEAR][ACCOUNT_WORKSPACES][LINKS_ERROR]",
        {
          authUserId,
          code:
            linksError.code ||
            null,
          message:
            linksError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "ACCOUNT_LINKS_LOOKUP_FAILED",
      });
    }


    const links =
      Array.isArray(directLinks)
        ? directLinks
        : [];


    /*
     * 3. Resolve the canonical owner ids participating
     * in the same group.
     *
     * For now one hop is enough because every confirmed
     * relation points to the primary owner.
     */
    const ownerIds =
      new Set([authUserId]);

    links.forEach(
      (link) => {
        const ownerId =
          String(
            link?.owner_auth_user_id ||
            ""
          ).trim();

        if (ownerId) {
          ownerIds.add(ownerId);
        }
      }
    );


    const canonicalOwnerIds =
      Array.from(ownerIds);


    /*
     * 4. Load all links of those owners.
     */
    let groupLinks = [];

    if (canonicalOwnerIds.length) {
      const {
        data,
        error,
      } = await supabase
        .from("account_links")
        .select("*")
        .in(
          "owner_auth_user_id",
          canonicalOwnerIds
        );

      if (error) {
        console.error(
          "[AUTODEAR][ACCOUNT_WORKSPACES][GROUP_LINKS_ERROR]",
          JSON.stringify({
            authUserId,
            code:
              error.code ||
              null,
            message:
              error.message ||
              null,
            details:
              error.details ||
              null,
            hint:
              error.hint ||
              null,
          })
        );

        return res.status(500).json({
          ok: false,
          error:
            "ACCOUNT_GROUP_LOOKUP_FAILED",
        });
      }

      groupLinks =
        Array.isArray(data)
          ? data
          : [];
    }


    /*
     * 5. Collect all auth users in the group.
     */
    const authIds =
      new Set(
        canonicalOwnerIds
      );

    groupLinks.forEach(
      (link) => {
        const linkedId =
          String(
            link?.linked_auth_user_id ||
            ""
          ).trim();

        if (linkedId) {
          authIds.add(linkedId);
        }
      }
    );


    const authIdList =
      Array.from(authIds);


    /*
     * 6. Profiles for personal / legacy linked auths.
     */
    let profiles = [];

    if (authIdList.length) {
      const {
        data,
        error,
      } = await supabase
        .from("profiles")
        .select(
          [
            "id",
            "auth_user_id",
            "name",
            "email",
            "phone",
            "role",
            "city",
            "avatar_url",
          ].join(",")
        )
        .in(
          "auth_user_id",
          authIdList
        );

      if (error) {
        console.error(
          "[AUTODEAR][ACCOUNT_WORKSPACES][PROFILES_ERROR]",
          {
            authUserId,
            code:
              error.code ||
              null,
            message:
              error.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ACCOUNT_PROFILES_LOOKUP_FAILED",
        });
      }

      profiles =
        Array.isArray(data)
          ? data
          : [];
    }


    /*
     * 7. Businesses owned by any confirmed auth owner.
     */
    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        [
          "id",
          "owner_id",
          "name",
          "legal_name",
          "business_type",
          "phone",
          "email",
          "city",
          "photo_url",
          "status",
          "is_active",
          "is_verified",
        ].join(",")
      )
      .in(
        "owner_id",
        authIdList
      )
      .order(
        "created_at",
        {
          ascending: true,
        }
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][ACCOUNT_WORKSPACES][STATIONS_ERROR]",
        {
          authUserId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "ACCOUNT_BUSINESSES_LOOKUP_FAILED",
      });
    }


    /*
     * 8. Businesses explicitly linked through account_links.
     */
    const linkedBusinessIds =
      Array.from(
        new Set(
          groupLinks
            .map(
              (link) =>
                String(
                  link?.business_id ||
                  ""
                ).trim()
            )
            .filter(Boolean)
        )
      );


    let explicitlyLinkedStations = [];

    if (linkedBusinessIds.length) {
      const {
        data,
        error,
      } = await supabase
        .from("stations")
        .select(
          [
            "id",
            "owner_id",
            "name",
            "legal_name",
            "business_type",
            "phone",
            "email",
            "city",
            "photo_url",
            "status",
            "is_active",
            "is_verified",
          ].join(",")
        )
        .in(
          "id",
          linkedBusinessIds
        );

      if (error) {
        console.error(
          "[AUTODEAR][ACCOUNT_WORKSPACES][LINKED_STATIONS_ERROR]",
          {
            authUserId,
            code:
              error.code ||
              null,
            message:
              error.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ACCOUNT_LINKED_BUSINESSES_FAILED",
        });
      }

      explicitlyLinkedStations =
        Array.isArray(data)
          ? data
          : [];
    }


    const stationMap =
      new Map();

    [
      ...(
        Array.isArray(stations)
          ? stations
          : []
      ),
      ...explicitlyLinkedStations,
    ].forEach(
      (station) => {
        const id =
          String(
            station?.id || ""
          ).trim();

        if (id) {
          stationMap.set(
            id,
            station
          );
        }
      }
    );


    const businessWorkspaces =
      Array.from(
        stationMap.values()
      ).map(
        (station) => ({
          type:
            "business",

          id:
            station.id,

          ownerId:
            station.owner_id,

          name:
            station.name ||
            station.legal_name ||
            "Бизнес AUTODEAR",

          legalName:
            station.legal_name ||
            null,

          businessType:
            station.business_type ||
            null,

          phone:
            station.phone ||
            null,

          email:
            station.email ||
            null,

          city:
            station.city ||
            null,

          avatarUrl:
            station.photo_url ||
            null,

          status:
            station.status ||
            null,

          isActive:
            Boolean(
              station.is_active
            ),

          isVerified:
            Boolean(
              station.is_verified
            ),
        })
      );


    const personalProfiles =
      profiles
        .filter(
          (profile) =>
            String(
              profile?.role ||
              "user"
            )
              .trim()
              .toLowerCase() ===
            "user"
        )
        .map(
          (profile) => ({
            type:
              "personal",

            id:
              profile.auth_user_id ||
              profile.id,

            profileId:
              profile.id,

            authUserId:
              profile.auth_user_id ||
              profile.id,

            name:
              profile.name ||
              "Пользователь AUTODEAR",

            email:
              profile.email ||
              null,

            phone:
              profile.phone ||
              null,

            city:
              profile.city ||
              null,

            avatarUrl:
              profile.avatar_url ||
              null,
          })
        );


    /*
     * Current profile may have old id/auth_user_id shape,
     * so keep it visible even if the .in(auth_user_id)
     * lookup missed it.
     */
    if (
      currentProfile &&
      String(
        currentProfile.role ||
        "user"
      )
        .trim()
        .toLowerCase() ===
        "user"
    ) {
      const currentPersonalId =
        currentProfile.auth_user_id ||
        currentProfile.id;

      const exists =
        personalProfiles.some(
          (profile) =>
            String(
              profile.authUserId
            ) ===
            String(
              currentPersonalId
            )
        );

      if (!exists) {
        personalProfiles.unshift({
          type:
            "personal",

          id:
            currentPersonalId,

          profileId:
            currentProfile.id,

          authUserId:
            currentPersonalId,

          name:
            currentProfile.name ||
            "Пользователь AUTODEAR",

          email:
            currentProfile.email ||
            null,

          phone:
            currentProfile.phone ||
            null,

          city:
            currentProfile.city ||
            null,

          avatarUrl:
            currentProfile.avatar_url ||
            null,
        });
      }
    }


    const workspaces = [
      ...personalProfiles,
      ...businessWorkspaces,
    ];


    console.log(
      "[AUTODEAR][ACCOUNT_WORKSPACES][OK]",
      {
        authUserId,
        personals:
          personalProfiles.length,
        businesses:
          businessWorkspaces.length,
        links:
          groupLinks.length,
      }
    );


    return res.json({
      ok: true,

      currentAuthUserId:
        authUserId,

      personalProfiles,

      businesses:
        businessWorkspaces,

      workspaces,

      links:
        groupLinks.map(
          (link) => ({
            id:
              link.id,

            ownerAuthUserId:
              link.owner_auth_user_id,

            linkedAuthUserId:
              link.linked_auth_user_id ||
              null,

            businessId:
              link.business_id ||
              null,

            linkType:
              link.link_type,

            verifiedAt:
              link.verified_at ||
              null,
          })
        ),
    });

  } catch (error) {
    console.error(
      "[AUTODEAR][ACCOUNT_WORKSPACES][UNEXPECTED]",
      {
        authUserId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "ACCOUNT_WORKSPACES_FAILED",
    });
  }
});


app.get("/api/auth/me", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const userId =
    String(
      authUser?.id || ""
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

  try {
    const {
      data: profile,
      error: profileError,
    } = await supabase
      .from("profiles")
      .select(
        [
          "id",
          "auth_user_id",
          "name",
          "email",
          "phone",
          "role",
          "city",
          "avatar_url",
        ].join(",")
      )
      .or(
        `auth_user_id.eq.${userId},id.eq.${userId}`
      )
      .limit(1)
      .maybeSingle();

    if (profileError) {
      console.error(
        "[AUTODEAR][WEB_AUTH][PROFILE_ERROR]",
        {
          userId,
          code:
            profileError.code ||
            null,
          message:
            profileError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "AUTH_PROFILE_LOOKUP_FAILED",
      });
    }

    /*
     * SECURITY:
     * Web permissions come only from profiles.role
     * loaded by the trusted server-side Supabase client.
     *
     * Never trust a role sent by the browser.
     */
    const allowedRoles =
      new Set([
        "user",
        "business",
        "admin",
        "director",
        "developer",
      ]);

    const rawRole =
      String(
        profile?.role || "user"
      )
        .trim()
        .toLowerCase();

    const role =
      allowedRoles.has(rawRole)
        ? rawRole
        : "user";

    const {
      data: stations,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        [
          "id",
          "owner_id",
          "name",
          "legal_name",
          "business_type",
          "city",
          "address",
          "phone",
          "email",
          "photo_url",
          "status",
          "is_active",
          "is_verified",
        ].join(",")
      )
      .eq("owner_id", userId)
      .order(
        "created_at",
        {
          ascending: true,
        }
      );

    if (stationsError) {
      console.error(
        "[AUTODEAR][WEB_AUTH][STATIONS_ERROR]",
        {
          userId,
          code:
            stationsError.code ||
            null,
          message:
            stationsError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "AUTH_BUSINESS_LOOKUP_FAILED",
      });
    }

    const ownedStations =
      Array.isArray(stations)
        ? stations
        : [];

    const hasBusiness =
      ownedStations.length > 0;

    /*
     * A real station owned by this authenticated
     * user grants access to the business workspace.
     *
     * Staff workspaces still require profiles.role.
     */
    const workspaces = [];

    if (
      hasBusiness ||
      role === "business"
    ) {
      workspaces.push("business");
    }

    if (role === "admin") {
      workspaces.push("admin");
    }

    if (role === "director") {
      workspaces.push("director");
    }

    if (role === "developer") {
      workspaces.push("developer");
    }

    console.log(
      "[AUTODEAR][WEB_AUTH][ME_OK]",
      {
        userId,
        role,
        hasBusiness,
        stations:
          ownedStations.length,
        workspaces,
      }
    );

    return res.json({
      ok: true,

      user: {
        id:
          userId,
        email:
          profile?.email ||
          authUser?.email ||
          null,
        name:
          profile?.name ||
          authUser?.user_metadata?.name ||
          null,
        phone:
          profile?.phone ||
          null,
        city:
          profile?.city ||
          null,
        avatarUrl:
          profile?.avatar_url ||
          null,
        role,
      },

      access: {
        role,
        hasBusiness,
        workspaces,
      },

      businesses:
        ownedStations.map(
          (station) => ({
            id:
              station.id,
            ownerId:
              station.owner_id,
            name:
              station.name ||
              station.legal_name ||
              "Бизнес AUTODEAR",
            legalName:
              station.legal_name ||
              null,
            businessType:
              station.business_type ||
              null,
            city:
              station.city ||
              null,
            address:
              station.address ||
              null,
            phone:
              station.phone ||
              null,
            email:
              station.email ||
              null,
            photoUrl:
              station.photo_url ||
              null,
            status:
              station.status ||
              null,
            isActive:
              station.is_active !== false,
            isVerified:
              station.is_verified === true,
          })
        ),
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][WEB_AUTH][ME_FATAL]",
      {
        userId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "AUTH_ME_FAILED",
    });
  }
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

/*
 * Получение сохранённого отчёта проверки автомобиля.
 *
 * Отчёт доступен только владельцу:
 * авторизованный user_id обязан совпадать с
 * vehicle_check_reports.user_id.
 */
app.get("/api/vehicle-reports/:reportId", async (req, res) => {
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

    const reportId =
      String(
        req.params?.reportId || ""
      ).trim();

    if (!reportId) {
      return res.status(400).json({
        ok: false,
        error:
          "VEHICLE_REPORT_ID_REQUIRED",
      });
    }

    const {
      data: report,
      error,
    } = await supabase
      .from("vehicle_check_reports")
      .select("*")
      .eq("id", reportId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error(
        "[AUTODEAR][VEHICLE_REPORT][GET_ERROR]",
        {
          userId,
          reportId,
          code:
            error.code || null,
          message:
            error.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "VEHICLE_REPORT_GET_ERROR",
      });
    }

    if (!report) {
      /*
       * Намеренно не различаем:
       * - отчёта нет;
       * - отчёт принадлежит другому пользователю.
       *
       * Так мы не раскрываем существование
       * чужих reportId.
       */
      return res.status(404).json({
        ok: false,
        error:
          "VEHICLE_REPORT_NOT_FOUND",
      });
    }

    console.log(
      "[AUTODEAR][VEHICLE_REPORT][GET_OK]",
      {
        userId,
        reportId,
        reportType:
          report.report_type,
      }
    );

    return res.json({
      ok: true,

      reportId:
        report.id,

      reportType:
        report.report_type,

      reportVersion:
        report.report_version,

      vin:
        report.vin,

      plate:
        report.plate,

      provider:
        report.provider,

      status:
        report.status,

      created_at:
        report.created_at,

      completed_at:
        report.completed_at,

      result:
        report.normalized_json || {},

      raw:
        report.raw_json || {},

      ai: {
        riskLevel:
          report.risk_level || null,

        title:
          report.risk_title || null,

        summary:
          report.ai_summary || null,
      },
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][VEHICLE_REPORT][GET_UNKNOWN_ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "VEHICLE_REPORT_GET_UNKNOWN_ERROR",
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

app.post("/api/address-suggest", async (req, res) => {
  try {
    const apiKey = String(process.env.DADATA_API_KEY || "").trim();

    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: "DADATA_API_KEY_NOT_CONFIGURED",
      });
    }

    const city = normalizeGeocodeText(req.body?.city);
    const query = normalizeGeocodeText(req.body?.query);
    const selected = req.body?.selected === true;

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "QUERY_REQUIRED",
      });
    }

    const payload = {
      query,
      count: selected ? 1 : 10,
      language: "ru",
    };

    if (!selected && city) {
      payload.locations = [{ city }];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let response;

    try {
      response = await fetch(
        "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Token ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const providerText = await response.text().catch(() => "");

      console.warn("[AUTODEAR][DADATA][HTTP_ERROR]", {
        status: response.status,
        body: providerText.slice(0, 300),
      });

      return res.status(502).json({
        ok: false,
        error: `DADATA_PROVIDER_HTTP_${response.status}`,
      });
    }

    const data = await response.json();
    const suggestions = Array.isArray(data?.suggestions)
      ? data.suggestions
      : [];

    const items = suggestions.map((item) => {
      const details = item?.data || {};

      const latitude =
        details.geo_lat == null ? null : Number(details.geo_lat);
      const longitude =
        details.geo_lon == null ? null : Number(details.geo_lon);

      return {
        value: String(item?.value || ""),
        unrestrictedValue: String(
          item?.unrestricted_value || item?.value || ""
        ),
        city: String(
          details.city ||
            details.settlement ||
            city ||
            ""
        ),
        street: String(details.street_with_type || ""),
        house: String(details.house || ""),
        postalCode: String(details.postal_code || ""),
        fiasId: String(details.fias_id || ""),
        fiasLevel:
          details.fias_level == null
            ? null
            : Number(details.fias_level),
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        qcGeo:
          details.qc_geo == null
            ? null
            : Number(details.qc_geo),
      };
    });

    return res.json({
      ok: true,
      city,
      query,
      selected,
      items,
    });
  } catch (error) {
    const aborted = error?.name === "AbortError";

    console.error("[AUTODEAR][DADATA][ADDRESS_SUGGEST_ERROR]", {
      message: error?.message || String(error),
      aborted,
    });

    return res.status(aborted ? 504 : 500).json({
      ok: false,
      error: aborted
        ? "DADATA_TIMEOUT"
        : "ADDRESS_SUGGEST_FAILED",
    });
  }
});

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

app.post("/api/route-distance", async (req, res) => {
  try {
    const fromLat = Number(req.body?.fromLat);
    const fromLng = Number(req.body?.fromLng);
    const toLat = Number(req.body?.toLat);
    const toLng = Number(req.body?.toLng);

    const coordinatesValid =
      Number.isFinite(fromLat) &&
      Number.isFinite(fromLng) &&
      Number.isFinite(toLat) &&
      Number.isFinite(toLng) &&
      fromLat >= -90 &&
      fromLat <= 90 &&
      toLat >= -90 &&
      toLat <= 90 &&
      fromLng >= -180 &&
      fromLng <= 180 &&
      toLng >= -180 &&
      toLng <= 180;

    if (!coordinatesValid) {
      return res.status(400).json({
        ok: false,
        error: "ROUTE_COORDINATES_INVALID",
      });
    }

    /*
     * Округляем только ключ кэша.
     * В сам routing provider передаём исходные координаты.
     */
    const cacheKey = [
      fromLat.toFixed(5),
      fromLng.toFixed(5),
      toLat.toFixed(5),
      toLng.toFixed(5),
    ].join(":");

    if (routeDistanceCache.has(cacheKey)) {
      return res.json({
        ...routeDistanceCache.get(cacheKey),
        cached: true,
      });
    }

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      8000
    );

    let response;

    try {
      /*
       * OSRM принимает координаты в порядке:
       * longitude,latitude
       */
      const coordinates =
        `${fromLng},${fromLat};${toLng},${toLat}`;

      const url =
        "https://router.project-osrm.org/route/v1/driving/" +
        coordinates +
        "?overview=false&alternatives=false&steps=false";

      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "AUTODEAR/1.0",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.warn(
        "[AUTODEAR][ROUTE_DISTANCE][PROVIDER_HTTP_ERROR]",
        {
          status: response.status,
        }
      );

      return res.status(502).json({
        ok: false,
        error:
          `ROUTE_PROVIDER_HTTP_${response.status}`,
      });
    }

    const data =
      await response.json().catch(() => null);

    const route =
      Array.isArray(data?.routes)
        ? data.routes[0] || null
        : null;

    const distanceMeters =
      Number(route?.distance);

    const durationSeconds =
      Number(route?.duration);

    if (
      !route ||
      !Number.isFinite(distanceMeters) ||
      distanceMeters < 0 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds < 0
    ) {
      return res.status(502).json({
        ok: false,
        error: "ROUTE_PROVIDER_RESULT_INVALID",
      });
    }

    const result = {
      ok: true,
      distanceKm:
        Math.round((distanceMeters / 1000) * 10) /
        10,
      durationMinutes:
        Math.max(
          1,
          Math.round(durationSeconds / 60)
        ),
      provider: "osrm",
      cached: false,
    };

    /*
     * Ограничиваем RAM cache, чтобы процесс Render
     * не накапливал ключи бесконечно.
     */
    if (routeDistanceCache.size >= 2000) {
      routeDistanceCache.clear();
    }

    routeDistanceCache.set(
      cacheKey,
      result
    );

    return res.json(result);
  } catch (error) {
    const message =
      String(
        error?.message ||
        error ||
        ""
      );

    const aborted =
      error?.name === "AbortError" ||
      message
        .toLowerCase()
        .includes("abort");

    console.warn(
      "[AUTODEAR][ROUTE_DISTANCE][ERROR]",
      {
        aborted,
        message,
      }
    );

    return res
      .status(aborted ? 504 : 502)
      .json({
        ok: false,
        error: aborted
          ? "ROUTE_PROVIDER_TIMEOUT"
          : "ROUTE_PROVIDER_FAILED",
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
    const status =
      Number(
        error?.statusCode ||
        (
          error?.name ===
          "AbortError"
            ? 504
            : 500
        )
      );

    console.error(
      "[AUTODEAR][CKASSA][CREATE_ERROR]",
      error
    );

    return res.status(status).json({
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
// AUTODEAR BONUS LEDGER — READ ONLY FOR CLIENT
//
// Bonus points are NOT money and are intentionally separated
// from personal/business wallets.
//
// The authenticated client may read only its own ledger.
// Bonus creation/spending will be performed only by trusted
// AUTODEAR server flows.
// ============================================================

app.get("/api/bonuses/me", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const authUserId =
    String(
      authUser?.id || ""
    ).trim();

  if (!authUserId) {
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

  try {
    const {
      data: profile,
      error: profileError,
    } = await supabaseReadWithRetry(
      () =>
        supabase
          .from("profiles")
          .select("id,auth_user_id")
          .or(
            `auth_user_id.eq.${authUserId},id.eq.${authUserId}`
          )
          .limit(1)
          .maybeSingle(),
      "bonus-ledger-profile"
    );

    if (profileError) {
      console.error(
        "[AUTODEAR][BONUS_LEDGER][PROFILE_ERROR]",
        {
          authUserId,
          code:
            profileError.code || null,
          message:
            profileError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_PROFILE_LOOKUP_FAILED",
      });
    }

    const profileId =
      String(
        profile?.id || ""
      ).trim();

    if (!profileId) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_PROFILE_NOT_FOUND",
      });
    }

    const {
      data,
      error,
    } = await supabaseReadWithRetry(
      () =>
        supabase
          .from("bonuses")
          .select(
            "id,user_id,title,amount,type,expires_at,source_type,source_id,created_at"
          )
          .eq(
            "user_id",
            profileId
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          ),
      "bonus-ledger-me"
    );

    if (error) {
      console.error(
        "[AUTODEAR][BONUS_LEDGER][READ_ERROR]",
        {
          authUserId,
          profileId,
          code:
            error.code || null,
          message:
            error.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_LEDGER_READ_FAILED",
      });
    }

    if (!supabaseServiceRole) {
      return res.status(503).json({
        ok: false,
        error:
          "BONUS_SERVICE_NOT_CONFIGURED",
      });
    }

    const bonusRows =
      Array.isArray(data)
        ? data
        : [];

    const incomeIds =
      bonusRows
        .filter(
          (row) =>
            String(
              row?.type || ""
            ) === "income"
        )
        .map((row) =>
          String(
            row?.id || ""
          ).trim()
        )
        .filter(Boolean);

    const expenseIds =
      bonusRows
        .filter(
          (row) =>
            String(
              row?.type || ""
            ) === "expense"
        )
        .map((row) =>
          String(
            row?.id || ""
          ).trim()
        )
        .filter(Boolean);

    let allocationRows = [];

    if (
      incomeIds.length > 0 ||
      expenseIds.length > 0
    ) {
      const {
        data: allocations,
        error: allocationsError,
      } =
        await supabaseReadWithRetry(
          () =>
            supabaseServiceRole
              .from(
                "bonus_spend_allocations"
              )
              .select(
                "income_bonus_id,expense_bonus_id,amount"
              )
              .eq(
                "user_id",
                profileId
              ),
          "bonus-ledger-allocations"
        );

      if (allocationsError) {
        console.error(
          "[AUTODEAR][BONUS_LEDGER][ALLOCATIONS_ERROR]",
          {
            authUserId,
            profileId,
            code:
              allocationsError.code ||
              null,
            message:
              allocationsError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BONUS_ALLOCATIONS_READ_FAILED",
        });
      }

      allocationRows =
        Array.isArray(allocations)
          ? allocations
          : [];
    }

    const allocatedByIncome =
      new Map();

    const allocatedExpenseIds =
      new Set();

    const allocatedByExpense =
      new Map();

    for (
      const allocation of
      allocationRows
    ) {
      const incomeBonusId =
        String(
          allocation?.income_bonus_id ||
          ""
        ).trim();

      const expenseBonusId =
        String(
          allocation?.expense_bonus_id ||
          ""
        ).trim();

      const amount =
        Math.max(
          0,
          Number(
            allocation?.amount || 0
          )
        );

      if (
        incomeBonusId &&
        Number.isFinite(amount)
      ) {
        allocatedByIncome.set(
          incomeBonusId,
          Number(
            allocatedByIncome.get(
              incomeBonusId
            ) || 0
          ) + amount
        );
      }

      if (expenseBonusId) {
        allocatedExpenseIds.add(
          expenseBonusId
        );

        allocatedByExpense.set(
          expenseBonusId,
          Number(
            allocatedByExpense.get(
              expenseBonusId
            ) || 0
          ) + amount
        );
      }
    }

    const unallocatedExpenseIds =
      expenseIds.filter(
        (expenseId) =>
          !allocatedExpenseIds.has(
            expenseId
          )
      );

    if (
      unallocatedExpenseIds.length > 0
    ) {
      console.error(
        "[AUTODEAR][BONUS_LEDGER][UNALLOCATED_EXPENSE]",
        {
          authUserId,
          profileId,
          count:
            unallocatedExpenseIds.length,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_LEDGER_REQUIRES_RECONCILIATION",
      });
    }

    const expenseAllocationMismatches =
      bonusRows
        .filter(
          (row) =>
            String(
              row?.type || ""
            ) === "expense"
        )
        .map((row) => {
          const expenseId =
            String(
              row?.id || ""
            ).trim();

          const expenseAmount =
            Math.max(
              0,
              Number(
                row?.amount || 0
              )
            );

          const allocatedAmount =
            Math.max(
              0,
              Number(
                allocatedByExpense.get(
                  expenseId
                ) || 0
              )
            );

          return {
            expenseId,
            expenseAmount,
            allocatedAmount,
          };
        })
        .filter(
          (item) =>
            !item.expenseId ||
            !Number.isFinite(
              item.expenseAmount
            ) ||
            item.expenseAmount <= 0 ||
            !Number.isFinite(
              item.allocatedAmount
            ) ||
            item.allocatedAmount !==
              item.expenseAmount
        );

    if (
      expenseAllocationMismatches.length >
      0
    ) {
      console.error(
        "[AUTODEAR][BONUS_LEDGER][EXPENSE_ALLOCATION_MISMATCH]",
        {
          authUserId,
          profileId,
          count:
            expenseAllocationMismatches.length,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_LEDGER_REQUIRES_RECONCILIATION",
      });
    }

    const now = Date.now();

    const balance =
      bonusRows.reduce(
        (sum, row) => {
          if (
            String(
              row?.type || ""
            ) !== "income"
          ) {
            return sum;
          }

          const amount =
            Math.max(
              0,
              Number(
                row?.amount || 0
              )
            );

          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {
            return sum;
          }

          const createdAtMs =
            new Date(
              row?.created_at || ""
            ).getTime();

          const explicitExpiresAtMs =
            new Date(
              row?.expires_at || ""
            ).getTime();

          const expiresAtMs =
            Number.isFinite(
              explicitExpiresAtMs
            )
              ? explicitExpiresAtMs
              : Number.isFinite(
                  createdAtMs
                )
              ? createdAtMs +
                365 *
                  24 *
                  60 *
                  60 *
                  1000
              : 0;

          if (
            !expiresAtMs ||
            expiresAtMs <= now
          ) {
            return sum;
          }

          const bonusId =
            String(
              row?.id || ""
            ).trim();

          const allocated =
            Math.max(
              0,
              Number(
                allocatedByIncome.get(
                  bonusId
                ) || 0
              )
            );

          return (
            sum +
            Math.max(
              0,
              amount - allocated
            )
          );
        },
        0
      );

    const transactions =
      (
        Array.isArray(data)
          ? data
          : []
      ).map((row) => ({
        id: row.id,
        userId: row.user_id,
        title:
          String(
            row.title || ""
          ),
        amount:
          Number(
            row.amount || 0
          ),
        type: row.type,
        expiresAt:
          row.expires_at || null,
        sourceType:
          row.source_type || null,
        sourceId:
          row.source_id || null,
        createdAt:
          row.created_at,
      }));

    return res.json({
      ok: true,
      userId: authUserId,
      profileId,
      balance,
      transactions,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][BONUS_LEDGER][READ_FATAL]",
      {
        authUserId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BONUS_LEDGER_READ_FAILED",
    });
  }
});

// ============================================================
// AUTODEAR COMPLETED DEAL BONUS — TRUSTED SERVER FLOW
//
// Client sends only requestId.
// Deal state, customer, station and repair amount are loaded from business_requests.
// Bonus amount is calculated only on the AUTODEAR server.
// ============================================================

app.post("/api/bonuses/award-completed-deal", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const authUserId =
    String(
      authUser?.id || ""
    ).trim();

  if (!authUserId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  const requestId =
    String(
      req.body?.requestId || ""
    ).trim();

  if (!requestId) {
    return res.status(400).json({
      ok: false,
      error:
        "BONUS_REQUEST_ID_REQUIRED",
    });
  }

  if (!supabaseServiceRole) {
    console.error(
      "[AUTODEAR][BONUS_AWARD][SERVICE_ROLE_MISSING]"
    );

    return res.status(503).json({
      ok: false,
      error:
        "BONUS_SERVICE_NOT_CONFIGURED",
    });
  }

  try {

    /*
     * business_requests is the canonical source for this award.
     *
     * business_id = owner/business account
     * station_id  = concrete published station card
     *
     */
    const {
      data: businessRequest,
      error: requestError,
    } = await supabaseServiceRole
      .from("business_requests")
      .select(
        "id,business_id,station_id,customer_id,status,repair_amount"
      )
      .eq(
        "id",
        requestId
      )
      .maybeSingle();

    if (requestError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][REQUEST_ERROR]",
        {
          authUserId,
          requestId,
          code:
            requestError.code || null,
          message:
            requestError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_REQUEST_LOOKUP_FAILED",
      });
    }

    if (!businessRequest) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_REQUEST_NOT_FOUND",
      });
    }

    if (
      String(
        businessRequest.status || ""
      ).trim() !== "completed"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_REQUEST_NOT_COMPLETED",
      });
    }

    const stationId =
      String(
        businessRequest.station_id || ""
      ).trim();

    if (!stationId) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_STATION_ID_REQUIRED",
      });
    }

    const {
      data: station,
      error: stationError,
    } = await supabaseServiceRole
      .from("stations")
      .select("id,owner_id")
      .eq(
        "id",
        stationId
      )
      .maybeSingle();

    if (stationError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][STATION_ERROR]",
        {
          authUserId,
          requestId,
          stationId,
          code:
            stationError.code || null,
          message:
            stationError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_STATION_LOOKUP_FAILED",
      });
    }

    if (!station) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_STATION_NOT_FOUND",
      });
    }

    const stationOwnerId =
      String(
        station.owner_id || ""
      ).trim();

    if (stationOwnerId !== authUserId) {
      console.warn(
        "[AUTODEAR][BONUS_AWARD][BUSINESS_MISMATCH]",
        {
          authUserId,
          requestId,
          stationId,
          stationOwnerId,
        }
      );

      return res.status(403).json({
        ok: false,
        error:
          "BONUS_DEAL_ACCESS_DENIED",
      });
    }

    const customerId =
      String(
        businessRequest.customer_id || ""
      ).trim();

    if (!customerId) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_CUSTOMER_NOT_FOUND",
      });
    }

    const {
      data: customerProfile,
      error: customerProfileError,
    } = await supabaseServiceRole
      .from("profiles")
      .select("id,auth_user_id")
      .or(
        `auth_user_id.eq.${customerId},id.eq.${customerId}`
      )
      .limit(1)
      .maybeSingle();

    if (customerProfileError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][CUSTOMER_PROFILE_ERROR]",
        {
          requestId,
          customerId,
          code:
            customerProfileError.code ||
            null,
          message:
            customerProfileError.message ||
            null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_CUSTOMER_LOOKUP_FAILED",
      });
    }

    const profileId =
      String(
        customerProfile?.id || ""
      ).trim();

    if (!profileId) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_CUSTOMER_PROFILE_NOT_FOUND",
      });
    }

    const repairAmount =
      Number(
        businessRequest.repair_amount
      );

    if (
      !Number.isFinite(repairAmount) ||
      repairAmount <= 0
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_REPAIR_AMOUNT_NOT_AVAILABLE",
      });
    }

    const {
      data: subscription,
      error: subscriptionError,
    } = await supabaseServiceRole
      .from("business_subscriptions")
      .select(
        "business_id,plan,active,expires_at"
      )
      .eq(
        "business_id",
        stationOwnerId
      )
      .maybeSingle();

    if (subscriptionError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][SUBSCRIPTION_ERROR]",
        {
          requestId,
          stationId,
          stationOwnerId,
          code:
            subscriptionError.code || null,
          message:
            subscriptionError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_SUBSCRIPTION_LOOKUP_FAILED",
      });
    }

    const nowMs = Date.now();
    const expiresAtMs =
      subscription?.expires_at
        ? Date.parse(subscription.expires_at)
        : NaN;

    const subscriptionActive =
      subscription?.active === true &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > nowMs;

    const rawPlan =
      subscriptionActive
        ? String(
            subscription?.plan || ""
          ).trim()
        : "";

    const commissionPlan =
      rawPlan === "max"
        ? "max"
        : rawPlan === "pro"
          ? "pro"
          : "partner";

    const {
      data: financeSettings,
      error: financeSettingsError,
    } = await supabaseServiceRole
      .from("business_finance_settings")
      .select("*")
      .eq("id", "global")
      .maybeSingle();

    if (financeSettingsError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][FINANCE_SETTINGS_ERROR]",
        {
          requestId,
          code:
            financeSettingsError.code || null,
          message:
            financeSettingsError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_FINANCE_SETTINGS_LOOKUP_FAILED",
      });
    }

    if (!financeSettings) {
      return res.status(503).json({
        ok: false,
        error:
          "BONUS_FINANCE_SETTINGS_NOT_CONFIGURED",
      });
    }

    const commissionRange =
      repairAmount <= 20000
        ? "up_to_20000"
        : repairAmount <= 50000
          ? "up_to_50000"
          : "above_50000";

    const commissionColumn =
      `commission_${commissionRange}_${commissionPlan}`;

    const commissionPercent =
      Number(
        financeSettings[
          commissionColumn
        ]
      );

    if (
      !Number.isFinite(commissionPercent) ||
      commissionPercent < 0 ||
      commissionPercent > 100
    ) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][INVALID_COMMISSION]",
        {
          requestId,
          commissionColumn,
          commissionPercent,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_COMMISSION_INVALID",
      });
    }

    const platformRevenue =
      Math.round(
        repairAmount *
          commissionPercent /
          100
      );

    if (platformRevenue <= 0) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_PLATFORM_REVENUE_NOT_AVAILABLE",
      });
    }

    const bonusAmount =
      calculateAutodearDealBonus(
        platformRevenue
      );

    if (
      !Number.isInteger(bonusAmount) ||
      bonusAmount <= 0
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_AWARD_NOT_AVAILABLE",
      });
    }

    const sourceType =
      "business_request";

    /*
     * Idempotency is enforced by the bonus ledger unique source
     * index. First return an existing award when this request was
     * already processed.
     */
    const {
      data: existingBonus,
      error: existingError,
    } = await supabaseServiceRole
      .from("bonuses")
      .select(
        "id,user_id,title,amount,type,expires_at,source_type,source_id,created_at"
      )
      .eq(
        "user_id",
        profileId
      )
      .eq(
        "source_type",
        sourceType
      )
      .eq(
        "source_id",
        requestId
      )
      .eq(
        "type",
        "income"
      )
      .maybeSingle();

    if (existingError) {
      console.error(
        "[AUTODEAR][BONUS_AWARD][EXISTING_ERROR]",
        {
          requestId,
          profileId,
          code:
            existingError.code || null,
          message:
            existingError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_AWARD_LOOKUP_FAILED",
      });
    }

    if (existingBonus) {
      return res.json({
        ok: true,
        duplicate: true,
        requestId,
        bonus:
          existingBonus,
      });
    }

    const createdAt =
      new Date();

    const expiresAt =
      new Date(
        createdAt.getTime() +
          AUTODEAR_BONUS_ECONOMICS
            .lifetimeDays *
            24 *
            60 *
            60 *
            1000
      );

    const bonusRow = {
      id:
        `bonus_deal_${requestId}`,
      user_id:
        profileId,
      title:
        "Бонусы за визит",
      amount:
        bonusAmount,
      type:
        "income",
      expires_at:
        expiresAt.toISOString(),
      source_type:
        sourceType,
      source_id:
        requestId,
      created_at:
        createdAt.toISOString(),
    };

    const {
      data: insertedBonus,
      error: insertError,
    } = await supabaseServiceRole
      .from("bonuses")
      .insert(
        bonusRow
      )
      .select(
        "id,user_id,title,amount,type,expires_at,source_type,source_id,created_at"
      )
      .single();

    if (insertError) {
      /*
       * A concurrent retry may win the unique source race.
       * Re-read the canonical row instead of creating another award.
       */
      if (
        String(
          insertError.code || ""
        ) === "23505"
      ) {
        const {
          data: duplicateBonus,
          error: duplicateError,
        } = await supabaseServiceRole
          .from("bonuses")
          .select(
            "id,user_id,title,amount,type,expires_at,source_type,source_id,created_at"
          )
          .eq(
            "user_id",
            profileId
          )
          .eq(
            "source_type",
            sourceType
          )
          .eq(
            "source_id",
            requestId
          )
          .eq(
            "type",
            "income"
          )
          .maybeSingle();

        if (
          !duplicateError &&
          duplicateBonus
        ) {
          return res.json({
            ok: true,
            duplicate: true,
            requestId,
            bonus:
              duplicateBonus,
          });
        }
      }

      console.error(
        "[AUTODEAR][BONUS_AWARD][INSERT_ERROR]",
        {
          requestId,
          profileId,
          code:
            insertError.code || null,
          message:
            insertError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_AWARD_INSERT_FAILED",
      });
    }

    console.log(
      "[AUTODEAR][BONUS_AWARD][OK]",
      {
        authUserId,
        profileId,
        requestId,
        platformRevenue,
        bonusAmount,
      }
    );

    /*
     * Бонус к этому моменту уже записан.
     * Уведомление и push — вторичные каналы доставки:
     * их ошибка не должна отменять начисление.
     */
    try {
      const bonusTitle = "Бонусы начислены";
      const bonusBody =
        `Вам начислено ${bonusAmount} бонусов AUTODEAR.`;

      const bonusRelatedId =
        String(
          insertedBonus?.id || ""
        ).trim();

      const bonusPushData = {
        type: "bonus_earned",
        eventType: "bonus_earned",
        category: "bonus",
        bonusId:
          bonusRelatedId || null,
        requestId,
        amount: bonusAmount,
        route: "/profile/bonuses",
      };

      const {
        error: bonusNotificationError,
      } = await supabaseServiceRole
        .from("notifications")
        .insert({
          recipient_role: "user",
          recipient_id: customerId,
          title: bonusTitle,
          body: bonusBody,
          type: "bonus",
          related_type: "bonus_earned",
          related_id:
            bonusRelatedId || requestId,
          is_read: false,
        });

      if (bonusNotificationError) {
        console.warn(
          "[AUTODEAR][BONUS_AWARD][NOTIFICATION_ERROR]",
          {
            requestId,
            customerId,
            code:
              bonusNotificationError.code || null,
            message:
              bonusNotificationError.message || null,
          }
        );
      }

      try {
        const {
          data: bonusTokenRows,
          error: bonusTokensError,
        } = await supabaseServiceRole
          .from("device_push_tokens")
          .select("expo_push_token")
          .eq("user_id", customerId)
          .eq("is_active", true);

        if (bonusTokensError) {
          throw bonusTokensError;
        }

        const bonusTokens =
          (Array.isArray(bonusTokenRows)
            ? bonusTokenRows
            : [])
            .map((row) =>
              String(
                row?.expo_push_token || ""
              ).trim()
            )
            .filter(Boolean);

        if (bonusTokens.length) {
          await sendAutodearExpoPush({
            tokens: bonusTokens,
            title: bonusTitle,
            body: bonusBody,
            data: bonusPushData,
          });
        }
      } catch (pushError) {
        console.warn(
          "[AUTODEAR][BONUS_AWARD][PUSH_ERROR]",
          {
            requestId,
            customerId,
            message:
              pushError?.message ||
              String(pushError),
          }
        );
      }
    } catch (notificationError) {
      console.warn(
        "[AUTODEAR][BONUS_AWARD][NOTIFICATION_ERROR]",
        {
          requestId,
          customerId,
          message:
            notificationError?.message ||
            String(notificationError),
        }
      );
    }

    return res.json({
      ok: true,
      duplicate: false,
      requestId,
      platformRevenue,
      bonusAmount,
      bonus:
        insertedBonus,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][BONUS_AWARD][FATAL]",
      {
        authUserId,
        requestId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BONUS_AWARD_FAILED",
    });
  }
});


// ============================================================
// AUTODEAR BONUS REDEMPTION — TRUSTED SERVER FLOW
//
// Client sends only:
//   requestId
//   requestedBonus
//
// Financial context is NEVER trusted from the client.
// Customer, station, completion status and repair amount are
// loaded from business_requests by the server.
//
// The actual ledger expense is created only by the
// service-role-only PostgreSQL RPC.
// ============================================================

app.post("/api/bonuses/redeem", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUser =
    authResult?.user || null;

  const authUserId =
    String(
      authUser?.id || ""
    ).trim();

  if (!authUserId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  const requestId =
    String(
      req.body?.requestId || ""
    ).trim();

  const requestedBonus =
    Number(
      req.body?.requestedBonus
    );

  if (!requestId) {
    return res.status(400).json({
      ok: false,
      error:
        "BONUS_REQUEST_ID_REQUIRED",
    });
  }

  if (
    !Number.isInteger(requestedBonus) ||
    requestedBonus <= 0
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "BONUS_AMOUNT_INVALID",
    });
  }

  /*
   * Fail closed.
   *
   * The ordinary `supabase` client may intentionally support
   * an anon fallback elsewhere in the server. Financial bonus
   * spending must NEVER use that fallback.
   */
  if (!supabaseServiceRole) {
    console.error(
      "[AUTODEAR][BONUS_REDEEM][SERVICE_ROLE_MISSING]"
    );

    return res.status(503).json({
      ok: false,
      error:
        "BONUS_SERVICE_NOT_CONFIGURED",
    });
  }

  try {
    /*
     * Resolve auth UUID -> canonical AUTODEAR profile UUID.
     * Legacy profiles are supported by checking both columns.
     */
    const {
      data: profile,
      error: profileError,
    } = await supabaseServiceRole
      .from("profiles")
      .select("id,auth_user_id")
      .or(
        `auth_user_id.eq.${authUserId},id.eq.${authUserId}`
      )
      .limit(1)
      .maybeSingle();

    if (profileError) {
      console.error(
        "[AUTODEAR][BONUS_REDEEM][PROFILE_ERROR]",
        {
          authUserId,
          code:
            profileError.code || null,
          message:
            profileError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_PROFILE_LOOKUP_FAILED",
      });
    }

    const profileId =
      String(
        profile?.id || ""
      ).trim();

    if (!profileId) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_PROFILE_NOT_FOUND",
      });
    }

    /*
     * SECURITY:
     * Request ID comes from the client, but all financial
     * properties are loaded from the database.
     */
    const {
      data: businessRequest,
      error: requestError,
    } = await supabaseServiceRole
      .from("business_requests")
      .select(
        "id,customer_id,business_id,station_id,status,repair_amount"
      )
      .eq(
        "id",
        requestId
      )
      .maybeSingle();

    if (requestError) {
      console.error(
        "[AUTODEAR][BONUS_REDEEM][REQUEST_ERROR]",
        {
          authUserId,
          profileId,
          requestId,
          code:
            requestError.code || null,
          message:
            requestError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_REQUEST_LOOKUP_FAILED",
      });
    }

    if (!businessRequest) {
      return res.status(404).json({
        ok: false,
        error:
          "BONUS_REQUEST_NOT_FOUND",
      });
    }

    const requestCustomerId =
      String(
        businessRequest.customer_id ||
        ""
      ).trim();

    /*
     * New AUTODEAR accounts normally have profile.id equal to
     * auth user UUID. Keep authUserId compatibility for legacy
     * request rows while canonical profileId remains the ledger
     * identity passed to PostgreSQL.
     */
    if (
      !requestCustomerId ||
      (
        requestCustomerId !== profileId &&
        requestCustomerId !== authUserId
      )
    ) {
      console.warn(
        "[AUTODEAR][BONUS_REDEEM][CUSTOMER_MISMATCH]",
        {
          authUserId,
          profileId,
          requestId,
        }
      );

      return res.status(403).json({
        ok: false,
        error:
          "BONUS_REQUEST_ACCESS_DENIED",
      });
    }

    if (
      String(
        businessRequest.status ||
        ""
      ).trim() !== "completed"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_REQUEST_NOT_COMPLETED",
      });
    }

    const stationId =
      String(
        businessRequest.station_id ||
        businessRequest.business_id ||
        ""
      ).trim();

    if (!stationId) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_STATION_NOT_FOUND",
      });
    }

    const serviceAmount =
      Number(
        businessRequest.repair_amount
      );

    if (
      !Number.isFinite(serviceAmount) ||
      serviceAmount <= 0
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "BONUS_SERVICE_AMOUNT_NOT_AVAILABLE",
      });
    }

    /*
     * The RPC performs:
     * - active partner validation
     * - payment percentage limit
     * - current non-expired balance calculation
     * - idempotency
     * - customer-level concurrency lock
     * - immutable expense creation
     * - FEFO/FIFO allocation
     */
    const {
      data: redeemResult,
      error: redeemError,
    } = await supabaseServiceRole.rpc(
      "autodear_redeem_partner_bonus",
      {
        p_customer_id:
          profileId,

        p_station_id:
          stationId,

        p_source_type:
          "business_request",

        p_source_id:
          requestId,

        p_service_amount:
          serviceAmount,

        p_requested_bonus:
          requestedBonus,
      }
    );

    if (redeemError) {
      console.error(
        "[AUTODEAR][BONUS_REDEEM][RPC_ERROR]",
        {
          authUserId,
          profileId,
          requestId,
          stationId,
          code:
            redeemError.code || null,
          message:
            redeemError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "BONUS_REDEEM_FAILED",
      });
    }

    if (
      !redeemResult ||
      redeemResult.ok !== true
    ) {
      const rpcError =
        String(
          redeemResult?.error ||
          "BONUS_REDEEM_REJECTED"
        );

      const status =
        rpcError ===
          "BONUS_PARTNER_NOT_ACTIVE"
          ? 409
          : rpcError ===
              "BONUS_AMOUNT_EXCEEDS_LIMIT"
            ? 409
            : rpcError ===
                "BONUS_NOT_AVAILABLE"
              ? 409
              : 400;

      return res.status(status).json({
        ...(redeemResult || {}),
        ok: false,
      });
    }

    console.log(
      "[AUTODEAR][BONUS_REDEEM][OK]",
      {
        authUserId,
        profileId,
        requestId,
        stationId,
        approvedBonus:
          redeemResult.approvedBonus ||
          0,
        duplicate:
          redeemResult.duplicate ===
          true,
      }
    );

    return res.json({
      ok: true,
      requestId,
      stationId,
      result:
        redeemResult,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][BONUS_REDEEM][FATAL]",
      {
        authUserId,
        requestId,
        message:
          error?.message ||
          String(error),
      }
    );

    return res.status(500).json({
      ok: false,
      error:
        "BONUS_REDEEM_FAILED",
    });
  }
});


// ============================================================
// AUTODEAR LISTINGS — SERVER PRICE REDUCTION
//
// Источник истины: Supabase.
//
// Клиент передаёт только:
// - listingId в URL;
// - новую цену;
// - operationKey.
//
// Сервер сам:
// - проверяет auth;
// - проверяет владельца;
// - проверяет, что цена действительно уменьшена;
// - считает процент;
// - сохраняет историю;
// - после успешной записи запускает уведомления
//   пользователям, у которых объявление в избранном.
// ============================================================

function formatAutodearListingPrice(value) {
  return `${new Intl.NumberFormat(
    "ru-RU"
  ).format(
    Math.max(
      0,
      Math.round(
        Number(value) || 0
      )
    )
  )} ₽`;
}


async function sendAutodearListingPriceFcmPush({
  tokens,
  title,
  body,
  data,
}) {
  const cleanTokens =
    Array.from(
      new Set(
        (
          Array.isArray(tokens)
            ? tokens
            : []
        )
          .map(
            (item) =>
              String(
                item || ""
              ).trim()
          )
          .filter(Boolean)
      )
    );

  if (!cleanTokens.length) {
    return {
      ok: true,
      sent: 0,
      reason:
        "NO_PUSH_TOKENS",
    };
  }

  /*
   * device_push_tokens.expo_push_token —
   * историческое имя колонки.
   * Сейчас внутри хранится настоящий FCM token.
   */
  const functionBaseUrl =
    String(
      process.env.SUPABASE_URL ||
      process.env
        .EXPO_PUBLIC_SUPABASE_URL ||
      ""
    )
      .trim()
      .replace(
        /\/+$/,
        ""
      );

  const functionKey =
    String(
      process.env.SUPABASE_ANON_KEY ||
      process.env
        .EXPO_PUBLIC_SUPABASE_ANON_KEY ||
      process.env
        .SUPABASE_SERVICE_ROLE_KEY ||
      ""
    ).trim();

  if (!functionBaseUrl) {
    throw new Error(
      "LISTING_PRICE_FCM_SUPABASE_URL_MISSING"
    );
  }

  if (!functionKey) {
    throw new Error(
      "LISTING_PRICE_FCM_SUPABASE_KEY_MISSING"
    );
  }

  const response =
    await fetch(
      `${functionBaseUrl}/functions/v1/send-fcm-push`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          apikey:
            functionKey,

          Authorization:
            `Bearer ${functionKey}`,
        },

        body:
          JSON.stringify({
            title:
              String(
                title || ""
              ),

            body:
              String(
                body || ""
              ),

            type:
              data?.type ||
              data?.eventType ||
              "listing_price_reduced",

            data:
              data || {},

            tokens:
              cleanTokens,
          }),
      }
    );

  const responseText =
    await response.text();

  let payload = null;

  try {
    payload =
      JSON.parse(
        responseText
      );
  } catch {
    payload = {
      raw:
        responseText,
    };
  }

  if (
    !response.ok ||
    payload?.ok !== true
  ) {
    throw new Error(
      `LISTING_PRICE_FCM_FAILED_${response.status}: ${
        payload?.reason ||
        responseText
      }`
    );
  }

  return {
    ok: true,

    sent:
      Number(
        payload?.sent || 0
      ),

    total:
      cleanTokens.length,

    payload,
  };
}


async function notifyAutodearListingPriceReduced({
  listingId,
  ownerId,
  title,
  previousPrice,
  nextPrice,
  priceDropAmount,
  priceChangePercent,
  operationKey,
}) {
  if (!supabaseServiceRole) {
    throw new Error(
      "LISTING_PRICE_REDUCTION_SERVICE_ROLE_MISSING"
    );
  }

  const {
    data: favoriteRows,
    error: favoritesError,
  } =
    await supabaseServiceRole
      .from("favorites")
      .select("user_id")
      .eq(
        "target_type",
        "listing"
      )
      .eq(
        "target_id",
        listingId
      )
      .eq(
        "status",
        "active"
      );

  if (favoritesError) {
    throw favoritesError;
  }

  const recipientIds =
    Array.from(
      new Set(
        (
          Array.isArray(
            favoriteRows
          )
            ? favoriteRows
            : []
        )
          .map(
            (row) =>
              String(
                row?.user_id ||
                ""
              ).trim()
          )
          .filter(
            (userId) =>
              Boolean(userId) &&
              userId !==
                String(
                  ownerId ||
                  ""
                ).trim()
          )
      )
    );

  if (!recipientIds.length) {
    console.log(
      "[AUTODEAR][LISTING_PRICE_REDUCTION][NO_RECIPIENTS]",
      {
        listingId,
        operationKey,
      }
    );

    return {
      recipients: 0,
      pushSent: 0,
    };
  }

  const notificationTitle =
    `Цена снижена на ${priceChangePercent}%`;

  const notificationBody =
    `«${
      String(
        title ||
        "Объявление AUTODEAR"
      ).trim()
    }»: ` +
    `${formatAutodearListingPrice(
      previousPrice
    )} → ` +
    `${formatAutodearListingPrice(
      nextPrice
    )}. ` +
    `Экономия ${formatAutodearListingPrice(
      priceDropAmount
    )}.`;

  /*
   * Внутренние уведомления создаём независимо
   * от наличия FCM-токена.
   */
  const notificationRows =
    recipientIds.map(
      (recipientId) => ({
        recipient_role:
          "user",

        recipient_id:
          recipientId,

        title:
          notificationTitle,

        body:
          notificationBody,

        type:
          "listing_price_reduced",

        related_type:
          "listing",

        related_id:
          listingId,

        is_read:
          false,
      })
    );

  const {
    error: notificationError,
  } =
    await supabaseServiceRole
      .from("notifications")
      .insert(
        notificationRows
      );

  if (notificationError) {
    console.error(
      "[AUTODEAR][LISTING_PRICE_REDUCTION][NOTIFICATION_INSERT_ERROR]",
      {
        listingId,
        operationKey,
        code:
          notificationError.code ||
          null,
        message:
          notificationError.message ||
          null,
      }
    );

    /*
     * Push всё равно пробуем отправить.
     * Изменение цены уже состоялось.
     */
  }

  const {
    data: tokenRows,
    error: tokensError,
  } =
    await supabaseServiceRole
      .from(
        "device_push_tokens"
      )
      .select(
        "user_id,expo_push_token"
      )
      .in(
        "user_id",
        recipientIds
      )
      .eq(
        "is_active",
        true
      );

  if (tokensError) {
    throw tokensError;
  }

  const tokens =
    Array.from(
      new Set(
        (
          Array.isArray(
            tokenRows
          )
            ? tokenRows
            : []
        )
          .map(
            (row) =>
              String(
                row?.expo_push_token ||
                ""
              ).trim()
          )
          .filter(Boolean)
      )
    );

  let pushSent = 0;

  if (tokens.length) {
    const pushResult =
      await sendAutodearListingPriceFcmPush({
        tokens,

        title:
          notificationTitle,

        body:
          notificationBody,

        data: {
          type:
            "listing_price_reduced",

          eventType:
            "listing_price_reduced",

          category:
            "listing",

          listingId,

          relatedType:
            "listing",

          relatedId:
            listingId,

          route:
            `/listing/${encodeURIComponent(
              listingId
            )}`,
        },
      });

    pushSent =
      Number(
        pushResult?.sent || 0
      );
  }

  console.log(
    "[AUTODEAR][LISTING_PRICE_REDUCTION][NOTIFIED]",
    {
      listingId,
      operationKey,
      recipients:
        recipientIds.length,
      tokens:
        tokens.length,
      pushSent,
    }
  );

  return {
    recipients:
      recipientIds.length,
    pushSent,
  };
}


app.post(
  "/api/listings/:listingId/reduce-price",
  async (req, res) => {
    const startedAt =
      Date.now();

    const authResult =
      await resolveAuthenticatedUser(
        req
      );

    const authUserId =
      String(
        authResult?.user?.id ||
        ""
      ).trim();

    if (!authUserId) {
      return res.status(401).json({
        ok: false,
        error:
          authResult?.error ||
          "AUTH_REQUIRED",
      });
    }

    if (!supabaseServiceRole) {
      return res.status(503).json({
        ok: false,
        error:
          "LISTING_PRICE_REDUCTION_SERVICE_NOT_CONFIGURED",
      });
    }

    const listingId =
      String(
        req.params?.listingId ||
        ""
      ).trim();

    const nextPrice =
      Number(
        req.body?.nextPrice
      );

    const operationKey =
      String(
        req.body?.operationKey ||
        ""
      ).trim();

    if (!listingId) {
      return res.status(400).json({
        ok: false,
        error:
          "LISTING_ID_REQUIRED",
      });
    }

    if (
      !Number.isFinite(
        nextPrice
      ) ||
      nextPrice <= 0 ||
      !Number.isInteger(
        nextPrice
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_NEXT_PRICE",
      });
    }

    if (
      !operationKey ||
      operationKey.length > 220
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_OPERATION_KEY",
      });
    }

    try {
      const {
        data: listing,
        error: listingError,
      } =
        await supabaseServiceRole
          .from("listings")
          .select(
            [
              "id",
              "owner_id",
              "title",
              "price",
              "status",
              "extra_fields",
              "payload",
              "updated_at",
            ].join(",")
          )
          .eq(
            "id",
            listingId
          )
          .maybeSingle();

      if (listingError) {
        throw listingError;
      }

      if (!listing) {
        return res.status(404).json({
          ok: false,
          error:
            "LISTING_NOT_FOUND",
        });
      }

      const ownerId =
        String(
          listing?.owner_id ||
          listing?.payload
            ?.ownerId ||
          ""
        ).trim();

      if (
        !ownerId ||
        ownerId !==
          authUserId
      ) {
        console.warn(
          "[AUTODEAR][LISTING_PRICE_REDUCTION][OWNER_MISMATCH]",
          {
            listingId,
            authUserId,
            ownerId,
          }
        );

        return res.status(403).json({
          ok: false,
          error:
            "LISTING_OWNER_FORBIDDEN",
        });
      }

      if (
        String(
          listing?.status ||
          ""
        ).toLowerCase() !==
        "active"
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "LISTING_NOT_ACTIVE",
        });
      }

      const previousPrice =
        Math.round(
          Number(
            listing?.price ||
            listing?.payload
              ?.price ||
            0
          )
        );

      if (
        !Number.isFinite(
          previousPrice
        ) ||
        previousPrice <= 0
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "LISTING_CURRENT_PRICE_INVALID",
        });
      }

      const payload =
        listing?.payload &&
        typeof listing.payload ===
          "object"
          ? listing.payload
          : {};

      const rowExtraFields =
        listing?.extra_fields &&
        typeof listing
          .extra_fields ===
          "object"
          ? listing.extra_fields
          : {};

      const payloadExtraFields =
        payload?.extraFields &&
        typeof payload
          .extraFields ===
          "object"
          ? payload.extraFields
          : {};

      const currentExtraFields = {
        ...rowExtraFields,
        ...payloadExtraFields,
      };

      const currentTracking =
        currentExtraFields
          ?.priceTracking &&
        typeof currentExtraFields
          .priceTracking ===
          "object"
          ? currentExtraFields
              .priceTracking
          : {};

      /*
       * Проверяем, работает ли уже автоснижение.
       *
       * Ручное дополнительное снижение больше
       * не должно автоматически отменять план.
       */
      const {
        data: activePricePlan,
        error: activePricePlanError,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .select("*")
          .eq(
            "listing_id",
            listingId
          )
          .eq(
            "owner_id",
            authUserId
          )
          .eq(
            "status",
            "active"
          )
          .maybeSingle();

      if (activePricePlanError) {
        throw activePricePlanError;
      }

      /*
       * Безопасный повтор того же запроса:
       * цену второй раз не меняем и push
       * второй раз не запускаем.
       */
      if (
        String(
          currentTracking
            ?.lastOperationKey ||
          ""
        ) === operationKey &&
        previousPrice ===
          nextPrice
      ) {
        return res.json({
          ok: true,
          duplicate: true,
          listingId,
          previousPrice:
            Number(
              currentTracking
                ?.previousPrice ||
              previousPrice
            ),
          price:
            nextPrice,
          priceChangePercent:
            Number(
              currentTracking
                ?.priceChangePercent ||
              0
            ),

          cumulativeDropPercent:
            Number(
              currentTracking
                ?.cumulativeDropPercent ||
              currentTracking
                ?.priceChangePercent ||
              0
            ),

          reductionBasePrice:
            Number(
              currentTracking
                ?.reductionBasePrice ||
              currentTracking
                ?.gradualPlan
                ?.startPrice ||
              previousPrice
            ),

          priceDropAmount:
            Math.abs(
              Number(
                currentTracking
                  ?.priceChangeAmount ||
                0
              )
            ),
        });
      }

      if (
        nextPrice >=
        previousPrice
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "PRICE_MUST_BE_LOWER",
          currentPrice:
            previousPrice,
        });
      }

      const priceChangeAmount =
        nextPrice -
        previousPrice;

      const priceDropAmount =
        previousPrice -
        nextPrice;

      const priceChangePercent =
        Math.max(
          1,
          Math.round(
            (
              priceDropAmount /
              previousPrice
            ) *
              100
          )
        );

      const trackingPlanId =
        String(
          currentTracking
            ?.gradualPlan
            ?.id ||
          ""
        ).trim();

      const activePlanId =
        String(
          activePricePlan
            ?.id ||
          ""
        ).trim();

      const badgeCycleActive =
        Boolean(
          currentTracking
            ?.badgeVisibleUntil &&
          Number.isFinite(
            Date.parse(
              String(
                currentTracking
                  .badgeVisibleUntil
              )
            )
          ) &&
          Date.parse(
            String(
              currentTracking
                .badgeVisibleUntil
            )
          ) >
            Date.now()
        );

      const existingCycleBase =
        Math.round(
          Number(
            currentTracking
              ?.reductionBasePrice ||
            0
          )
        );

      const gradualHumanStartPrice =
        Math.round(
          Number(
            trackingPlanId &&
            trackingPlanId ===
              activePlanId
              ? currentTracking
                  ?.gradualPlan
                  ?.startPrice
              : activePricePlan
                  ?.start_price ||
                0
          )
        );

      const reductionBasePrice =
        activePricePlan &&
        gradualHumanStartPrice > 0
          ? gradualHumanStartPrice
          : badgeCycleActive &&
            existingCycleBase > 0
            ? existingCycleBase
            : previousPrice;

      const cumulativeDropPercent =
        Math.max(
          1,
          Math.round(
            (
              (
                reductionBasePrice -
                nextPrice
              ) /
              reductionBasePrice
            ) *
              100
          )
        );

      const changedAt =
        new Date()
          .toISOString();

      const badgeVisibleUntil =
        new Date(
          Date.now() +
            7 *
              24 *
              60 *
              60 *
              1000
        ).toISOString();

      const currentHistory =
        Array.isArray(
          currentTracking
            ?.history
        )
          ? currentTracking
              .history
          : [];

      const historyEntry = {
        from:
          previousPrice,
        to:
          nextPrice,
        amount:
          priceChangeAmount,
        percent:
          priceChangePercent,
        direction:
          "down",
        changedAt,
        operationKey,
      };

      const nextGradualPlanTracking =
        activePricePlan
          ? {
              ...(
                currentTracking
                  ?.gradualPlan &&
                typeof currentTracking
                  .gradualPlan ===
                  "object"
                  ? currentTracking
                      .gradualPlan
                  : {}
              ),

              id:
                activePlanId,

              active:
                nextPrice >
                Number(
                  activePricePlan
                    ?.target_price ||
                  0
                ),

              startPrice:
                reductionBasePrice,

              targetPrice:
                Number(
                  activePricePlan
                    ?.target_price ||
                  0
                ),

              durationDays:
                Number(
                  activePricePlan
                    ?.duration_days ||
                  0
                ),

              completedSteps:
                Number(
                  activePricePlan
                    ?.completed_steps ||
                  0
                ),

              totalSteps:
                Number(
                  activePricePlan
                    ?.total_steps ||
                  0
                ),

              startedAt:
                activePricePlan
                  ?.started_at ||
                null,

              nextRunAt:
                nextPrice >
                Number(
                  activePricePlan
                    ?.target_price ||
                  0
                )
                  ? activePricePlan
                      ?.next_run_at ||
                    null
                  : null,
            }
          : currentTracking
              ?.gradualPlan ||
            null;

      const nextTracking = {
        ...currentTracking,

        previousPrice,
        currentPrice:
          nextPrice,

        priceChangeAmount,
        priceChangePercent,

        reductionBasePrice,
        cumulativeDropPercent,

        ...(nextGradualPlanTracking
          ? {
              gradualPlan:
                nextGradualPlanTracking,
            }
          : {}),

        direction:
          "down",

        changedAt,
        badgeVisibleUntil,

        lastOperationKey:
          operationKey,

        history: [
          historyEntry,
          ...currentHistory,
        ].slice(
          0,
          20
        ),
      };

      const nextExtraFields = {
        ...currentExtraFields,

        priceTracking:
          nextTracking,
      };

      const nextPayload = {
        ...payload,

        price:
          String(
            nextPrice
          ),

        extraFields:
          nextExtraFields,
      };

      /*
       * Оптимистическая защита:
       * если между SELECT и UPDATE другой запрос
       * уже изменил цену, этот запрос ничего
       * не перезаписывает.
       */
      const {
        data: updatedListing,
        error: updateError,
      } =
        await supabaseServiceRole
          .from("listings")
          .update({
            price:
              nextPrice,

            extra_fields:
              nextExtraFields,

            payload:
              nextPayload,

            updated_at:
              changedAt,
          })
          .eq(
            "id",
            listingId
          )
          .eq(
            "owner_id",
            authUserId
          )
          .eq(
            "price",
            previousPrice
          )
          .select(
            "id,owner_id,title,price,status,extra_fields,payload,updated_at"
          )
          .maybeSingle();

      if (updateError) {
        throw updateError;
      }

      if (!updatedListing) {
        return res.status(409).json({
          ok: false,
          error:
            "LISTING_PRICE_CONFLICT",
        });
      }

      console.log(
        "[AUTODEAR][LISTING_PRICE_REDUCTION][SAVED]",
        {
          listingId,
          ownerId:
            authUserId,
          operationKey,
          previousPrice,
          nextPrice,
          priceChangePercent,
          ms:
            Date.now() -
            startedAt,
        }
      );

      /*
       * Ручное дополнительное снижение не отменяет
       * уже работающий gradual-план.
       *
       * Если ручная цена дошла до цели — план
       * считается завершённым.
       *
       * Если цель ещё впереди — математически
       * перебазируем start_price плана, сохраняя
       * target_price, completed_steps и расписание.
       */
      let pricePlanStillActive =
        false;

      if (activePricePlan) {
        const planId =
          String(
            activePricePlan
              ?.id ||
            ""
          ).trim();

        const planTargetPrice =
          Math.round(
            Number(
              activePricePlan
                ?.target_price ||
              0
            )
          );

        const planCompletedSteps =
          Math.max(
            0,
            Math.round(
              Number(
                activePricePlan
                  ?.completed_steps ||
                0
              )
            )
          );

        const planTotalSteps =
          Math.max(
            1,
            Math.round(
              Number(
                activePricePlan
                  ?.total_steps ||
                activePricePlan
                  ?.duration_days ||
                1
              )
            )
          );

        if (
          planId &&
          planTargetPrice > 0 &&
          nextPrice <=
            planTargetPrice
        ) {
          const {
            error: completePlanError,
          } =
            await supabaseServiceRole
              .from(
                "listing_price_reduction_plans"
              )
              .update({
                completed_steps:
                  planTotalSteps,

                status:
                  "completed",

                last_run_at:
                  changedAt,

                next_run_at:
                  null,

                completed_at:
                  changedAt,

                updated_at:
                  changedAt,

                last_error:
                  null,
              })
              .eq(
                "id",
                planId
              )
              .eq(
                "status",
                "active"
              )
              .eq(
                "completed_steps",
                planCompletedSteps
              );

          if (completePlanError) {
            throw completePlanError;
          }

          pricePlanStillActive =
            false;
        } else if (
          planId &&
          planTargetPrice > 0 &&
          planCompletedSteps <
            planTotalSteps
        ) {
          const remainingSteps =
            planTotalSteps -
            planCompletedSteps;

          let rebasedStartPrice =
            planCompletedSteps <= 0
              ? nextPrice
              : Math.round(
                  (
                    nextPrice *
                      planTotalSteps -
                    planTargetPrice *
                      planCompletedSteps
                  ) /
                  remainingSteps
                );

          /*
           * Основная формула округляет цену.
           * Подбираем ближайший start_price,
           * который даёт текущую ручную цену
           * точно на completed_steps.
           */
          if (
            planCompletedSteps > 0
          ) {
            let exactCandidate =
              null;

            for (
              let delta = -20;
              delta <= 20;
              delta += 1
            ) {
              const candidate =
                rebasedStartPrice +
                delta;

              if (
                candidate <=
                planTargetPrice
              ) {
                continue;
              }

              const candidatePrice =
                getAutodearListingPricePlanPrice(
                  {
                    ...activePricePlan,

                    start_price:
                      candidate,
                  },
                  planCompletedSteps
                );

              if (
                candidatePrice ===
                nextPrice
              ) {
                exactCandidate =
                  candidate;

                break;
              }
            }

            if (
              exactCandidate !==
              null
            ) {
              rebasedStartPrice =
                exactCandidate;
            } else {
              throw new Error(
                "PRICE_PLAN_REBASE_ROUNDING_FAILED"
              );
            }
          }

          const {
            data: rebasedPlan,
            error: rebasePlanError,
          } =
            await supabaseServiceRole
              .from(
                "listing_price_reduction_plans"
              )
              .update({
                start_price:
                  rebasedStartPrice,

                updated_at:
                  changedAt,

                last_error:
                  null,
              })
              .eq(
                "id",
                planId
              )
              .eq(
                "status",
                "active"
              )
              .eq(
                "completed_steps",
                planCompletedSteps
              )
              .select(
                "id,status,start_price,target_price,completed_steps,total_steps,next_run_at"
              )
              .maybeSingle();

          if (rebasePlanError) {
            throw rebasePlanError;
          }

          if (!rebasedPlan) {
            throw new Error(
              "PRICE_PLAN_REBASE_CONFLICT"
            );
          }

          pricePlanStillActive =
            true;

          console.log(
            "[AUTODEAR][LISTING_PRICE_PLAN][REBASED_AFTER_MANUAL]",
            {
              planId,
              listingId,
              previousPrice,
              nextPrice,
              humanStartPrice:
                reductionBasePrice,
              internalStartPrice:
                rebasedStartPrice,
              targetPrice:
                planTargetPrice,
              completedSteps:
                planCompletedSteps,
              totalSteps:
                planTotalSteps,
              nextRunAt:
                rebasedPlan
                  ?.next_run_at ||
                null,
            }
          );
        }
      }


      /*
       * Цена УЖЕ подтверждена сервером.
       *
       * Push и внутренние уведомления не должны
       * держать продавца на кнопке «Подождите».
       * Рассылка идёт после подтверждённой записи.
       */
      void notifyAutodearListingPriceReduced({
        listingId,

        ownerId:
          authUserId,

        title:
          updatedListing?.title ||
          listing?.title ||
          "Объявление AUTODEAR",

        previousPrice,
        nextPrice,
        priceDropAmount,
        priceChangePercent,
        operationKey,
      }).catch(
        (notificationError) => {
          console.error(
            "[AUTODEAR][LISTING_PRICE_REDUCTION][NOTIFY_ERROR]",
            {
              listingId,
              operationKey,
              message:
                notificationError
                  ?.message ||
                String(
                  notificationError
                ),
            }
          );
        }
      );

      return res.json({
        ok: true,
        duplicate: false,

        listingId,

        previousPrice,

        price:
          nextPrice,

        priceDropAmount,

        priceChangePercent,

        cumulativeDropPercent,

        reductionBasePrice,

        pricePlanActive:
          pricePlanStillActive,

        changedAt,

        badgeVisibleUntil,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][LISTING_PRICE_REDUCTION][FATAL]",
        {
          listingId,
          operationKey,
          message:
            error?.message ||
            String(error),
          ms:
            Date.now() -
            startedAt,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "LISTING_PRICE_REDUCTION_FAILED",
      });
    }
  }
);


// ============================================================
// AUTODEAR LISTINGS — GRADUAL PRICE REDUCTION
// Сервер постепенно ведёт цену от start_price к target_price.
// Телефон продавца может быть выключен.
// ============================================================

const AUTODEAR_LISTING_PRICE_PLAN_DURATIONS =
  new Set([
    3,
    5,
    7,
    10,
    14,
    30,
  ]);

const AUTODEAR_LISTING_PRICE_PLAN_DAY_MS =
  24 *
  60 *
  60 *
  1000;

const AUTODEAR_LISTING_PRICE_PLAN_INTERVAL_MS =
  60 * 1000;

let autodearListingPricePlanSchedulerRunning =
  false;


function createAutodearListingPricePlanId() {
  return [
    "priceplan",
    Date.now()
      .toString(36),
    Math.random()
      .toString(36)
      .slice(
        2,
        14
      ),
  ].join("_");
}


function getAutodearListingPricePlanPrice(
  plan,
  requestedStep
) {
  const startPrice =
    Math.round(
      Number(
        plan?.start_price ||
        plan?.startPrice ||
        0
      )
    );

  const targetPrice =
    Math.round(
      Number(
        plan?.target_price ||
        plan?.targetPrice ||
        0
      )
    );

  const totalSteps =
    Math.max(
      1,
      Math.round(
        Number(
          plan?.total_steps ||
          plan?.totalSteps ||
          plan?.duration_days ||
          plan?.durationDays ||
          1
        )
      )
    );

  const step =
    Math.min(
      totalSteps,
      Math.max(
        0,
        Math.round(
          Number(
            requestedStep ||
            0
          )
        )
      )
    );

  if (
    step <= 0
  ) {
    return startPrice;
  }

  if (
    step >= totalSteps
  ) {
    return targetPrice;
  }

  const totalDrop =
    startPrice -
    targetPrice;

  return Math.max(
    targetPrice,
    Math.round(
      startPrice -
      (
        totalDrop *
        step
      ) /
      totalSteps
    )
  );
}


async function cancelActiveAutodearListingPricePlan({
  listingId,
  ownerId,
  reason,
}) {
  if (
    !supabaseServiceRole ||
    !listingId
  ) {
    return null;
  }

  const nowIso =
    new Date()
      .toISOString();

  let query =
    supabaseServiceRole
      .from(
        "listing_price_reduction_plans"
      )
      .update({
        status:
          "cancelled",

        cancelled_at:
          nowIso,

        cancel_reason:
          String(
            reason ||
            "CANCELLED"
          ),

        updated_at:
          nowIso,
      })
      .eq(
        "listing_id",
        String(
          listingId
        )
      )
      .eq(
        "status",
        "active"
      );

  if (ownerId) {
    query =
      query.eq(
        "owner_id",
        String(
          ownerId
        )
      );
  }

  const {
    data,
    error,
  } =
    await query
      .select("*");

  if (error) {
    throw error;
  }

  return Array.isArray(
    data
  )
    ? data[0] || null
    : null;
}


async function executeAutodearListingPricePlan(
  plan
) {
  const planId =
    String(
      plan?.id || ""
    ).trim();

  const listingId =
    String(
      plan?.listing_id ||
      ""
    ).trim();

  const ownerId =
    String(
      plan?.owner_id ||
      ""
    ).trim();

  if (
    !planId ||
    !listingId ||
    !ownerId
  ) {
    return;
  }

  const completedSteps =
    Math.max(
      0,
      Math.round(
        Number(
          plan?.completed_steps ||
          0
        )
      )
    );

  const totalSteps =
    Math.max(
      1,
      Math.round(
        Number(
          plan?.total_steps ||
          plan?.duration_days ||
          1
        )
      )
    );

  const startedAtMs =
    new Date(
      plan?.started_at ||
      plan?.created_at ||
      Date.now()
    ).getTime();

  const durationDays =
    Math.max(
      1,
      Math.round(
        Number(
          plan?.duration_days ||
          totalSteps
        )
      )
    );

  /*
   * Новые gradual-планы:
   *
   * total_steps = duration_days + 1
   *
   * Первый шаг выполняется сразу,
   * остальные — каждые 24 часа.
   *
   * Старые планы сохраняют прежнюю
   * схему и не меняют поведение.
   */
  const immediateFirstStep =
    totalSteps ===
    durationDays + 1;

  const elapsedSteps =
    immediateFirstStep
      ? Math.max(
          1,
          Math.floor(
            (
              Date.now() -
              startedAtMs
            ) /
            AUTODEAR_LISTING_PRICE_PLAN_DAY_MS
          ) +
          1
        )
      : Math.max(
          1,
          Math.floor(
            (
              Date.now() -
              startedAtMs
            ) /
            AUTODEAR_LISTING_PRICE_PLAN_DAY_MS
          )
        );

  const nextStep =
    Math.min(
      totalSteps,
      Math.max(
        completedSteps +
        1,
        elapsedSteps
      )
    );

  const expectedCurrentPrice =
    getAutodearListingPricePlanPrice(
      plan,
      completedSteps
    );

  const scheduledNextPrice =
    getAutodearListingPricePlanPrice(
      plan,
      nextStep
    );

  const {
    data: listing,
    error: listingError,
  } =
    await supabaseServiceRole
      .from("listings")
      .select(
        [
          "id",
          "owner_id",
          "title",
          "price",
          "status",
          "extra_fields",
          "payload",
          "updated_at",
        ].join(",")
      )
      .eq(
        "id",
        listingId
      )
      .maybeSingle();

  if (listingError) {
    throw listingError;
  }

  if (!listing) {
    await cancelActiveAutodearListingPricePlan({
      listingId,
      ownerId,
      reason:
        "LISTING_NOT_FOUND",
    });

    return;
  }

  if (
    String(
      listing?.owner_id ||
      listing?.payload
        ?.ownerId ||
      ""
    ).trim() !==
    ownerId
  ) {
    await cancelActiveAutodearListingPricePlan({
      listingId,
      ownerId,
      reason:
        "OWNER_CHANGED",
    });

    return;
  }

  if (
    String(
      listing?.status ||
      ""
    ).toLowerCase() !==
    "active"
  ) {
    await cancelActiveAutodearListingPricePlan({
      listingId,
      ownerId,
      reason:
        "LISTING_NOT_ACTIVE",
    });

    return;
  }

  const currentPrice =
    Math.round(
      Number(
        listing?.price ||
        listing?.payload
          ?.price ||
        0
      )
    );

  /*
   * Если продавец самостоятельно изменил цену,
   * старый автоплан больше не имеет права её
   * перезаписывать.
   */
  if (
    currentPrice !==
    expectedCurrentPrice
  ) {
    await cancelActiveAutodearListingPricePlan({
      listingId,
      ownerId,
      reason:
        "PRICE_CHANGED_EXTERNALLY",
    });

    console.log(
      "[AUTODEAR][LISTING_PRICE_PLAN][CANCELLED_EXTERNAL_CHANGE]",
      {
        planId,
        listingId,
        expectedCurrentPrice,
        currentPrice,
      }
    );

    return;
  }

  const nowIso =
    new Date()
      .toISOString();

  /*
   * На очень маленьком общем снижении округление
   * может дать ту же цену на промежуточном шаге.
   * Тогда двигаем сам план, но бессмысленную запись
   * объявления не делаем.
   */
  if (
    scheduledNextPrice >=
    currentPrice
  ) {
    const completed =
      nextStep >=
      totalSteps;

    const nextRunAt =
      new Date(
        startedAtMs +
        (
          (
            immediateFirstStep
              ? Math.min(
                  durationDays,
                  nextStep
                )
              : Math.min(
                  totalSteps,
                  nextStep + 1
                )
          ) *
          AUTODEAR_LISTING_PRICE_PLAN_DAY_MS
        )
      ).toISOString();

    await supabaseServiceRole
      .from(
        "listing_price_reduction_plans"
      )
      .update({
        completed_steps:
          nextStep,

        status:
          completed
            ? "completed"
            : "active",

        last_run_at:
          nowIso,

        next_run_at:
          nextRunAt,

        completed_at:
          completed
            ? nowIso
            : null,

        updated_at:
          nowIso,

        last_error:
          null,
      })
      .eq(
        "id",
        planId
      )
      .eq(
        "status",
        "active"
      )
      .eq(
        "completed_steps",
        completedSteps
      );

    return;
  }

  const payload =
    listing?.payload &&
    typeof listing.payload ===
      "object"
      ? listing.payload
      : {};

  const rowExtraFields =
    listing?.extra_fields &&
    typeof listing
      .extra_fields ===
      "object"
      ? listing.extra_fields
      : {};

  const payloadExtraFields =
    payload?.extraFields &&
    typeof payload
      .extraFields ===
      "object"
      ? payload.extraFields
      : {};

  /*
   * Отдельная колонка extra_fields считается
   * более свежим источником истины.
   */
  const currentExtraFields = {
    ...payloadExtraFields,
    ...rowExtraFields,
  };

  const currentTracking =
    currentExtraFields
      ?.priceTracking &&
    typeof currentExtraFields
      .priceTracking ===
      "object"
      ? currentExtraFields
          .priceTracking
      : {};

  const priceChangeAmount =
    scheduledNextPrice -
    currentPrice;

  const priceDropAmount =
    currentPrice -
    scheduledNextPrice;

  const priceChangePercent =
    Math.max(
      1,
      Math.round(
        (
          priceDropAmount /
          currentPrice
        ) *
        100
      )
    );

  const sameTrackedPlan =
    String(
      currentTracking
        ?.gradualPlan
        ?.id ||
      ""
    ) ===
    planId;

  const trackedHumanStartPrice =
    Math.round(
      Number(
        sameTrackedPlan
          ? currentTracking
              ?.gradualPlan
              ?.startPrice ||
            currentTracking
              ?.reductionBasePrice ||
            0
          : 0
      )
    );

  const reductionBasePrice =
    trackedHumanStartPrice > 0
      ? trackedHumanStartPrice
      : Math.round(
          Number(
            plan?.start_price ||
            currentPrice
          )
        );

  const cumulativeDropPercent =
    Math.max(
      1,
      Math.round(
        (
          (
            reductionBasePrice -
            scheduledNextPrice
          ) /
          reductionBasePrice
        ) *
          100
      )
    );

  const badgeVisibleUntil =
    new Date(
      Date.now() +
      7 *
      24 *
      60 *
      60 *
      1000
    ).toISOString();

  const operationKey =
    [
      "gradual-price",
      planId,
      `step-${nextStep}`,
    ].join(":");

  const historyEntry = {
    from:
      currentPrice,

    to:
      scheduledNextPrice,

    amount:
      priceChangeAmount,

    percent:
      priceChangePercent,

    direction:
      "down",

    changedAt:
      nowIso,

    operationKey,

    gradualPlanId:
      planId,

    gradualStep:
      nextStep,

    gradualTotalSteps:
      totalSteps,
  };

  const currentHistory =
    Array.isArray(
      currentTracking
        ?.history
    )
      ? currentTracking
          .history
      : [];

  const planCompleted =
    nextStep >=
      totalSteps ||
    scheduledNextPrice <=
      Number(
        plan?.target_price ||
        0
      );

  const nextRunAt =
    new Date(
      startedAtMs +
      (
        (
          immediateFirstStep
            ? Math.min(
                durationDays,
                nextStep
              )
            : Math.min(
                totalSteps,
                nextStep + 1
              )
        ) *
        AUTODEAR_LISTING_PRICE_PLAN_DAY_MS
      )
    ).toISOString();

  const nextTracking = {
    ...currentTracking,

    previousPrice:
      currentPrice,

    currentPrice:
      scheduledNextPrice,

    priceChangeAmount,

    priceChangePercent,

    reductionBasePrice,

    cumulativeDropPercent,

    direction:
      "down",

    changedAt:
      nowIso,

    badgeVisibleUntil,

    lastOperationKey:
      operationKey,

    gradualPlan: {
      id:
        planId,

      active:
        !planCompleted,

      startPrice:
        reductionBasePrice,

      targetPrice:
        Number(
          plan?.target_price ||
          0
        ),

      durationDays:
        Number(
          plan?.duration_days ||
          totalSteps
        ),

      completedSteps:
        nextStep,

      totalSteps,

      startedAt:
        plan?.started_at ||
        null,

      nextRunAt:
        planCompleted
          ? null
          : nextRunAt,
    },

    history: [
      historyEntry,
      ...currentHistory,
    ].slice(
      0,
      20
    ),
  };

  const nextExtraFields = {
    ...currentExtraFields,

    priceTracking:
      nextTracking,
  };

  const nextPayload = {
    ...payload,

    price:
      String(
        scheduledNextPrice
      ),

    extraFields:
      nextExtraFields,
  };

  /*
   * Оптимистический UPDATE защищает от двух
   * серверов, которые одновременно увидели один
   * и тот же due-план.
   */
  const {
    data: updatedListing,
    error: updateError,
  } =
    await supabaseServiceRole
      .from("listings")
      .update({
        price:
          scheduledNextPrice,

        extra_fields:
          nextExtraFields,

        payload:
          nextPayload,

        updated_at:
          nowIso,
      })
      .eq(
        "id",
        listingId
      )
      .eq(
        "owner_id",
        ownerId
      )
      .eq(
        "price",
        currentPrice
      )
      .select(
        "id,owner_id,title,price,status,extra_fields,payload,updated_at"
      )
      .maybeSingle();

  if (updateError) {
    throw updateError;
  }

  if (!updatedListing) {
    /*
     * Кто-то успел изменить цену раньше нас.
     * Следующий sweep увидит рассинхрон и отменит
     * старый план.
     */
    return;
  }

  const {
    data: updatedPlan,
    error: planUpdateError,
  } =
    await supabaseServiceRole
      .from(
        "listing_price_reduction_plans"
      )
      .update({
        completed_steps:
          nextStep,

        status:
          planCompleted
            ? "completed"
            : "active",

        last_run_at:
          nowIso,

        next_run_at:
          nextRunAt,

        completed_at:
          planCompleted
            ? nowIso
            : null,

        updated_at:
          nowIso,

        last_error:
          null,
      })
      .eq(
        "id",
        planId
      )
      .eq(
        "status",
        "active"
      )
      .eq(
        "completed_steps",
        completedSteps
      )
      .select("*")
      .maybeSingle();

  if (planUpdateError) {
    throw planUpdateError;
  }

  console.log(
    "[AUTODEAR][LISTING_PRICE_PLAN][STEP_SAVED]",
    {
      planId,
      listingId,
      nextStep,
      totalSteps,
      currentPrice,
      scheduledNextPrice,
      planCompleted,
    }
  );

  /*
   * Не спамим избранное каждый день.
   *
   * Push/внутреннее уведомление:
   * - на первом фактическом снижении;
   * - когда достигнута конечная цена.
   */
  const shouldNotify =
    nextStep === 1 ||
    planCompleted;

  if (
    shouldNotify &&
    updatedPlan
  ) {
    void notifyAutodearListingPriceReduced({
      listingId,

      ownerId,

      title:
        updatedListing?.title ||
        listing?.title ||
        "Объявление AUTODEAR",

      previousPrice:
        currentPrice,

      nextPrice:
        scheduledNextPrice,

      priceDropAmount,

      priceChangePercent,

      operationKey,
    }).catch(
      (notificationError) => {
        console.error(
          "[AUTODEAR][LISTING_PRICE_PLAN][NOTIFY_ERROR]",
          {
            planId,
            listingId,
            message:
              notificationError
                ?.message ||
              String(
                notificationError
              ),
          }
        );
      }
    );
  }
}


async function runAutodearListingPricePlanSweep() {
  if (
    autodearListingPricePlanSchedulerRunning
  ) {
    return;
  }

  if (!supabaseServiceRole) {
    return;
  }

  autodearListingPricePlanSchedulerRunning =
    true;

  try {
    const nowIso =
      new Date()
        .toISOString();

    const {
      data: plans,
      error,
    } =
      await supabaseServiceRole
        .from(
          "listing_price_reduction_plans"
        )
        .select("*")
        .eq(
          "status",
          "active"
        )
        .lte(
          "next_run_at",
          nowIso
        )
        .order(
          "next_run_at",
          {
            ascending:
              true,
          }
        )
        .limit(100);

    if (error) {
      throw error;
    }

    for (
      const plan of
      Array.isArray(plans)
        ? plans
        : []
    ) {
      try {
        await executeAutodearListingPricePlan(
          plan
        );
      } catch (planError) {
        console.error(
          "[AUTODEAR][LISTING_PRICE_PLAN][STEP_ERROR]",
          {
            planId:
              plan?.id,
            listingId:
              plan?.listing_id,
            message:
              planError?.message ||
              String(
                planError
              ),
          }
        );

        try {
          await supabaseServiceRole
            .from(
              "listing_price_reduction_plans"
            )
            .update({
              last_error:
                planError?.message ||
                String(
                  planError
                ),

              updated_at:
                new Date()
                  .toISOString(),
            })
            .eq(
              "id",
              String(
                plan?.id ||
                ""
              )
            )
            .eq(
              "status",
              "active"
            );
        } catch {
          // Основная ошибка уже записана в лог.
        }
      }
    }
  } catch (error) {
    console.error(
      "[AUTODEAR][LISTING_PRICE_PLAN][SWEEP_ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );
  } finally {
    autodearListingPricePlanSchedulerRunning =
      false;
  }
}


function startAutodearListingPricePlanScheduler() {
  const run = () => {
    runAutodearListingPricePlanSweep()
      .catch(
        (error) => {
          console.error(
            "[AUTODEAR][LISTING_PRICE_PLAN][UNHANDLED]",
            error
          );
        }
      );
  };

  setTimeout(
    run,
    7000
  );

  const timer =
    setInterval(
      run,
      AUTODEAR_LISTING_PRICE_PLAN_INTERVAL_MS
    );

  if (
    typeof timer.unref ===
    "function"
  ) {
    timer.unref();
  }

  console.log(
    "[AUTODEAR][LISTING_PRICE_PLAN][SCHEDULER_STARTED]"
  );
}


/*
 * Получить активный план владельца.
 */
app.get(
  "/api/listings/:listingId/price-reduction-plan",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(
        req
      );

    const authUserId =
      String(
        authResult?.user?.id ||
        ""
      ).trim();

    if (!authUserId) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
    }

    if (!supabaseServiceRole) {
      return res
        .status(503)
        .json({
          ok: false,
          error:
            "PRICE_PLAN_SERVICE_NOT_CONFIGURED",
        });
    }

    const listingId =
      String(
        req.params
          ?.listingId ||
        ""
      ).trim();

    try {
      const {
        data: plan,
        error,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .select("*")
          .eq(
            "listing_id",
            listingId
          )
          .eq(
            "owner_id",
            authUserId
          )
          .eq(
            "status",
            "active"
          )
          .maybeSingle();

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        plan:
          plan || null,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][LISTING_PRICE_PLAN][GET_ERROR]",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "PRICE_PLAN_GET_FAILED",
        });
    }
  }
);


/*
 * Запустить постепенное снижение.
 */
app.post(
  "/api/listings/:listingId/price-reduction-plan",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(
        req
      );

    const authUserId =
      String(
        authResult?.user?.id ||
        ""
      ).trim();

    if (!authUserId) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
    }

    if (!supabaseServiceRole) {
      return res
        .status(503)
        .json({
          ok: false,
          error:
            "PRICE_PLAN_SERVICE_NOT_CONFIGURED",
        });
    }

    const listingId =
      String(
        req.params
          ?.listingId ||
        ""
      ).trim();

    const targetPrice =
      Math.round(
        Number(
          req.body
            ?.targetPrice
        )
      );

    const durationDays =
      Math.round(
        Number(
          req.body
            ?.durationDays
        )
      );

    const operationKey =
      String(
        req.body
          ?.operationKey ||
        ""
      ).trim();

    if (
      !listingId ||
      !Number.isFinite(
        targetPrice
      ) ||
      targetPrice <= 0 ||
      !AUTODEAR_LISTING_PRICE_PLAN_DURATIONS
        .has(
          durationDays
        ) ||
      !operationKey ||
      operationKey.length >
        220
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "INVALID_PRICE_PLAN",
        });
    }

    try {
      /*
       * Идемпотентный повтор той же кнопки.
       */
      const {
        data: duplicatePlan,
        error: duplicateError,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .select("*")
          .eq(
            "owner_id",
            authUserId
          )
          .eq(
            "operation_key",
            operationKey
          )
          .maybeSingle();

      if (duplicateError) {
        throw duplicateError;
      }

      if (duplicatePlan) {
        return res.json({
          ok: true,
          duplicate:
            true,
          plan:
            duplicatePlan,
        });
      }

      const {
        data: listing,
        error: listingError,
      } =
        await supabaseServiceRole
          .from("listings")
          .select(
            "id,owner_id,title,price,status,payload,extra_fields"
          )
          .eq(
            "id",
            listingId
          )
          .maybeSingle();

      if (listingError) {
        throw listingError;
      }

      if (!listing) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "LISTING_NOT_FOUND",
          });
      }

      const listingOwnerId =
        String(
          listing
            ?.owner_id ||
          listing?.payload
            ?.ownerId ||
          ""
        ).trim();

      if (
        listingOwnerId !==
        authUserId
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "LISTING_OWNER_FORBIDDEN",
          });
      }

      if (
        String(
          listing?.status ||
          ""
        ).toLowerCase() !==
        "active"
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "LISTING_NOT_ACTIVE",
          });
      }

      const startPrice =
        Math.round(
          Number(
            listing?.price ||
            listing?.payload
              ?.price ||
            0
          )
        );

      if (
        !Number.isFinite(
          startPrice
        ) ||
        startPrice <= 0
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "LISTING_CURRENT_PRICE_INVALID",
          });
      }

      if (
        targetPrice >=
        startPrice
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "TARGET_PRICE_MUST_BE_LOWER",
            currentPrice:
              startPrice,
          });
      }

      const {
        data: activePlan,
        error: activeError,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .select("*")
          .eq(
            "listing_id",
            listingId
          )
          .eq(
            "status",
            "active"
          )
          .maybeSingle();

      if (activeError) {
        throw activeError;
      }

      if (activePlan) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "PRICE_PLAN_ALREADY_ACTIVE",
            plan:
              activePlan,
          });
      }

      const startedAt =
        new Date();

      const nextRunAt =
        new Date(
          startedAt.getTime() +
          AUTODEAR_LISTING_PRICE_PLAN_DAY_MS
        );

      const plan = {
        id:
          createAutodearListingPricePlanId(),

        listing_id:
          listingId,

        owner_id:
          authUserId,

        start_price:
          startPrice,

        target_price:
          targetPrice,

        duration_days:
          durationDays,

        total_steps:
          durationDays + 1,

        completed_steps:
          0,

        status:
          "active",

        operation_key:
          operationKey,

        started_at:
          startedAt
            .toISOString(),

        next_run_at:
          nextRunAt
            .toISOString(),

        created_at:
          startedAt
            .toISOString(),

        updated_at:
          startedAt
            .toISOString(),
      };

      const {
        data: insertedPlan,
        error: insertError,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .insert(plan)
          .select("*")
          .single();

      if (insertError) {
        throw insertError;
      }

      /*
       * Первый фактический шаг выполняется
       * непосредственно при создании плана.
       *
       * next_run_at уже установлен на +24 часа,
       * поэтому scheduler не конкурирует
       * с этим немедленным шагом.
       */
      await executeAutodearListingPricePlan(
        insertedPlan
      );

      const {
        data: refreshedPlan,
        error: refreshedPlanError,
      } =
        await supabaseServiceRole
          .from(
            "listing_price_reduction_plans"
          )
          .select("*")
          .eq(
            "id",
            insertedPlan.id
          )
          .maybeSingle();

      if (refreshedPlanError) {
        throw refreshedPlanError;
      }

      const responsePlan =
        refreshedPlan ||
        insertedPlan;

      console.log(
        "[AUTODEAR][LISTING_PRICE_PLAN][CREATED]",
        {
          planId:
            responsePlan?.id,

          completedSteps:
            Number(
              responsePlan
                ?.completed_steps ||
              0
            ),
          listingId,
          ownerId:
            authUserId,
          startPrice,
          targetPrice,
          durationDays,
          nextRunAt:
            nextRunAt
              .toISOString(),
        }
      );

      return res.json({
        ok: true,

        duplicate:
          false,

        plan:
          responsePlan,

        firstStepApplied:
          Number(
            responsePlan
              ?.completed_steps ||
            0
          ) >= 1,

        estimatedDailyDrop:
          Math.round(
            (
              startPrice -
              targetPrice
            ) /
            (
              durationDays + 1
            )
          ),
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][LISTING_PRICE_PLAN][CREATE_ERROR]",
        {
          listingId,
          message:
            error?.message ||
            String(error),
        }
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "PRICE_PLAN_CREATE_FAILED",
        });
    }
  }
);


/*
 * Отменить постепенное снижение.
 */
app.post(
  "/api/listings/:listingId/price-reduction-plan/cancel",
  async (req, res) => {
    const authResult =
      await resolveAuthenticatedUser(
        req
      );

    const authUserId =
      String(
        authResult?.user?.id ||
        ""
      ).trim();

    if (!authUserId) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
    }

    try {
      const cancelled =
        await cancelActiveAutodearListingPricePlan({
          listingId:
            String(
              req.params
                ?.listingId ||
              ""
            ),

          ownerId:
            authUserId,

          reason:
            "USER_CANCELLED",
        });

      return res.json({
        ok: true,
        cancelled:
          Boolean(
            cancelled
          ),
        plan:
          cancelled,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][LISTING_PRICE_PLAN][CANCEL_ERROR]",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "PRICE_PLAN_CANCEL_FAILED",
        });
    }
  }
);


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
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUserId =
    String(
      authResult?.user?.id || ""
    ).trim();

  if (!authUserId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

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

    /*
     * Финансовые данные доступны только
     * владельцу текущей авторизованной сессии.
     */
    if (ownerId !== authUserId) {
      console.warn(
        "[AUTODEAR][WALLET][GET_OWNER_MISMATCH]",
        {
          authUserId,
          ownerId,
          walletType,
        }
      );

      return res.status(403).json({
        ok: false,
        error:
          "WALLET_OWNER_FORBIDDEN",
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

app.post("/api/wallet/:walletType/:ownerId/charge", async (req, res) => {
  const authResult =
    await resolveAuthenticatedUser(req);

  const authUserId =
    String(
      authResult?.user?.id || ""
    ).trim();

  if (!authUserId) {
    return res.status(401).json({
      ok: false,
      error:
        authResult?.error ||
        "AUTH_REQUIRED",
    });
  }

  if (!supabaseServiceRole) {
    console.error(
      "[AUTODEAR][WALLET][CHARGE_SERVICE_ROLE_MISSING]"
    );

    return res.status(503).json({
      ok: false,
      error:
        "WALLET_SERVICE_NOT_CONFIGURED",
    });
  }

  const ownerId =
    String(
      req.params?.ownerId || ""
    ).trim();

  const walletType =
    String(
      req.params?.walletType || ""
    )
      .trim()
      .toLowerCase();

  const amount =
    Number(
      req.body?.amount
    );

  const title =
    String(
      req.body?.title || ""
    ).trim();

  const transactionType =
    String(
      req.body?.transactionType || ""
    ).trim();

  const operationKey =
    String(
      req.body?.operationKey || ""
    ).trim();

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

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_AMOUNT",
    });
  }

  if (!title) {
    return res.status(400).json({
      ok: false,
      error: "TITLE_REQUIRED",
    });
  }

  const allowedTransactionTypes =
    new Set([
      "listing_payment",
      "promotion_payment",
      "business_payment",
      "subscription_payment",
      "commission_payment",
    ]);

  if (
    !allowedTransactionTypes.has(
      transactionType
    )
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "INVALID_TRANSACTION_TYPE",
    });
  }

  if (!operationKey) {
    return res.status(400).json({
      ok: false,
      error:
        "OPERATION_KEY_REQUIRED",
    });
  }

  /*
   * Never trust ownerId supplied by the client.
   *
   * The central wallet currently belongs to the
   * authenticated Supabase auth UUID. This prevents
   * a client from charging another user's wallet.
   */
  if (ownerId !== authUserId) {
    console.warn(
      "[AUTODEAR][WALLET][CHARGE_OWNER_MISMATCH]",
      {
        authUserId,
        ownerId,
        walletType,
      }
    );

    return res.status(403).json({
      ok: false,
      error:
        "WALLET_OWNER_FORBIDDEN",
    });
  }

  try {
    const {
      data: chargeResult,
      error: chargeError,
    } =
      await supabaseServiceRole.rpc(
        "autodear_charge_wallet",
        {
          p_owner_id:
            ownerId,
          p_wallet_type:
            walletType,
          p_amount:
            amount,
          p_title:
            title,
          p_transaction_type:
            transactionType,
          p_operation_key:
            operationKey,
        }
      );

    if (chargeError) {
      console.error(
        "[AUTODEAR][WALLET][CHARGE_RPC_ERROR]",
        {
          ownerId,
          walletType,
          transactionType,
          operationKey,
          code:
            chargeError.code || null,
          message:
            chargeError.message || null,
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "WALLET_CHARGE_FAILED",
      });
    }

    if (
      chargeResult?.ok === false &&
      chargeResult?.error ===
        "INSUFFICIENT_FUNDS"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "INSUFFICIENT_FUNDS",
        balance:
          Number(
            chargeResult?.balance || 0
          ),
      });
    }

    if (
      chargeResult?.ok !== true
    ) {
      return res.status(500).json({
        ok: false,
        error:
          chargeResult?.error ||
          "WALLET_CHARGE_INVALID_RESULT",
      });
    }

    console.log(
      "[AUTODEAR][WALLET][CHARGE_OK]",
      {
        ownerId,
        walletType,
        transactionType,
        operationKey,
        duplicate:
          chargeResult?.duplicate === true,
        balance:
          Number(
            chargeResult?.balance || 0
          ),
      }
    );

    return res.json({
      ok: true,
      duplicate:
        chargeResult?.duplicate === true,
      balance:
        Number(
          chargeResult?.balance || 0
        ),
      transactionId:
        chargeResult?.transactionId ||
        null,
    });
  } catch (error) {
    console.error(
      "[AUTODEAR][WALLET][CHARGE_FATAL]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "WALLET_CHARGE_FATAL",
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

    const staffRole =
      getAdsStaffRole(user);

    const advertiserActivated =
      Boolean(staffRole) ||
      await getAdsAdvertiserActivation(
        ownerId
      );

    const result = {
      advertiserActivated,

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




// ============================================================
// AUTODEAR — BUSINESS LISTING BILLING / DIRECTOR SETTINGS
//
// IMPORTANT:
// - separate from Business PRO / MAX;
// - billing is attached to stations.id;
// - client never writes billing tables directly;
// - no charge / renewal / broadcast runs here;
// - LIVE mode is deliberately blocked until the complete
//   server billing engine is ready.
// ============================================================


async function requireBusinessListingBillingDirectorUser(
  req
) {
  const staff =
    await requireAdsStaffUser(
      req
    );

  /*
   * Финансовые настройки размещения:
   * директор + разработчик.
   *
   * Admin занимается модерацией, но не должен
   * менять коммерческую модель приложения.
   */
  if (
    ![
      "director",
      "developer",
    ].includes(
      String(
        staff?.role || ""
      )
    )
  ) {
    const error =
      new Error(
        "BUSINESS_LISTING_BILLING_DIRECTOR_REQUIRED"
      );

    error.statusCode =
      403;

    throw error;
  }

  return staff;
}


function businessListingBillingSchemaMissing(
  error
) {
  const code =
    String(
      error?.code || ""
    ).trim();

  const message =
    String(
      error?.message || ""
    )
      .trim()
      .toLowerCase();

  return (
    code ===
      "42P01" ||
    code ===
      "PGRST205" ||
    (
      message.includes(
        "business_listing_billing_"
      ) &&
      (
        message.includes(
          "does not exist"
        ) ||
        message.includes(
          "could not find the table"
        )
      )
    )
  );
}


function normalizeBusinessListingBillingInteger(
  value,
  {
    min = 0,
    max =
      Number.MAX_SAFE_INTEGER,
  } = {}
) {
  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    )
  ) {
    return null;
  }

  const integer =
    Math.round(
      number
    );

  if (
    integer < min ||
    integer > max
  ) {
    return null;
  }

  return integer;
}


function normalizeBusinessListingBillingPercent(
  value
) {
  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    ) ||
    number < 0 ||
    number > 100
  ) {
    return null;
  }

  return Math.round(
    number * 100
  ) / 100;
}


function normalizeBusinessListingBillingReminderDays(
  value
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    return null;
  }

  const days =
    [
      ...new Set(
        value
          .map(
            (item) =>
              normalizeBusinessListingBillingInteger(
                item,
                {
                  min: 0,
                  max: 365,
                }
              )
          )
          .filter(
            (item) =>
              item !== null
          )
      ),
    ]
      .sort(
        (a, b) =>
          b - a
      );

  if (
    !days.length ||
    days.length > 20
  ) {
    return null;
  }

  return days;
}


function normalizeBusinessListingBillingText(
  value,
  maxLength = 4000
) {
  const raw =
    String(
      value ?? ""
    ).trim();

  if (
    !raw ||
    raw.length >
      maxLength
  ) {
    return null;
  }

  return raw;
}


function mapBusinessListingBillingSettings(
  row
) {
  if (!row) {
    return null;
  }

  return {
    id:
      row.id,

    billingMode:
      row.billing_mode,

    billingStartsAt:
      row.billing_starts_at ||
      null,

    monthlyPriceKopecks:
      Number(
        row.monthly_price_kopecks ||
        0
      ),

    claimFreeDays:
      Number(
        row.claim_free_days ||
        0
      ),

    graceDays:
      Number(
        row.grace_days ||
        0
      ),

    reminderDays:
      Array.isArray(
        row.reminder_days
      )
        ? row.reminder_days
            .map(Number)
            .filter(
              Number.isFinite
            )
        : [],

    templates: {
      transition: {
        title:
          row.transition_notice_title ||
          "",

        body:
          row.transition_notice_body ||
          "",
      },

      renewalReminder: {
        title:
          row.renewal_reminder_title ||
          "",

        body:
          row.renewal_reminder_body ||
          "",
      },

      lowBalance: {
        title:
          row.low_balance_title ||
          "",

        body:
          row.low_balance_body ||
          "",
      },

      renewalSuccess: {
        title:
          row.renewal_success_title ||
          "",

        body:
          row.renewal_success_body ||
          "",
      },

      renewalFailed: {
        title:
          row.renewal_failed_title ||
          "",

        body:
          row.renewal_failed_body ||
          "",
      },

      suspended: {
        title:
          row.suspended_title ||
          "",

        body:
          row.suspended_body ||
          "",
      },
    },

    updatedAt:
      row.updated_at ||
      null,

    updatedByUserId:
      row.updated_by_user_id ||
      null,
  };
}


function mapBusinessListingBillingPlan(
  row
) {
  return {
    id:
      row.id,

    months:
      Number(
        row.months ||
        0
      ),

    discountPercent:
      Number(
        row.discount_percent ||
        0
      ),

    isEnabled:
      row.is_enabled !==
      false,

    sortOrder:
      Number(
        row.sort_order ||
        0
      ),

    createdAt:
      row.created_at ||
      null,

    updatedAt:
      row.updated_at ||
      null,
  };
}


/*
 * Director billing settings.
 *
 * Read only.
 * Does not start billing.
 */
app.get(
  "/api/director/business-listing-billing/settings",
  async (req, res) => {
    const billingPerfStartedAt =
      Date.now();

    try {
      console.log(
        "[AUTODEAR][BILLING_PERF][REQUEST_START]",
        {
          at:
            billingPerfStartedAt,
        }
      );

      if (
        !supabaseServiceRole
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_NOT_CONFIGURED",
        });
      }

      const authStartedAt =
        Date.now();

      await requireBusinessListingBillingDirectorUser(
        req
      );

      console.log(
        "[AUTODEAR][BILLING_PERF][AUTH_DONE]",
        {
          ms:
            Date.now() -
            authStartedAt,

          totalMs:
            Date.now() -
            billingPerfStartedAt,
        }
      );

      const queriesStartedAt =
        Date.now();

      const [
        settingsResult,
        plansResult,
      ] =
        await Promise.all([
          supabaseServiceRole
            .from(
              "business_listing_billing_settings"
            )
            .select("*")
            .eq(
              "id",
              "global"
            )
            .maybeSingle(),

          supabaseServiceRole
            .from(
              "business_listing_billing_plans"
            )
            .select("*")
            .order(
              "sort_order",
              {
                ascending:
                  true,
              }
            ),
        ]);

      console.log(
        "[AUTODEAR][BILLING_PERF][QUERIES_DONE]",
        {
          ms:
            Date.now() -
            queriesStartedAt,

          totalMs:
            Date.now() -
            billingPerfStartedAt,

          settingsError:
            settingsResult.error
              ?.code ||
            null,

          plansError:
            plansResult.error
              ?.code ||
            null,
        }
      );

      if (
        settingsResult.error ||
        plansResult.error
      ) {
        const error =
          settingsResult.error ||
          plansResult.error;

        if (
          businessListingBillingSchemaMissing(
            error
          )
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_SCHEMA_NOT_READY",
            message:
              "Схема платного размещения ещё не применена.",
          });
        }

        console.error(
          "[AUTODEAR][BUSINESS_LISTING_BILLING][SETTINGS_GET_ERROR]",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_SETTINGS_GET_FAILED",
        });
      }

      if (
        !settingsResult.data
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_SETTINGS_MISSING",
        });
      }

      console.log(
        "[AUTODEAR][BILLING_PERF][RESPONSE_READY]",
        {
          totalMs:
            Date.now() -
            billingPerfStartedAt,
        }
      );

      return res.json({
        ok: true,

        settings:
          mapBusinessListingBillingSettings(
            settingsResult.data
          ),

        plans:
          (
            plansResult.data ||
            []
          ).map(
            mapBusinessListingBillingPlan
          ),

        /*
         * Пока это false, backend не имеет
         * права запускать реальные списания.
         */
        liveBillingReady:
          false,
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_LISTING_BILLING][SETTINGS_GET_FATAL]",
        {
          status,
          message:
            error?.message ||
            String(
              error
            ),
        }
      );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_SETTINGS_GET_FATAL",
        });
    }
  }
);


/*
 * Update commercial settings and message templates.
 *
 * IMPORTANT:
 * billing_mode is NOT accepted here.
 */
app.patch(
  "/api/director/business-listing-billing/settings",
  async (req, res) => {
    try {
      if (
        !supabaseServiceRole
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_NOT_CONFIGURED",
        });
      }

      const {
        user,
      } =
        await requireBusinessListingBillingDirectorUser(
          req
        );

      const body =
        req.body &&
        typeof req.body ===
          "object" &&
        !Array.isArray(
          req.body
        )
          ? req.body
          : {};

      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "billingMode"
          ) ||
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "billing_mode"
          )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_MODE_REQUIRES_EXPLICIT_ACTION",
          message:
            "Режим тарификации меняется отдельным подтверждаемым действием.",
        });
      }

      const update = {
        updated_at:
          new Date()
            .toISOString(),

        updated_by_user_id:
          user.id,
      };


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "monthlyPriceKopecks"
          )
      ) {
        const value =
          normalizeBusinessListingBillingInteger(
            body.monthlyPriceKopecks,
            {
              min: 0,
              max:
                1000000000,
            }
          );

        if (
          value ===
          null
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_PRICE_INVALID",
          });
        }

        update.monthly_price_kopecks =
          value;
      }


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "claimFreeDays"
          )
      ) {
        const value =
          normalizeBusinessListingBillingInteger(
            body.claimFreeDays,
            {
              min: 0,
              max: 3650,
            }
          );

        if (
          value ===
          null
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_FREE_DAYS_INVALID",
          });
        }

        update.claim_free_days =
          value;
      }


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "graceDays"
          )
      ) {
        const value =
          normalizeBusinessListingBillingInteger(
            body.graceDays,
            {
              min: 0,
              max: 365,
            }
          );

        if (
          value ===
          null
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_GRACE_DAYS_INVALID",
          });
        }

        update.grace_days =
          value;
      }


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "reminderDays"
          )
      ) {
        const value =
          normalizeBusinessListingBillingReminderDays(
            body.reminderDays
          );

        if (!value) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_REMINDER_DAYS_INVALID",
          });
        }

        update.reminder_days =
          value;
      }


      const templateMap = [
        [
          "transitionTitle",
          "transition_notice_title",
          160,
        ],
        [
          "transitionBody",
          "transition_notice_body",
          4000,
        ],
        [
          "renewalReminderTitle",
          "renewal_reminder_title",
          160,
        ],
        [
          "renewalReminderBody",
          "renewal_reminder_body",
          4000,
        ],
        [
          "lowBalanceTitle",
          "low_balance_title",
          160,
        ],
        [
          "lowBalanceBody",
          "low_balance_body",
          4000,
        ],
        [
          "renewalSuccessTitle",
          "renewal_success_title",
          160,
        ],
        [
          "renewalSuccessBody",
          "renewal_success_body",
          4000,
        ],
        [
          "renewalFailedTitle",
          "renewal_failed_title",
          160,
        ],
        [
          "renewalFailedBody",
          "renewal_failed_body",
          4000,
        ],
        [
          "suspendedTitle",
          "suspended_title",
          160,
        ],
        [
          "suspendedBody",
          "suspended_body",
          4000,
        ],
      ];

      for (
        const [
          inputKey,
          dbKey,
          maxLength,
        ] of templateMap
      ) {
        if (
          !Object.prototype
            .hasOwnProperty
            .call(
              body,
              inputKey
            )
        ) {
          continue;
        }

        const value =
          normalizeBusinessListingBillingText(
            body[
              inputKey
            ],
            maxLength
          );

        if (!value) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_TEMPLATE_INVALID",
            field:
              inputKey,
          });
        }

        update[
          dbKey
        ] =
          value;
      }


      if (
        Object.keys(
          update
        ).length ===
        2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_NO_CHANGES",
        });
      }


      const {
        data,
        error,
      } =
        await supabaseServiceRole
          .from(
            "business_listing_billing_settings"
          )
          .update(
            update
          )
          .eq(
            "id",
            "global"
          )
          .select("*")
          .single();

      if (error) {
        if (
          businessListingBillingSchemaMissing(
            error
          )
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_SCHEMA_NOT_READY",
          });
        }

        console.error(
          "[AUTODEAR][BUSINESS_LISTING_BILLING][SETTINGS_UPDATE_ERROR]",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_SETTINGS_UPDATE_FAILED",
        });
      }

      console.log(
        "[AUTODEAR][BUSINESS_LISTING_BILLING][SETTINGS_UPDATE_OK]",
        {
          userId:
            user.id,

          monthlyPriceKopecks:
            data.monthly_price_kopecks,

          claimFreeDays:
            data.claim_free_days,

          graceDays:
            data.grace_days,
        }
      );

      return res.json({
        ok: true,

        settings:
          mapBusinessListingBillingSettings(
            data
          ),
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_LISTING_BILLING][SETTINGS_UPDATE_FATAL]",
        {
          status,
          message:
            error?.message ||
            String(
              error
            ),
        }
      );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_SETTINGS_UPDATE_FATAL",
        });
    }
  }
);


/*
 * Change one billing period.
 *
 * months cannot be changed after creation.
 */
app.patch(
  "/api/director/business-listing-billing/plans/:planId",
  async (req, res) => {
    try {
      if (
        !supabaseServiceRole
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_NOT_CONFIGURED",
        });
      }

      await requireBusinessListingBillingDirectorUser(
        req
      );

      const planId =
        String(
          req.params
            ?.planId ||
          ""
        ).trim();

      if (!planId) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_PLAN_ID_REQUIRED",
        });
      }

      const body =
        req.body &&
        typeof req.body ===
          "object" &&
        !Array.isArray(
          req.body
        )
          ? req.body
          : {};

      const update = {
        updated_at:
          new Date()
            .toISOString(),
      };


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "discountPercent"
          )
      ) {
        const value =
          normalizeBusinessListingBillingPercent(
            body.discountPercent
          );

        if (
          value ===
          null
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_DISCOUNT_INVALID",
          });
        }

        update.discount_percent =
          value;
      }


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            body,
            "isEnabled"
          )
      ) {
        if (
          typeof body.isEnabled !==
          "boolean"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_PLAN_ENABLED_INVALID",
          });
        }

        update.is_enabled =
          body.isEnabled;
      }


      if (
        Object.keys(
          update
        ).length ===
        1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_NO_CHANGES",
        });
      }


      const {
        data,
        error,
      } =
        await supabaseServiceRole
          .from(
            "business_listing_billing_plans"
          )
          .update(
            update
          )
          .eq(
            "id",
            planId
          )
          .select("*")
          .maybeSingle();

      if (error) {
        if (
          businessListingBillingSchemaMissing(
            error
          )
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_SCHEMA_NOT_READY",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_PLAN_UPDATE_FAILED",
        });
      }

      if (!data) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_PLAN_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,

        plan:
          mapBusinessListingBillingPlan(
            data
          ),
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_PLAN_UPDATE_FATAL",
        });
    }
  }
);


/*
 * Schedule a future transition.
 *
 * This does NOT send notifications and does NOT charge money.
 */
app.post(
  "/api/director/business-listing-billing/schedule",
  async (req, res) => {
    try {
      if (
        !supabaseServiceRole
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_NOT_CONFIGURED",
        });
      }

      const {
        user,
      } =
        await requireBusinessListingBillingDirectorUser(
          req
        );

      const body =
        req.body &&
        typeof req.body ===
          "object" &&
        !Array.isArray(
          req.body
        )
          ? req.body
          : {};

      if (
        String(
          body.confirmation ||
          ""
        ).trim() !==
        "ЗАПЛАНИРОВАТЬ"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_SCHEDULE_CONFIRMATION_REQUIRED",
        });
      }

      const startsAt =
        new Date(
          String(
            body.billingStartsAt ||
            ""
          )
        );

      if (
        Number.isNaN(
          startsAt.getTime()
        ) ||
        startsAt.getTime() <=
          Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_START_DATE_INVALID",
          message:
            "Дата запуска должна быть в будущем.",
        });
      }

      const {
        data,
        error,
      } =
        await supabaseServiceRole
          .from(
            "business_listing_billing_settings"
          )
          .update({
            billing_mode:
              "scheduled",

            billing_starts_at:
              startsAt
                .toISOString(),

            updated_by_user_id:
              user.id,

            updated_at:
              new Date()
                .toISOString(),
          })
          .eq(
            "id",
            "global"
          )
          .select("*")
          .single();

      if (error) {
        if (
          businessListingBillingSchemaMissing(
            error
          )
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_SCHEMA_NOT_READY",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_SCHEDULE_FAILED",
        });
      }

      console.log(
        "[AUTODEAR][BUSINESS_LISTING_BILLING][SCHEDULED]",
        {
          userId:
            user.id,

          billingStartsAt:
            data.billing_starts_at,
        }
      );

      return res.json({
        ok: true,

        settings:
          mapBusinessListingBillingSettings(
            data
          ),

        notificationsSent:
          false,

        chargesStarted:
          false,
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_SCHEDULE_FATAL",
        });
    }
  }
);


/*
 * Explicitly return billing to OFF.
 *
 * This does not refund past payments and does not
 * delete subscription history.
 */
app.post(
  "/api/director/business-listing-billing/off",
  async (req, res) => {
    try {
      if (
        !supabaseServiceRole
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_SERVICE_ROLE_NOT_CONFIGURED",
        });
      }

      const {
        user,
      } =
        await requireBusinessListingBillingDirectorUser(
          req
        );

      const body =
        req.body &&
        typeof req.body ===
          "object" &&
        !Array.isArray(
          req.body
        )
          ? req.body
          : {};

      if (
        String(
          body.confirmation ||
          ""
        ).trim() !==
        "ВЫКЛЮЧИТЬ"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_OFF_CONFIRMATION_REQUIRED",
        });
      }

      const {
        data,
        error,
      } =
        await supabaseServiceRole
          .from(
            "business_listing_billing_settings"
          )
          .update({
            billing_mode:
              "off",

            billing_starts_at:
              null,

            updated_by_user_id:
              user.id,

            updated_at:
              new Date()
                .toISOString(),
          })
          .eq(
            "id",
            "global"
          )
          .select("*")
          .single();

      if (error) {
        if (
          businessListingBillingSchemaMissing(
            error
          )
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "BUSINESS_LISTING_BILLING_SCHEMA_NOT_READY",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_BILLING_OFF_FAILED",
        });
      }

      console.log(
        "[AUTODEAR][BUSINESS_LISTING_BILLING][OFF]",
        {
          userId:
            user.id,
        }
      );

      return res.json({
        ok: true,

        settings:
          mapBusinessListingBillingSettings(
            data
          ),
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_OFF_FATAL",
        });
    }
  }
);


/*
 * Deliberate hard stop.
 *
 * Even a director cannot switch LIVE until the
 * payment scheduler, notification chain and visibility
 * gate are implemented and tested.
 */
app.post(
  "/api/director/business-listing-billing/live",
  async (req, res) => {
    try {
      await requireBusinessListingBillingDirectorUser(
        req
      );

      return res.status(409).json({
        ok: false,

        error:
          "BUSINESS_LISTING_BILLING_LIVE_NOT_READY",

        message:
          "Платное размещение ещё не готово к включению. Настройки можно подготовить заранее, но реальные списания пока заблокированы.",
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res
        .status(
          status
        )
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_LISTING_BILLING_LIVE_FATAL",
        });
    }
  }
);


/*
 * ============================================================
 * AUTODEAR — BUSINESS LISTING CLAIM FOUNDATION
 * ============================================================
 *
 * Business account and business listing are separate concepts.
 *
 * A staff-created listing:
 *   owner_id = NULL
 *   created_source = autodear_staff
 *   ownership_status = unclaimed
 *
 * created_by_user_id records the operator only.
 * It never grants business ownership.
 */

const BUSINESS_LISTING_CLAIM_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";


function normalizeBusinessListingClaimCode(
  value
) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}


function createBusinessListingClaimCode() {
  const randomPart = (length) => {
    let result = "";

    for (let index = 0; index < length; index += 1) {
      const position =
        crypto.randomInt(
          0,
          BUSINESS_LISTING_CLAIM_ALPHABET.length
        );

      result +=
        BUSINESS_LISTING_CLAIM_ALPHABET[
          position
        ];
    }

    return result;
  };

  return `AD-${randomPart(4)}-${randomPart(4)}`;
}


function digestBusinessListingClaimCode(
  value
) {
  const normalized =
    normalizeBusinessListingClaimCode(
      value
    );

  if (!normalized) {
    return "";
  }

  /*
   * The claim code has limited entropy, therefore a keyed
   * digest is preferable to a plain SHA-256 hash.
   *
   * Render must provide BUSINESS_LISTING_CLAIM_SECRET.
   */
  const secret =
    String(
      process.env
        .BUSINESS_LISTING_CLAIM_SECRET ||
        ""
    ).trim();

  if (!secret) {
    const error =
      new Error(
        "BUSINESS_LISTING_CLAIM_SECRET_NOT_CONFIGURED"
      );

    error.statusCode = 500;
    throw error;
  }

  return crypto
    .createHmac(
      "sha256",
      secret
    )
    .update(normalized)
    .digest("hex");
}


function getBusinessListingClaimCodeHint(
  value
) {
  const normalized =
    normalizeBusinessListingClaimCode(
      value
    );

  const suffix =
    normalized.slice(-4);

  return suffix
    ? `****-${suffix}`
    : null;
}


async function requireBusinessDirectoryStaffUser(
  req
) {
  /*
   * Business Directory staff access reuses the existing,
   * server-authoritative AUTODEAR staff authentication.
   *
   * Do not create a second role lookup here and never trust
   * a role supplied by the app/browser.
   */
  const staff =
    await requireAdsStaffUser(req);

  return {
    user:
      staff.user,

    role:
      staff.role,
  };
}

function normalizeBusinessListingPhone(
  value
) {
  const digits =
    String(value || "")
      .replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (
    digits.length === 11 &&
    digits.startsWith("8")
  ) {
    return `7${digits.slice(1)}`;
  }

  return digits;
}

function normalizeBusinessListingText(
  value
) {
  return String(
    value || ""
  )
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(
      /[^a-zа-я0-9]+/gi,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function normalizeBusinessListingAddress(
  value
) {
  return normalizeBusinessListingText(
    value
  )
    .replace(
      /\bулица\b/g,
      "ул"
    )
    .replace(
      /\bпроспект\b/g,
      "пр"
    )
    .replace(
      /\bпереулок\b/g,
      "пер"
    )
    .replace(
      /\bдом\b/g,
      "д"
    )
    .replace(
      /\s+/g,
      ""
    );
}


function scoreBusinessListingCandidate(
  row,
  input
) {
  let score = 0;

  const reasons = [];

  const wantedPhone =
    normalizeBusinessListingPhone(
      input?.phone
    );

  const rowPhone =
    normalizeBusinessListingPhone(
      row?.phone
    );

  if (
    wantedPhone &&
    rowPhone &&
    wantedPhone === rowPhone
  ) {
    score += 70;
    reasons.push(
      "Совпадает телефон"
    );
  }


  const wantedAddress =
    normalizeBusinessListingAddress(
      input?.address
    );

  const rowAddress =
    normalizeBusinessListingAddress(
      row?.address
    );

  if (
    wantedAddress &&
    rowAddress &&
    wantedAddress === rowAddress
  ) {
    score += 50;
    reasons.push(
      "Совпадает адрес"
    );
  }


  const wantedCity =
    normalizeBusinessListingText(
      input?.city
    );

  const rowCity =
    normalizeBusinessListingText(
      row?.city
    );

  if (
    wantedCity &&
    rowCity &&
    wantedCity === rowCity
  ) {
    score += 10;
    reasons.push(
      "Совпадает город"
    );
  }


  const wantedName =
    normalizeBusinessListingText(
      input?.name
    );

  const rowName =
    normalizeBusinessListingText(
      row?.name
    );

  if (
    wantedName &&
    rowName
  ) {
    if (
      wantedName === rowName
    ) {
      score += 30;
      reasons.push(
        "Совпадает название"
      );
    } else if (
      Math.min(
        wantedName.length,
        rowName.length
      ) >= 5 &&
      (
        wantedName.includes(
          rowName
        ) ||
        rowName.includes(
          wantedName
        )
      )
    ) {
      score += 20;
      reasons.push(
        "Похожее название"
      );
    }
  }


  return {
    id:
      row?.id || null,

    ownerId:
      row?.owner_id || null,

    name:
      row?.name || null,

    address:
      row?.address || null,

    city:
      row?.city || null,

    phone:
      row?.phone || null,

    /*
     * STATIONS_PHOTO_URL_CANONICAL_V1
     * Remote stations schema uses photo_url.
     */
    photoUrl:
      row?.photo_url ||
      null,

    businessType:
      row?.business_type ||
      null,

    ownershipStatus:
      row?.ownership_status ||
      null,

    createdSource:
      row?.created_source ||
      null,

    matchScore:
      score,

    matchReason:
      reasons.join(" · ") ||
      null,
  };
}


async function findBusinessListingDuplicateCandidates(
  input,
  options = {}
) {
  if (!supabase) {
    throw new Error(
      "SUPABASE_NOT_CONFIGURED"
    );
  }

  let query =
    supabase
      .from("stations")
      .select(
        [
          "id",
          "owner_id",
          "name",
          "address",
          "city",
          "phone",
          "photo_url",
          "business_type",
          "ownership_status",
          "created_source",
        ].join(",")
      );

  if (
    options?.unclaimedOnly ===
    true
  ) {
    query =
      query
        .is(
          "owner_id",
          null
        )
        .eq(
          "created_source",
          "autodear_staff"
        )
        .eq(
          "ownership_status",
          "unclaimed"
        );
  }

  const {
    data: rows,
    error,
  } =
    await query.limit(
      300
    );

  if (error) {
    console.error(
      "[AUTODEAR][BUSINESS_DIRECTORY][DUPLICATE_LOOKUP_ERROR]",
      {
        code:
          error.code ||
          null,

        message:
          error.message ||
          null,
      }
    );

    throw new Error(
      "BUSINESS_LISTING_DUPLICATE_LOOKUP_FAILED"
    );
  }

  return (
    Array.isArray(rows)
      ? rows
      : []
  )
    .map(
      (row) =>
        scoreBusinessListingCandidate(
          row,
          input
        )
    )
    .filter(
      (item) =>
        Number(
          item.matchScore ||
          0
        ) >= 50
    )
    .sort(
      (a, b) =>
        Number(
          b.matchScore ||
          0
        ) -
        Number(
          a.matchScore ||
          0
        )
    );
}


function normalizeBusinessListingPhotoUrl(
  value
) {
  const raw =
    String(
      value || ""
    ).trim();

  if (!raw) {
    return "";
  }

  try {
    const parsed =
      new URL(
        raw
      );

    if (
      parsed.protocol !==
      "https:"
    ) {
      return null;
    }

    if (
      !parsed.pathname.includes(
        "/storage/v1/object/public/business-photos/"
      )
    ) {
      return null;
    }

    const configuredSupabaseUrl =
      String(
        process.env
          .SUPABASE_URL ||
        ""
      ).trim();

    if (
      configuredSupabaseUrl
    ) {
      const configuredHost =
        new URL(
          configuredSupabaseUrl
        ).hostname;

      if (
        parsed.hostname !==
        configuredHost
      ) {
        return null;
      }
    }

    return raw;
  } catch {
    return null;
  }
}



/*
 * STAFF_CREATE_DIAGNOSTICS_V1
 *
 * TEMPORARY release diagnostic.
 *
 * Stores only technical stage/timing information.
 * No business form payload, phone, address or photo is stored.
 */
let latestStaffBusinessListingCreateDiagnostic =
  null;


function markStaffBusinessListingCreateDiagnostic(
  requestId,
  startedAt,
  stage,
  extra = {}
) {
  const now =
    Date.now();

  latestStaffBusinessListingCreateDiagnostic = {
    requestId,
    stage,

    startedAt:
      new Date(
        startedAt
      ).toISOString(),

    updatedAt:
      new Date(
        now
      ).toISOString(),

    elapsedMs:
      now -
      startedAt,

    ...extra,
  };

  console.log(
    "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_CREATE_DIAG]",
    latestStaffBusinessListingCreateDiagnostic
  );
}


/*
 * Dry-run duplicate check for AUTODEAR staff.
 *
 * IMPORTANT:
 * - creates nothing;
 * - changes no ownership;
 * - returns only possible matches;
 * - the real POST /staff/listings performs the same
 *   duplicate protection again to avoid races.
 */
app.post(
  "/api/business-directory/staff/listings/check",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      await requireBusinessDirectoryStaffUser(
        req
      );

      const body =
        req.body &&
        typeof req.body ===
          "object" &&
        !Array.isArray(
          req.body
        )
          ? req.body
          : {};

      const name =
        String(
          body.name || ""
        ).trim();

      const address =
        String(
          body.address || ""
        ).trim();

      const city =
        String(
          body.city || ""
        ).trim();

      const phone =
        String(
          body.phone || ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_NAME_REQUIRED",
          message:
            "Укажите название сервиса.",
        });
      }

      if (!address) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_ADDRESS_REQUIRED",
          message:
            "Укажите адрес сервиса.",
        });
      }

      const candidates =
        await findBusinessListingDuplicateCandidates({
          name,
          address,
          city,
          phone,
        });

      /*
       * 70+:
       * - точный телефон;
       * - адрес + название;
       * - другие сильные комбинации.
       *
       * Один только адрес = 50 и НЕ блокирует создание.
       */
      const blockingCandidates =
        candidates
          .filter(
            (item) =>
              Number(
                item.matchScore ||
                0
              ) >= 70
          )
          .slice(
            0,
            5
          );

      console.log(
        "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DUPLICATE_CHECK]",
        {
          name,
          city:
            city || null,

          candidates:
            candidates.length,

          blocking:
            blockingCandidates
              .length,
        }
      );

      return res.json({
        ok: true,

        duplicate:
          blockingCandidates.length >
          0,

        candidates:
          blockingCandidates,

        possibleCandidates:
          candidates
            .filter(
              (item) =>
                Number(
                  item.matchScore ||
                  0
                ) < 70
            )
            .slice(
              0,
              5
            ),
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DUPLICATE_CHECK_FATAL]",
        {
          status,

          message:
            error?.message ||
            String(
              error
            ),
        }
      );

      return res
        .status(
          status
        )
        .json({
          ok: false,

          error:
            error?.message ||
            "BUSINESS_LISTING_DUPLICATE_CHECK_FAILED",
        });
    }
  }
);


/*
 * Staff creates an ownerless business listing and receives
 * a one-time paper confirmation code.
 */
app.post(
  "/api/business-directory/staff/listings",
  async (req, res) => {
    const diagnosticRequestId =
      crypto.randomUUID();

    const diagnosticStartedAt =
      Date.now();

    /*
     * STAFF_CREATE_DIAGNOSTICS_V3
     *
     * finish = Express successfully completed the HTTP response.
     * Preserve the last business stage before response_finished,
     * otherwise the useful failure stage is lost.
     *
     * close without finish = connection ended before response completed.
     */
    let diagnosticResponseFinished =
      false;

    res.on(
      "finish",
      () => {
        diagnosticResponseFinished =
          true;

        const previousDiagnostic =
          latestStaffBusinessListingCreateDiagnostic
            ?.requestId ===
          diagnosticRequestId
            ? latestStaffBusinessListingCreateDiagnostic
            : null;

        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "response_finished",
          {
            httpStatus:
              res.statusCode,

            previousStage:
              previousDiagnostic
                ?.stage ||
              null,

            previousHasError:
              previousDiagnostic
                ?.hasError ===
              true,

            previousStationCreated:
              previousDiagnostic
                ?.stationCreated ===
              true,
          }
        );
      }
    );

    res.on(
      "close",
      () => {
        if (
          diagnosticResponseFinished
        ) {
          return;
        }

        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "response_closed_before_finish",
          {
            httpStatus:
              res.statusCode,
          }
        );
      }
    );

    markStaffBusinessListingCreateDiagnostic(
      diagnosticRequestId,
      diagnosticStartedAt,
      "received"
    );

    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "auth_start"
      );

      const {
        user,
      } =
        await requireBusinessDirectoryStaffUser(
          req
        );

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "auth_done"
      );

      const body =
        req.body &&
        typeof req.body === "object" &&
        !Array.isArray(req.body)
          ? req.body
          : {};

      const name =
        String(
          body.name || ""
        ).trim();

      const address =
        String(
          body.address || ""
        ).trim();

      const city =
        String(
          body.city || ""
        ).trim();

      const phone =
        String(
          body.phone || ""
        ).trim();

      /*
       * STAFF_DIRECTORY_WORK_SCHEDULE_FINAL_V1
       */
      const effectivePhone =
        String(phone || "")
          .replace(/\D/g, "")
          .length > 1
            ? phone
            : "";

      const works24x7 =
        body.works24x7 === true ||
        body.works_24_7 === true;

      const rawWorkSchedule =
        Array.isArray(
          body.workSchedule
        )
          ? body.workSchedule
          : Array.isArray(
              body.work_schedule
            )
          ? body.work_schedule
          : [];

      const dayDefinitions = [
        ["mon", "Понедельник", "Пн"],
        ["tue", "Вторник", "Вт"],
        ["wed", "Среда", "Ср"],
        ["thu", "Четверг", "Чт"],
        ["fri", "Пятница", "Пт"],
        ["sat", "Суббота", "Сб"],
        ["sun", "Воскресенье", "Вс"],
      ];

      const workSchedule =
        dayDefinitions.map(
          ([id, title, short]) => {
            const source =
              rawWorkSchedule.find(
                (item) =>
                  String(
                    item?.id || ""
                  )
                    .trim()
                    .toLowerCase() ===
                  id
              );

            return {
              id,
              title,
              short,

              enabled:
                source?.enabled ===
                true,

              open:
                String(
                  source?.open ||
                    "08:00"
                ).trim(),

              close:
                String(
                  source?.close ||
                    "18:00"
                ).trim(),
            };
          }
        );

      if (!works24x7) {
        const activeDays =
          workSchedule.filter(
            (day) =>
              day.enabled
          );

        if (!activeDays.length) {
          return res
            .status(400)
            .json({
              ok: false,

              error:
                "BUSINESS_LISTING_WORK_SCHEDULE_REQUIRED",

              message:
                "Выберите хотя бы один рабочий день.",
            });
        }

        const timePattern =
          /^([01]\d|2[0-3]):[0-5]\d$/;

        const invalidDay =
          activeDays.find(
            (day) =>
              !timePattern.test(
                day.open
              ) ||
              !timePattern.test(
                day.close
              ) ||
              day.open ===
                day.close
          );

        if (invalidDay) {
          return res
            .status(400)
            .json({
              ok: false,

              error:
                "BUSINESS_LISTING_WORK_SCHEDULE_INVALID",

              message:
                `Проверьте график для дня «${invalidDay.title}».`,
            });
        }
      }

      const workHours =
        works24x7
          ? "Круглосуточно"
          : (
              String(
                body.workHours ||
                  body.work_hours ||
                  ""
              ).trim() ||
              workSchedule
                .filter(
                  (day) =>
                    day.enabled
                )
                .map(
                  (day) =>
                    `${day.short} · ${day.open}–${day.close}`
                )
                .join("; ")
            );



      const addressFull =
        String(
          body.addressFull ||
          body.address_full ||
          address ||
          ""
        ).trim();

      const latitudeValue =
        body.latitude == null ||
        body.latitude === ""
          ? null
          : Number(
              body.latitude
            );

      const longitudeValue =
        body.longitude == null ||
        body.longitude === ""
          ? null
          : Number(
              body.longitude
            );

      const latitude =
        Number.isFinite(
          latitudeValue
        )
          ? latitudeValue
          : null;

      const longitude =
        Number.isFinite(
          longitudeValue
        )
          ? longitudeValue
          : null;

      const rawPhotoUrl =
        String(
          body.photoUrl ||
          body.photo_url ||
          ""
        ).trim();

      const photoUrl =
        normalizeBusinessListingPhotoUrl(
          rawPhotoUrl
        );

      const allowDuplicate =
        body.allowDuplicate ===
        true;

      /*
       * Classification comes from the canonical
       * AUTODEAR business catalog selected by staff.
       *
       * These are explicit whitelisted fields only.
       * No arbitrary client properties are spread
       * into the stations row.
       */
      const directions =
        Array.from(
          new Set(
            (
              Array.isArray(
                body.directions
              )
                ? body.directions
                : []
            )
              .map(
                (item) =>
                  String(
                    item || ""
                  )
                    .trim()
                    .slice(
                      0,
                      80
                    )
              )
              .filter(
                Boolean
              )
          )
        ).slice(
          0,
          12
        );

      const requestedServices =
        Array.isArray(
          body.services
        )
          ? body.services
          : [];

      const requestedServiceMap =
        new Map();

      for (
        const raw of
        requestedServices
      ) {
        const serviceId =
          String(
            raw?.serviceId ||
            raw?.id ||
            ""
          ).trim();

        if (!serviceId) {
          continue;
        }

        requestedServiceMap.set(
          serviceId,
          {
            serviceId,

            direction:
              String(
                raw?.direction ||
                ""
              ).trim(),
          }
        );
      }

      const requestedServiceIds =
        Array.from(
          requestedServiceMap.keys()
        ).slice(
          0,
          100
        );

      let serviceCatalogRows = [];


      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_NAME_REQUIRED",
        });
      }

      if (!address) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_ADDRESS_REQUIRED",
        });
      }


      if (!city) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CITY_REQUIRED",
          message:
            "Выберите город сервиса.",
        });
      }

      if (
        directions.length !== 1
      ) {
        return res.status(400).json({
          ok: false,

          error:
            "BUSINESS_LISTING_DIRECTION_REQUIRED",

          message:
            "Выберите одно направление бизнеса.",
        });
      }

      const primaryDirection =
        directions[0];


      if (
        requestedServiceIds.length
      ) {
        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "service_catalog_start",
          {
            serviceCount:
              requestedServiceIds.length,
          }
        );

        const {
          data: catalog,
          error: catalogError,
        } = await supabase
          .from("services")
          .select(
            [
              "id",
              "title",
              "category",
            ].join(",")
          )
          .in(
            "id",
            requestedServiceIds
          );

        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "service_catalog_done",
          {
            hasError:
              Boolean(
                catalogError
              ),
          }
        );

        if (catalogError) {
          console.error(
            "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_SERVICE_CATALOG_ERROR]",
            {
              userId:
                user.id,

              code:
                catalogError.code ||
                null,

              message:
                catalogError.message ||
                null,
            }
          );

          return res.status(500).json({
            ok: false,

            error:
              "SERVICE_CATALOG_LOOKUP_FAILED",
          });
        }

        serviceCatalogRows =
          Array.isArray(
            catalog
          )
            ? catalog
            : [];

        const validIds =
          new Set(
            serviceCatalogRows.map(
              (item) =>
                String(
                  item?.id ||
                  ""
                )
            )
          );

        const invalidIds =
          requestedServiceIds.filter(
            (serviceId) =>
              !validIds.has(
                serviceId
              )
          );

        if (
          invalidIds.length
        ) {
          markStaffBusinessListingCreateDiagnostic(
            diagnosticRequestId,
            diagnosticStartedAt,
            "rejected_unknown_service",
            {
              invalidCount:
                invalidIds.length,
            }
          );

          return res.status(400).json({
            ok: false,

            error:
              "UNKNOWN_SERVICE",

            invalidServiceIds:
              invalidIds,
          });
        }

        const invalidDirections =
          requestedServiceIds.filter(
            (serviceId) => {
              const requested =
                requestedServiceMap.get(
                  serviceId
                );

              const requestedDirection =
                String(
                  requested
                    ?.direction ||
                    ""
                ).trim();

              return (
                requestedDirection &&
                requestedDirection !==
                  primaryDirection
              );
            }
          );

        if (
          invalidDirections.length
        ) {
          markStaffBusinessListingCreateDiagnostic(
            diagnosticRequestId,
            diagnosticStartedAt,
            "rejected_direction_mismatch",
            {
              invalidCount:
                invalidDirections.length,
            }
          );

          return res.status(400).json({
            ok: false,

            error:
              "BUSINESS_SERVICE_DIRECTION_MISMATCH",

            invalidServiceIds:
              invalidDirections,
          });
        }
      }


      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "post_catalog_validation",
        {
          hasLatitude:
            latitude != null,

          hasLongitude:
            longitude != null,

          hasPhotoUrl:
            Boolean(
              photoUrl
            ),

          directionCount:
            directions.length,

          serviceCount:
            requestedServiceIds.length,
        }
      );

      if (
        latitude == null ||
        longitude == null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "rejected_geo_required",
          {
            hasLatitude:
              latitude != null,

            hasLongitude:
              longitude != null,
          }
        );

        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_GEO_REQUIRED",
          message:
            "Выберите точный адрес из подсказок AUTODEAR.",
        });
      }


      if (
        rawPhotoUrl &&
        !photoUrl
      ) {
        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "rejected_photo_invalid"
        );

        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_PHOTO_INVALID",
          message:
            "Фотография должна быть загружена в хранилище AUTODEAR.",
        });
      }


      /*
       * Проверка выполняется ДО INSERT.
       *
       * Адрес сам по себе никогда не подтверждает,
       * что это один и тот же бизнес. Но он может
       * участвовать в оценке вместе с названием,
       * городом или телефоном.
       */
      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "duplicate_lookup_start"
      );

      const duplicateCandidates =
        await findBusinessListingDuplicateCandidates({
          name,
          address,
          city,
          phone,
        });

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "duplicate_lookup_done",
        {
          candidateCount:
            duplicateCandidates.length,
        }
      );

      const blockingDuplicates =
        duplicateCandidates.filter(
          (item) =>
            Number(
              item.matchScore ||
              0
            ) >= 70
        );

      if (
        blockingDuplicates.length &&
        !allowDuplicate
      ) {
        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "rejected_duplicate",
          {
            duplicateCount:
              blockingDuplicates.length,
          }
        );

        return res.status(409).json({
          ok: false,

          error:
            "BUSINESS_LISTING_DUPLICATE_SUSPECTED",

          message:
            "Похоже, этот сервис уже есть в AUTODEAR.",

          candidates:
            blockingDuplicates.slice(
              0,
              5
            ),
        });
      }

      /*
       * IMPORTANT:
       * Do not pass arbitrary client fields into stations.
       * Keep the staff creation surface intentionally small.
       */
      const stationServiceTemplates =
        serviceCatalogRows.map(
          (catalogItem) => {
            const serviceId =
              String(
                catalogItem?.id ||
                ""
              );

            return {
              serviceId,

              title:
                String(
                  catalogItem?.title ||
                  "Услуга"
                ).trim(),

              direction:
                primaryDirection,
            };
          }
        );

      const services =
        stationServiceTemplates.map(
          (item) =>
            item.title
        );


      const stationPayload = {
        owner_id: null,
        name,
        address,
        city: city || null,
        phone:
          effectivePhone ||
          null,

        work_hours:
          workHours,

        work_schedule:
          workSchedule,

        works_24_7:
          works24x7,

        /*
         * Карточка без подтверждённого владельца
         * не принимает онлайн-записи.
         */
        online_booking_enabled:
          false,

        directions,

        services,

        address_full:
          addressFull ||
          address,

        latitude,

        longitude,

        ...(photoUrl
          ? {
              photo_url:
                photoUrl,
            }
          : {}),

        created_source:
          "autodear_staff",

        created_by_user_id:
          user.id,

        ownership_status:
          "unclaimed",

        claimed_by_user_id:
          null,

        claimed_at:
          null,

        is_verified:
          false,
      };

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "station_insert_start"
      );

      const {
        data: station,
        error: stationError,
      } = await supabase
        .from("stations")
        .insert(
          stationPayload
        )
        .select(
          [
            "id",
            "owner_id",
            "name",
            "address",
            "city",
            "phone",
            "directions",
            "services",
            "photo_url",
            "created_source",
            "created_by_user_id",
            "ownership_status",
            "created_at",
          ].join(",")
        )
        .single();

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "station_insert_done",
        {
          hasError:
            Boolean(
              stationError
            ),

          stationCreated:
            Boolean(
              station?.id
            ),
        }
      );

      if (stationError) {
        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_CREATE_STATION_ERROR]",
          {
            code:
              stationError.code ||
              null,
            message:
              stationError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CREATE_FAILED",
        });
      }

      if (
        stationServiceTemplates.length
      ) {
        const stationServiceRows =
          stationServiceTemplates.map(
            (item) => ({
              id:
                `${station.id}_${item.serviceId}`,

              station_id:
                station.id,

              service_id:
                item.serviceId,

              title:
                item.title,

              direction:
                item.direction,
            })
          );

        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "station_services_start",
          {
            serviceCount:
              stationServiceTemplates.length,
          }
        );

        const {
          error:
            servicesSaveError,
        } = await supabase
          .from(
            "station_services"
          )
          .upsert(
            stationServiceRows
          );

        markStaffBusinessListingCreateDiagnostic(
          diagnosticRequestId,
          diagnosticStartedAt,
          "station_services_done",
          {
            hasError:
              Boolean(
                servicesSaveError
              ),
          }
        );

        if (
          servicesSaveError
        ) {
          console.error(
            "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_SERVICES_SAVE_ERROR]",
            {
              stationId:
                station.id,

              userId:
                user.id,

              code:
                servicesSaveError
                  .code ||
                null,

              message:
                servicesSaveError
                  .message ||
                null,
            }
          );

          const {
            error:
              cleanupError,
          } = await supabase
            .from("stations")
            .delete()
            .eq(
              "id",
              station.id
            )
            .is(
              "owner_id",
              null
            )
            .eq(
              "created_source",
              "autodear_staff"
            )
            .eq(
              "ownership_status",
              "unclaimed"
            );

          if (
            cleanupError
          ) {
            console.error(
              "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_SERVICES_CLEANUP_ERROR]",
              cleanupError
            );
          }

          return res.status(500).json({
            ok: false,

            error:
              "BUSINESS_SERVICES_SAVE_FAILED",
          });
        }
      }


      const claimCode =
        createBusinessListingClaimCode();

      const codeDigest =
        digestBusinessListingClaimCode(
          claimCode
        );

      const codeHint =
        getBusinessListingClaimCodeHint(
          claimCode
        );

      /*
       * Revoke any unexpected active code before inserting
       * the current one. Normally a brand-new station has none.
       */
      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "claim_revoke_start"
      );

      await supabase
        .from(
          "business_listing_claim_codes"
        )
        .update({
          status: "revoked",
          revoked_at:
            new Date().toISOString(),
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "station_id",
          station.id
        )
        .eq(
          "status",
          "active"
        );

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "claim_revoke_done"
      );

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "claim_code_insert_start"
      );

      const {
        error: codeError,
      } = await supabase
        .from(
          "business_listing_claim_codes"
        )
        .insert({
          station_id:
            station.id,

          code_digest:
            codeDigest,

          code_hint:
            codeHint,

          status:
            "active",

          issued_by_user_id:
            user.id,
        });

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "claim_code_insert_done",
        {
          hasError:
            Boolean(
              codeError
            ),
        }
      );

      if (codeError) {
        /*
         * Do not leave a public claimable listing without
         * its confirmation credential.
         */
        const {
          error: cleanupError,
        } = await supabase
          .from("stations")
          .delete()
          .eq(
            "id",
            station.id
          )
          .is(
            "owner_id",
            null
          )
          .eq(
            "created_source",
            "autodear_staff"
          )
          .eq(
            "ownership_status",
            "unclaimed"
          );

        if (cleanupError) {
          console.error(
            "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_CREATE_CLEANUP_ERROR]",
            cleanupError
          );
        }

        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_CREATE_CODE_ERROR]",
          {
            code:
              codeError.code ||
              null,
            message:
              codeError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_CREATE_FAILED",
        });
      }

      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "success",
        {
          stationCreated:
            true,
        }
      );

      return res.status(201).json({
        ok: true,

        listing: {
          id:
            station.id,

          name:
            station.name,

          address:
            station.address,

          city:
            station.city,

          phone:
            station.phone,

          directions:
            Array.isArray(
              station.directions
            )
              ? station.directions
              : [],

          services:
            Array.isArray(
              station.services
            )
              ? station.services
              : [],

          photoUrl:
            station.photo_url ||
            null,

          ownershipStatus:
            station.ownership_status,

          createdAt:
            station.created_at,
        },

        /*
         * Plaintext is returned exactly at issuance time.
         * It is never persisted in the database.
         */
        confirmationCode:
          claimCode,

        claimCode,

        codeHint,

        claimCodeHint:
          codeHint,
      });
    } catch (error) {
      markStaffBusinessListingCreateDiagnostic(
        diagnosticRequestId,
        diagnosticStartedAt,
        "fatal",
        {
          error:
            String(
              error?.message ||
              error ||
              "UNKNOWN"
            ).slice(
              0,
              160
            ),
        }
      );

      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_CREATE_FATAL]",
        {
          status,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "BUSINESS_LISTING_CREATE_FATAL",
      });
    }
  }
);

/*
 * TEMPORARY STAFF CREATE DIAGNOSTIC.
 *
 * Protected by the same staff authorization as creation.
 * Remove after release blocker is diagnosed.
 */
app.get(
  "/api/business-directory/staff/listings/diagnostics/latest",
  async (req, res) => {
    try {
      await requireBusinessDirectoryStaffUser(
        req
      );

      return res.json({
        ok: true,

        diagnostic:
          latestStaffBusinessListingCreateDiagnostic,
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res
        .status(status)
        .json({
          ok: false,

          error:
            error?.message ||
            "STAFF_CREATE_DIAGNOSTIC_FAILED",
        });
    }
  }
);


/*
 * Delete an AUTODEAR staff-created listing
 * only while it is still completely unclaimed.
 *
 * This route must never become a generic station delete.
 */
app.delete(
  "/api/business-directory/staff/listings/:stationId",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      await requireBusinessDirectoryStaffUser(
        req
      );

      const stationId =
        String(
          req.params
            ?.stationId ||
          ""
        ).trim();

      if (!stationId) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_ID_REQUIRED",
          message:
            "Не указан ID карточки.",
        });
      }


      /*
       * Сначала читаем карточку.
       * Никаких удалений до проверки владения.
       */
      const {
        data: station,
        error: stationError,
      } =
        await supabase
          .from(
            "stations"
          )
          .select(
            [
              "id",
              "owner_id",
              "name",
              "photo_url",
              "created_source",
              "ownership_status",
              "claimed_by_user_id",
            ].join(",")
          )
          .eq(
            "id",
            stationId
          )
          .maybeSingle();

      if (stationError) {
        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DELETE_LOOKUP_ERROR]",
          {
            stationId,

            code:
              stationError
                .code ||
              null,

            message:
              stationError
                .message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_DELETE_LOOKUP_FAILED",
        });
      }

      if (!station) {
        return res.status(404).json({
          ok: false,
          error:
            "BUSINESS_LISTING_NOT_FOUND",
          message:
            "Карточка уже удалена или не существует.",
        });
      }


      const canDelete =
        !station.owner_id &&
        String(
          station
            .created_source ||
          ""
        ) ===
          "autodear_staff" &&
        String(
          station
            .ownership_status ||
          ""
        ) ===
          "unclaimed" &&
        !station
          .claimed_by_user_id;

      if (!canDelete) {
        return res.status(409).json({
          ok: false,
          error:
            "BUSINESS_LISTING_DELETE_NOT_ALLOWED",
          message:
            "Эту карточку уже нельзя удалить как служебную: у неё появился владелец или началась процедура передачи.",
        });
      }


      /*
       * Запоминаем только staff-фото.
       *
       * После успешного DELETE попробуем удалить
       * соответствующий объект из Storage.
       * Ошибка удаления фото не должна возвращать
       * удалённую station обратно.
       */
      let staffPhotoPath =
        null;

      const photoUrl =
        String(
          station
            .photo_url ||
          ""
        ).trim();

      if (photoUrl) {
        try {
          const parsed =
            new URL(
              photoUrl
            );

          const marker =
            "/storage/v1/object/public/business-photos/";

          const markerIndex =
            parsed.pathname.indexOf(
              marker
            );

          if (
            markerIndex >=
            0
          ) {
            const encodedPath =
              parsed.pathname.slice(
                markerIndex +
                  marker.length
              );

            const decodedPath =
              decodeURIComponent(
                encodedPath
              )
                .replace(
                  /^\/+/,
                  ""
                );

            /*
             * Не удаляем произвольное бизнес-фото.
             * Только фотографии, которые создал
             * именно staff-flow.
             */
            if (
              decodedPath.includes(
                "/staff_directory_"
              )
            ) {
              staffPhotoPath =
                decodedPath;
            }
          }
        } catch {}
      }


      const {
        data:
          deletedStation,
        error:
          deleteError,
      } =
        await supabase
          .from(
            "stations"
          )
          .delete()
          .eq(
            "id",
            stationId
          )
          .is(
            "owner_id",
            null
          )
          .eq(
            "created_source",
            "autodear_staff"
          )
          .eq(
            "ownership_status",
            "unclaimed"
          )
          .is(
            "claimed_by_user_id",
            null
          )
          .select(
            "id"
          )
          .maybeSingle();

      if (deleteError) {
        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DELETE_ERROR]",
          {
            stationId,

            code:
              deleteError
                .code ||
              null,

            message:
              deleteError
                .message ||
              null,
          }
        );

        /*
         * FK restrict — значит карточка уже участвует
         * в рабочих данных. Ничего принудительно
         * каскадом не уничтожаем.
         */
        if (
          String(
            deleteError
              .code ||
            ""
          ) ===
          "23503"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "BUSINESS_LISTING_DELETE_BLOCKED",
            message:
              "Карточка уже связана с рабочими данными AUTODEAR и не может быть удалена автоматически.",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_DELETE_FAILED",
          message:
            deleteError
              .message ||
            "Не удалось удалить карточку.",
        });
      }

      if (!deletedStation?.id) {
        return res.status(409).json({
          ok: false,
          error:
            "BUSINESS_LISTING_DELETE_STATE_CHANGED",
          message:
            "Статус карточки изменился. Удаление отменено.",
        });
      }


      let photoRemoved =
        false;

      if (staffPhotoPath) {
        const {
          error:
            photoDeleteError,
        } =
          await supabase
            .storage
            .from(
              "business-photos"
            )
            .remove([
              staffPhotoPath,
            ]);

        if (
          photoDeleteError
        ) {
          console.warn(
            "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DELETE_PHOTO_WARNING]",
            {
              stationId,

              path:
                staffPhotoPath,

              message:
                photoDeleteError
                  .message ||
                null,
            }
          );
        } else {
          photoRemoved =
            true;
        }
      }


      console.log(
        "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DELETE_OK]",
        {
          stationId,
          name:
            station.name ||
            null,

          photoRemoved,
        }
      );

      return res.json({
        ok: true,

        deleted:
          true,

        stationId,

        photoRemoved,
      });

    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][STAFF_DELETE_FATAL]",
        {
          status,

          message:
            error?.message ||
            String(
              error
            ),
        }
      );

      return res
        .status(
          status
        )
        .json({
          ok: false,

          error:
            error?.message ||
            "BUSINESS_LISTING_DELETE_FATAL",
        });
    }
  }
);



/*
 * Candidate discovery for a logged-in business account.
 *
 * Only explicitly staff-created, still-unclaimed listings
 * participate in ownership discovery.
 */
app.get(
  "/api/business-directory/claim/candidates",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const authResult =
        await resolveAuthenticatedUser(
          req
        );

      const user =
        authResult?.user || null;

      const userId =
        String(
          user?.id || ""
        ).trim();

      if (!userId) {
        return res.status(401).json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
      }

      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from("profiles")
        .select(
          "id,auth_user_id,name,email,phone,city,role"
        )
        .or(
          `auth_user_id.eq.${userId},id.eq.${userId}`
        )
        .limit(1)
        .maybeSingle();

      if (profileError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CLAIM_PROFILE_LOOKUP_FAILED",
        });
      }

      /*
       * Если экран регистрации передал телефон бизнеса,
       * он важнее общего телефона профиля.
       */
      const requestedPhone =
        normalizeBusinessListingPhone(
          req.query?.phone
        );

      const profilePhone =
        normalizeBusinessListingPhone(
          profile?.phone
        );

      const phone =
        requestedPhone ||
        profilePhone;

      const city =
        String(
          req.query?.city ||
          profile?.city ||
          ""
        ).trim();

      const name =
        String(
          req.query?.name ||
          ""
        ).trim();

      const address =
        String(
          req.query?.address ||
          ""
        ).trim();

      if (
        !phone &&
        !name &&
        !address
      ) {
        return res.json({
          ok: true,
          candidates: [],
          count: 0,
          match:
            "none",
        });
      }

      /*
       * Здесь ищем ТОЛЬКО созданные AUTODEAR
       * карточки без владельца.
       *
       * Совпадение никогда не передаёт владение
       * автоматически. Оно лишь предлагает
       * существующую карточку пользователю.
       */
      const candidates =
        await findBusinessListingDuplicateCandidates(
          {
            name,
            address,
            city,
            phone,
          },
          {
            unclaimedOnly:
              true,
          }
        );

      const limitedCandidates =
        candidates.slice(
          0,
          20
        );

      return res.json({
        ok: true,

        candidates:
          limitedCandidates,

        count:
          limitedCandidates.length,

        match:
          limitedCandidates.length === 1
            ? "single"
            : limitedCandidates.length > 1
              ? "multiple"
              : "none",
      });

    } catch (error) {
      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][CANDIDATES_FATAL]",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "BUSINESS_CLAIM_CANDIDATES_FATAL",
      });
    }
  }
);


/*
 * Create a manual ownership-confirmation request.
 *
 * IMPORTANT:
 * This endpoint never changes stations.owner_id.
 */
app.post(
  "/api/business-directory/claim/requests",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const authResult =
        await resolveAuthenticatedUser(
          req
        );

      const user =
        authResult?.user || null;

      const userId =
        String(
          user?.id || ""
        ).trim();

      if (!userId) {
        return res.status(401).json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
      }

      const stationId =
        String(
          req.body?.stationId ||
          ""
        ).trim();

      if (!stationId) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_ID_REQUIRED",
        });
      }

      const {
        data: station,
        error: stationError,
      } = await supabase
        .from("stations")
        .select(
          "id,owner_id,ownership_status,created_source,name"
        )
        .eq(
          "id",
          stationId
        )
        .is(
          "owner_id",
          null
        )
        .eq(
          "created_source",
          "autodear_staff"
        )
        .eq(
          "ownership_status",
          "unclaimed"
        )
        .maybeSingle();

      if (stationError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_LOOKUP_FAILED",
        });
      }

      if (!station) {
        return res.status(409).json({
          ok: false,
          error:
            "BUSINESS_LISTING_NOT_CLAIMABLE",
        });
      }

      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from("profiles")
        .select(
          "id,email,phone"
        )
        .or(
          `auth_user_id.eq.${userId},id.eq.${userId}`
        )
        .limit(1)
        .maybeSingle();

      if (profileError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CLAIM_PROFILE_LOOKUP_FAILED",
        });
      }

      const payload = {
        station_id:
          stationId,

        requesting_auth_user_id:
          userId,

        requesting_profile_id:
          profile?.id ||
          null,

        method:
          "manual",

        status:
          "requested",

        applicant_phone:
          profile?.phone ||
          null,

        applicant_email:
          profile?.email ||
          user?.email ||
          null,

        applicant_note:
          String(
            req.body?.note ||
            ""
          )
            .trim()
            .slice(
              0,
              2000
            ) ||
          null,
      };

      const {
        data: claim,
        error: claimError,
      } = await supabase
        .from(
          "business_listing_claims"
        )
        .insert(payload)
        .select(
          "id,station_id,status,method,created_at"
        )
        .single();

      if (claimError) {
        /*
         * Partial unique index protects against duplicate
         * simultaneously-open requests.
         */
        if (
          String(
            claimError.code ||
            ""
          ) === "23505"
        ) {
          const {
            data: existing,
          } = await supabase
            .from(
              "business_listing_claims"
            )
            .select(
              "id,station_id,status,method,created_at"
            )
            .eq(
              "station_id",
              stationId
            )
            .eq(
              "requesting_auth_user_id",
              userId
            )
            .in(
              "status",
              [
                "requested",
                "under_review",
                "approved",
              ]
            )
            .order(
              "created_at",
              {
                ascending:
                  false,
              }
            )
            .limit(1)
            .maybeSingle();

          return res.json({
            ok: true,
            duplicate: true,
            claim:
              existing ||
              null,
          });
        }

        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][CLAIM_REQUEST_ERROR]",
          claimError
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CLAIM_REQUEST_FAILED",
        });
      }

      return res.status(201).json({
        ok: true,
        claim,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][CLAIM_REQUEST_FATAL]",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "BUSINESS_CLAIM_REQUEST_FATAL",
      });
    }
  }
);



/*
 * BUSINESS LISTING CLAIM — STAFF REVIEW
 */

app.get(
  "/api/business-directory/staff/claim-requests",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: "SUPABASE_NOT_CONFIGURED",
        });
      }

      await requireBusinessDirectoryStaffUser(req);

      const requestedStatus =
        String(req.query?.status || "").trim();

      const allowedStatuses =
        new Set([
          "requested",
          "under_review",
          "approved",
          "rejected",
          "claimed",
          "cancelled",
        ]);

      let query =
        supabase
          .from("business_listing_claims")
          .select(
            [
              "id",
              "station_id",
              "requesting_auth_user_id",
              "requesting_profile_id",
              "method",
              "status",
              "applicant_phone",
              "applicant_email",
              "staff_note",
              "applicant_note",
              "decided_by_user_id",
              "decided_at",
              "claimed_at",
              "created_at",
              "updated_at",
            ].join(",")
          )
          .order(
            "created_at",
            { ascending: false }
          )
          .limit(200);

      if (
        requestedStatus &&
        allowedStatuses.has(requestedStatus)
      ) {
        query =
          query.eq(
            "status",
            requestedStatus
          );
      }

      const {
        data: claims,
        error: claimsError,
      } = await query;

      if (claimsError) {
        throw claimsError;
      }

      const claimRows =
        Array.isArray(claims)
          ? claims
          : [];

      const stationIds =
        [
          ...new Set(
            claimRows
              .map((item) =>
                String(
                  item?.station_id || ""
                ).trim()
              )
              .filter(Boolean)
          ),
        ];

      let stationRows = [];

      if (stationIds.length) {
        const {
          data,
          error,
        } =
          await supabase
            .from("stations")
            .select(
              [
                "id",
                "name",
                "address",
                "city",
                "phone",
                "owner_id",
                "ownership_status",
                "created_source",
              ].join(",")
            )
            .in(
              "id",
              stationIds
            );

        if (error) {
          throw error;
        }

        stationRows =
          Array.isArray(data)
            ? data
            : [];
      }

      const stationById =
        new Map(
          stationRows.map(
            (station) => [
              String(station.id),
              station,
            ]
          )
        );

      return res.json({
        ok: true,
        claims:
          claimRows.map(
            (claim) => ({
              ...claim,
              station:
                stationById.get(
                  String(
                    claim.station_id
                  )
                ) || null,
            })
          ),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][BUSINESS_CLAIM][STAFF_LIST_FATAL]",
        error
      );

      return res
        .status(status)
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_CLAIM_STAFF_LIST_FATAL",
        });
    }
  }
);


app.post(
  "/api/business-directory/staff/claim-requests/:claimId/approve",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: "SUPABASE_NOT_CONFIGURED",
        });
      }

      const staff =
        await requireBusinessDirectoryStaffUser(req);

      const claimId =
        String(
          req.params?.claimId || ""
        ).trim();

      if (!claimId) {
        return res.status(400).json({
          ok: false,
          error: "BUSINESS_CLAIM_ID_REQUIRED",
        });
      }

      const {
        data: claim,
        error: claimError,
      } =
        await supabase
          .from("business_listing_claims")
          .select(
            "id,station_id,requesting_auth_user_id,status"
          )
          .eq("id", claimId)
          .maybeSingle();

      if (claimError) {
        throw claimError;
      }

      if (!claim) {
        return res.status(404).json({
          ok: false,
          error: "BUSINESS_CLAIM_NOT_FOUND",
        });
      }

      const {
        data: result,
        error: rpcError,
      } =
        await supabase.rpc(
          "approve_business_listing_claim",
          {
            p_claim_id: claimId,
            p_staff_user_id:
              staff.user.id,
          }
        );

      if (rpcError) {
        throw rpcError;
      }

      if (!result?.ok) {
        return res.status(409).json(
          result || {
            ok: false,
            error:
              "BUSINESS_CLAIM_APPROVE_FAILED",
          }
        );
      }

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][BUSINESS_CLAIM][STAFF_APPROVE_FATAL]",
        error
      );

      return res
        .status(status)
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_CLAIM_STAFF_APPROVE_FATAL",
        });
    }
  }
);


app.post(
  "/api/business-directory/staff/claim-requests/:claimId/reject",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: "SUPABASE_NOT_CONFIGURED",
        });
      }

      const staff =
        await requireBusinessDirectoryStaffUser(req);

      const claimId =
        String(
          req.params?.claimId || ""
        ).trim();

      const staffNote =
        String(
          req.body?.note || ""
        )
          .trim()
          .slice(0, 2000) ||
        null;

      if (!claimId) {
        return res.status(400).json({
          ok: false,
          error: "BUSINESS_CLAIM_ID_REQUIRED",
        });
      }

      const {
        data: claim,
        error: claimError,
      } =
        await supabase
          .from("business_listing_claims")
          .select(
            "id,status"
          )
          .eq("id", claimId)
          .maybeSingle();

      if (claimError) {
        throw claimError;
      }

      if (!claim) {
        return res.status(404).json({
          ok: false,
          error: "BUSINESS_CLAIM_NOT_FOUND",
        });
      }

      if (
        ![
          "requested",
          "under_review",
          "approved",
        ].includes(
          String(claim.status || "")
        )
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "BUSINESS_CLAIM_NOT_REJECTABLE",
        });
      }

      const nowIso =
        new Date().toISOString();

      const {
        error: updateError,
      } =
        await supabase
          .from("business_listing_claims")
          .update({
            status: "rejected",
            staff_note: staffNote,
            decided_by_user_id:
              staff.user.id,
            decided_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", claimId);

      if (updateError) {
        throw updateError;
      }

      return res.json({
        ok: true,
        claimId,
        status: "rejected",
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode || 500
        );

      console.error(
        "[AUTODEAR][BUSINESS_CLAIM][STAFF_REJECT_FATAL]",
        error
      );

      return res
        .status(status)
        .json({
          ok: false,
          error:
            error?.message ||
            "BUSINESS_CLAIM_STAFF_REJECT_FATAL",
        });
    }
  }
);


/*
 * Validate a paper confirmation code.
 *
 * This stage intentionally DOES NOT assign owner_id yet.
 * The final transfer will be performed by one atomic
 * PostgreSQL RPC in the next foundation stage.
 */
app.post(
  "/api/business-directory/claim/validate-code",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const authResult =
        await resolveAuthenticatedUser(
          req
        );

      const user =
        authResult?.user || null;

      const userId =
        String(
          user?.id || ""
        ).trim();

      if (!userId) {
        return res.status(401).json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
      }

      const stationId =
        String(
          req.body?.stationId ||
          ""
        ).trim();

      const code =
        String(
          req.body?.code ||
          ""
        ).trim();

      if (
        !stationId ||
        !code
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_REQUIRED",
        });
      }

      const codeDigest =
        digestBusinessListingClaimCode(
          code
        );

      const {
        data: station,
        error: stationError,
      } = await supabase
        .from("stations")
        .select(
          "id,owner_id,ownership_status,created_source"
        )
        .eq(
          "id",
          stationId
        )
        .is(
          "owner_id",
          null
        )
        .eq(
          "created_source",
          "autodear_staff"
        )
        .eq(
          "ownership_status",
          "unclaimed"
        )
        .maybeSingle();

      if (stationError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_LOOKUP_FAILED",
        });
      }

      if (!station) {
        return res.status(409).json({
          ok: false,
          error:
            "BUSINESS_LISTING_NOT_CLAIMABLE",
        });
      }

      const {
        data: claimCode,
        error: codeError,
      } = await supabase
        .from(
          "business_listing_claim_codes"
        )
        .select(
          "id,station_id,status,expires_at"
        )
        .eq(
          "station_id",
          stationId
        )
        .eq(
          "code_digest",
          codeDigest
        )
        .eq(
          "status",
          "active"
        )
        .maybeSingle();

      if (codeError) {
        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_LOOKUP_FAILED",
        });
      }

      if (!claimCode) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_INVALID",
        });
      }

      if (
        claimCode.expires_at &&
        Date.parse(
          claimCode.expires_at
        ) <= Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_EXPIRED",
        });
      }

      return res.json({
        ok: true,
        valid: true,
        stationId,
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][CODE_VALIDATE_FATAL]",
        {
          status,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "BUSINESS_LISTING_CODE_VALIDATE_FATAL",
      });
    }
  }
);



/*
 * ============================================================
 * BUSINESS LISTING ATOMIC CODE CLAIM
 * ============================================================
 *
 * Backend authenticates the user and calculates HMAC.
 * PostgreSQL performs the ownership transfer atomically.
 */
app.post(
  "/api/business-directory/claim/by-code",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const authResult =
        await resolveAuthenticatedUser(
          req
        );

      const user =
        authResult?.user || null;

      const userId =
        String(
          user?.id || ""
        ).trim();

      if (!userId) {
        return res.status(401).json({
          ok: false,
          error:
            authResult?.error ||
            "AUTH_REQUIRED",
        });
      }

      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from("profiles")
        .select(
          "id,auth_user_id,role"
        )
        .or(
          `auth_user_id.eq.${userId},id.eq.${userId}`
        )
        .limit(1)
        .maybeSingle();

      if (profileError) {
        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][ATOMIC_CLAIM_PROFILE_ERROR]",
          {
            code:
              profileError.code ||
              null,
            message:
              profileError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_CLAIM_PROFILE_LOOKUP_FAILED",
        });
      }

      const role =
        String(
          profile?.role || ""
        )
          .trim()
          .toLowerCase();

      if (role !== "business") {
        return res.status(403).json({
          ok: false,
          error:
            "BUSINESS_PROFILE_REQUIRED",
        });
      }

      const stationId =
        String(
          req.body?.stationId ||
          ""
        ).trim();

      const code =
        String(
          req.body?.code ||
          ""
        ).trim();

      if (!stationId) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_ID_REQUIRED",
        });
      }

      if (!code) {
        return res.status(400).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CODE_REQUIRED",
        });
      }

      const codeDigest =
        digestBusinessListingClaimCode(
          code
        );

      const {
        data: result,
        error: rpcError,
      } = await supabase.rpc(
        "claim_business_listing_by_code",
        {
          p_station_id:
            stationId,

          p_owner_id:
            userId,

          p_claimed_by_user_id:
            userId,

          p_code_digest:
            codeDigest,
        }
      );

      if (rpcError) {
        console.error(
          "[AUTODEAR][BUSINESS_DIRECTORY][ATOMIC_CLAIM_RPC_ERROR]",
          {
            code:
              rpcError.code ||
              null,
            message:
              rpcError.message ||
              null,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "BUSINESS_LISTING_CLAIM_FAILED",
        });
      }

      if (
        !result ||
        result.ok !== true
      ) {
        const errorCode =
          String(
            result?.error ||
            "BUSINESS_LISTING_CLAIM_FAILED"
          );

        const conflictErrors =
          new Set([
            "BUSINESS_LISTING_NOT_CLAIMABLE",
            "BUSINESS_LISTING_ALREADY_CLAIMED",
          ]);

        const codeErrors =
          new Set([
            "BUSINESS_LISTING_CODE_INVALID",
            "BUSINESS_LISTING_CODE_EXPIRED",
          ]);

        const status =
          conflictErrors.has(
            errorCode
          )
            ? 409
            : codeErrors.has(
                errorCode
              )
              ? 400
              : 400;

        return res
          .status(status)
          .json({
            ok: false,
            error:
              errorCode,
          });
      }

      return res.json({
        ok: true,

        listing: {
          id:
            result.stationId ||
            stationId,

          ownerId:
            result.ownerId ||
            userId,

          ownershipStatus:
            result.ownershipStatus ||
            "claimed",

          claimedAt:
            result.claimedAt ||
            null,
        },
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][BUSINESS_DIRECTORY][ATOMIC_CLAIM_FATAL]",
        {
          status,
          message:
            error?.message ||
            String(error),
        }
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "BUSINESS_LISTING_CLAIM_FATAL",
      });
    }
  }
);


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


function getAdsStaffRole(user) {
  const protectedRole =
    String(
      user?.app_metadata?.role ||
      ""
    )
      .trim()
      .toLowerCase();

  const compatibilityRole =
    String(
      user?.user_metadata?.role ||
      ""
    )
      .trim()
      .toLowerCase();

  const role =
    protectedRole ||
    compatibilityRole;

  return [
    "admin",
    "director",
    "developer",
  ].includes(role)
    ? role
    : "";
}


async function getAdsAdvertiserActivation(
  ownerId
) {
  const normalizedOwnerId =
    String(ownerId || "").trim();

  if (!normalizedOwnerId) {
    return false;
  }

  if (!supabase) {
    throw new Error(
      "SUPABASE_NOT_CONFIGURED"
    );
  }

  const {
    data,
    error,
  } = await supabase
    .from("ads_wallet_transactions")
    .select("id")
    .eq(
      "owner_id",
      normalizedOwnerId
    )
    .eq(
      "type",
      "payment"
    )
    .eq(
      "status",
      "confirmed"
    )
    .gte(
      "amount_kopecks",
      50000
    )
    .limit(1);

  if (error) {
    console.error(
      "[AUTODEAR][ADS][ACTIVATION_CHECK_ERROR]",
      {
        ownerId:
          normalizedOwnerId,
        code:
          error.code,
        message:
          error.message,
      }
    );

    throw new Error(
      "ADS_ACTIVATION_CHECK_ERROR"
    );
  }

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}


async function requireAdsActivatedUser(
  req
) {
  const user =
    await requireAdsAuthUser(req);

  const staffRole =
    getAdsStaffRole(user);

  if (staffRole) {
    return {
      user,
      activated: true,
      staffRole,
    };
  }

  const activated =
    await getAdsAdvertiserActivation(
      user.id
    );

  if (!activated) {
    const error =
      new Error(
        "ADS_ADVERTISER_NOT_ACTIVATED"
      );

    error.statusCode = 403;

    throw error;
  }

  return {
    user,
    activated: true,
    staffRole: "",
  };
}

async function requireAdsStaffUser(req) {
  const user =
    await requireAdsAuthUser(req);

  const role =
    getAdsStaffRole(user);

  if (!role) {
    const error =
      new Error(
        "ADS_STAFF_ACCESS_REQUIRED"
      );

    error.statusCode = 403;
    throw error;
  }

  return {
    user,
    role,
  };
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

    creative:
      row.creative &&
      typeof row.creative === "object"
        ? row.creative
        : {},

    settings:
      row.settings &&
      typeof row.settings === "object"
        ? row.settings
        : {},

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
// UPLOAD ADS CREATIVE IMAGE
// ------------------------------------------------------------

app.post(
  "/api/ads/campaigns/:campaignId/creative-image",
  adsCreativeUpload.single("file"),
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: "SUPABASE_NOT_CONFIGURED",
        });
      }

      const user =
        await requireAdsAuthUser(req);

      const ownerId =
        String(user.id);

      const campaignId =
        String(
          req.params?.campaignId || ""
        ).trim();

      if (!campaignId) {
        return res.status(400).json({
          ok: false,
          error: "ADS_CAMPAIGN_ID_REQUIRED",
        });
      }

      const {
        data: campaign,
        error: campaignError,
      } = await supabase
        .from("ads_campaigns")
        .select("id,owner_id,status")
        .eq("id", campaignId)
        .eq("owner_id", ownerId)
        .maybeSingle();

      if (campaignError) {
        console.error(
          "[AUTODEAR][ADS][CREATIVE_CAMPAIGN_LOAD_ERROR]",
          campaignError
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_CREATIVE_CAMPAIGN_LOAD_ERROR",
        });
      }

      if (!campaign) {
        return res.status(404).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_NOT_FOUND",
        });
      }

      const file =
        req.file;

      if (!file?.buffer?.length) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CREATIVE_FILE_REQUIRED",
        });
      }

      const mimeType =
        String(
          file.mimetype || ""
        ).toLowerCase();

      const extensionByMime = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };

      const extension =
        extensionByMime[mimeType];

      if (!extension) {
        return res.status(415).json({
          ok: false,
          error:
            "ADS_CREATIVE_IMAGE_TYPE_UNSUPPORTED",
        });
      }

      const bucket =
        "ads-creatives";

      /*
       * Bucket создаётся один раз.
       * Дальше этот блок просто увидит,
       * что он уже существует.
       */
      const {
        data: buckets,
        error: bucketListError,
      } =
        await supabase.storage
          .listBuckets();

      if (bucketListError) {
        throw new Error(
          `ADS_CREATIVE_BUCKET_LIST_ERROR:${bucketListError.message}`
        );
      }

      const bucketExists =
        (buckets || []).some(
          (item) =>
            item.name === bucket
        );

      if (!bucketExists) {
        const {
          error: createBucketError,
        } =
          await supabase.storage
            .createBucket(
              bucket,
              {
                public: true,
                fileSizeLimit:
                  8 * 1024 * 1024,
                allowedMimeTypes: [
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                ],
              }
            );

        if (createBucketError) {
          throw new Error(
            `ADS_CREATIVE_BUCKET_CREATE_ERROR:${createBucketError.message}`
          );
        }
      }

      const storagePath =
        `${ownerId}/${campaignId}/creative-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}.${extension}`;

      const {
        error: uploadError,
      } =
        await supabase.storage
          .from(bucket)
          .upload(
            storagePath,
            file.buffer,
            {
              contentType:
                mimeType,
              cacheControl:
                "3600",
              upsert: false,
            }
          );

      if (uploadError) {
        throw new Error(
          `ADS_CREATIVE_UPLOAD_ERROR:${uploadError.message}`
        );
      }

      const {
        data: publicData,
      } =
        supabase.storage
          .from(bucket)
          .getPublicUrl(
            storagePath
          );

      const imageUrl =
        String(
          publicData?.publicUrl ||
          ""
        ).trim();

      if (!imageUrl) {
        throw new Error(
          "ADS_CREATIVE_PUBLIC_URL_MISSING"
        );
      }

      console.log(
        "[AUTODEAR][ADS][CREATIVE_UPLOADED]",
        {
          ownerId,
          campaignId,
          bucket,
          storagePath,
          bytes:
            file.buffer.length,
          mimeType,
        }
      );

      return res.json({
        ok: true,
        imageUrl,
        bucket,
        storagePath,
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][ADS][CREATIVE_UPLOAD_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_CREATIVE_UPLOAD_FATAL",
      });
    }
  }
);


// ------------------------------------------------------------
// ADS STAFF MODERATION
// ------------------------------------------------------------

app.get(
  "/api/ads/moderation/campaigns",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const {
        user,
        role,
      } =
        await requireAdsStaffUser(req);

      const {
        data: rows,
        error,
      } = await supabase
        .from("ads_campaigns")
        .select("*")
        .eq(
          "status",
          "moderation"
        )
        .order(
          "updated_at",
          {
            ascending: true,
          }
        );

      if (error) {
        console.error(
          "[AUTODEAR][ADS][MODERATION_LIST_ERROR]",
          {
            moderatorId:
              user.id,
            role,
            code:
              error.code,
            message:
              error.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_MODERATION_LIST_ERROR",
        });
      }

      const campaignIds =
        (rows || []).map(
          (row) => row.id
        );

      /*
       * Staff moderation deliberately loads
       * placements without owner filtering,
       * because the queue contains campaigns
       * belonging to many advertisers.
       */
      const {
        data: placementRows,
        error:
          placementLoadError,
      } = campaignIds.length
        ? await supabase
            .from(
              "ads_placements"
            )
            .select("*")
            .in(
              "campaign_id",
              campaignIds
            )
            .order(
              "created_at",
              {
                ascending: true,
              }
            )
        : {
            data: [],
            error: null,
          };

      if (placementLoadError) {
        console.error(
          "[AUTODEAR][ADS][MODERATION_PLACEMENTS_LOAD_ERROR]",
          {
            moderatorId:
              user.id,
            role,
            code:
              placementLoadError.code,
            message:
              placementLoadError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_MODERATION_PLACEMENTS_LOAD_ERROR",
        });
      }

      const byCampaign =
        new Map();

      for (
        const row
        of placementRows || []
      ) {
        const campaignId =
          String(
            row.campaign_id || ""
          );

        const current =
          byCampaign.get(
            campaignId
          ) || [];

        current.push(row);

        byCampaign.set(
          campaignId,
          current
        );
      }

      const campaigns =
        (rows || []).map(
          (row) =>
            mapAdsCampaignRow(
              row,
              byCampaign.get(
                row.id
              ) || []
            )
        );

      return res.json({
        ok: true,
        moderator: {
          id:
            String(user.id),
          role,
        },
        campaigns,
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][ADS][MODERATION_LIST_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_MODERATION_LIST_FATAL",
      });
    }
  }
);


app.get(
  "/api/ads/moderation/campaigns/:campaignId",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const {
        user,
        role,
      } =
        await requireAdsStaffUser(req);

      const campaignId =
        String(
          req.params
            ?.campaignId ||
          ""
        ).trim();

      if (!campaignId) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_ID_REQUIRED",
        });
      }

      const {
        data: campaign,
        error,
      } = await supabase
        .from("ads_campaigns")
        .select("*")
        .eq(
          "id",
          campaignId
        )
        .maybeSingle();

      if (error) {
        return res.status(500).json({
          ok: false,
          error:
            "ADS_MODERATION_CAMPAIGN_LOAD_ERROR",
        });
      }

      if (!campaign) {
        return res.status(404).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_NOT_FOUND",
        });
      }

      const {
        data: placements,
        error:
          placementsError,
      } = await supabase
        .from("ads_placements")
        .select("*")
        .eq(
          "campaign_id",
          campaignId
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        );

      if (placementsError) {
        return res.status(500).json({
          ok: false,
          error:
            "ADS_MODERATION_PLACEMENTS_LOAD_ERROR",
        });
      }

      console.log(
        "[AUTODEAR][ADS][MODERATION_CAMPAIGN_OPENED]",
        {
          moderatorId:
            user.id,
          role,
          campaignId,
        }
      );

      return res.json({
        ok: true,
        campaign:
          mapAdsCampaignRow(
            campaign,
            placements || []
          ),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_MODERATION_CAMPAIGN_FATAL",
      });
    }
  }
);


async function applyAdsModerationDecision({
  campaignId,
  moderatorId,
  moderatorRole,
  decision,
  comment,
}) {
  const allowed =
    new Set([
      "approve",
      "changes",
      "reject",
    ]);

  if (!allowed.has(decision)) {
    const error =
      new Error(
        "ADS_MODERATION_DECISION_INVALID"
      );

    error.statusCode = 400;
    throw error;
  }

  const {
    data: campaign,
    error: loadError,
  } = await supabase
    .from("ads_campaigns")
    .select("*")
    .eq(
      "id",
      campaignId
    )
    .maybeSingle();

  if (loadError) {
    throw new Error(
      `ADS_MODERATION_CAMPAIGN_LOAD_ERROR:${loadError.message}`
    );
  }

  if (!campaign) {
    const error =
      new Error(
        "ADS_CAMPAIGN_NOT_FOUND"
      );

    error.statusCode = 404;
    throw error;
  }

  if (
    String(
      campaign.status || ""
    ) !== "moderation"
  ) {
    const error =
      new Error(
        "ADS_CAMPAIGN_NOT_IN_MODERATION"
      );

    error.statusCode = 409;
    throw error;
  }

  const cleanComment =
    String(
      comment || ""
    ).trim();

  if (
    (
      decision === "changes" ||
      decision === "reject"
    ) &&
    !cleanComment
  ) {
    const error =
      new Error(
        "ADS_MODERATION_COMMENT_REQUIRED"
      );

    error.statusCode = 400;
    throw error;
  }

  /*
   * Existing campaign status model:
   * approve -> active
   * changes -> draft
   * reject  -> rejected
   *
   * Placement statuses follow the same
   * operational state.
   */
  const campaignStatus =
    decision === "approve"
      ? "active"
      : decision === "changes"
        ? "draft"
        : "rejected";

  const placementStatus =
    decision === "approve"
      ? "active"
      : decision === "changes"
        ? "draft"
        : "rejected";

  const {
    error: placementError,
  } = await supabase
    .from("ads_placements")
    .update({
      status:
        placementStatus,
    })
    .eq(
      "campaign_id",
      campaignId
    );

  if (placementError) {
    throw new Error(
      `ADS_MODERATION_PLACEMENT_UPDATE_ERROR:${placementError.message}`
    );
  }

  const {
    data: updatedCampaign,
    error: campaignError,
  } = await supabase
    .from("ads_campaigns")
    .update({
      status:
        campaignStatus,
    })
    .eq(
      "id",
      campaignId
    )
    .select("*")
    .maybeSingle();

  if (campaignError) {
    throw new Error(
      `ADS_MODERATION_CAMPAIGN_UPDATE_ERROR:${campaignError.message}`
    );
  }

  console.log(
    "[AUTODEAR][ADS][MODERATION_DECISION]",
    {
      moderatorId,
      moderatorRole,
      campaignId,
      decision,
      comment:
        cleanComment,
      campaignStatus,
    }
  );

  return updatedCampaign;
}


app.post(
  "/api/ads/moderation/campaigns/:campaignId/decision",
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error:
            "SUPABASE_NOT_CONFIGURED",
        });
      }

      const {
        user,
        role,
      } =
        await requireAdsStaffUser(req);

      const campaignId =
        String(
          req.params
            ?.campaignId ||
          ""
        ).trim();

      const decision =
        String(
          req.body?.decision ||
          ""
        )
          .trim()
          .toLowerCase();

      const comment =
        String(
          req.body?.comment ||
          ""
        ).trim();

      if (!campaignId) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_ID_REQUIRED",
        });
      }

      const updatedCampaign =
        await applyAdsModerationDecision({
          campaignId,
          moderatorId:
            String(user.id),
          moderatorRole:
            role,
          decision,
          comment,
        });

      const {
        data: placements,
        error:
          placementsError,
      } = await supabase
        .from("ads_placements")
        .select("*")
        .eq(
          "campaign_id",
          campaignId
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        );

      if (placementsError) {
        throw new Error(
          `ADS_MODERATION_PLACEMENTS_LOAD_ERROR:${placementsError.message}`
        );
      }

      return res.json({
        ok: true,
        decision,
        comment,
        campaign:
          mapAdsCampaignRow(
            updatedCampaign,
            placements || []
          ),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode ||
          500
        );

      console.error(
        "[AUTODEAR][ADS][MODERATION_DECISION_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_MODERATION_DECISION_FATAL",
      });
    }
  }
);


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

        const {
          user,
        } =
          await requireAdsActivatedUser(
            req
          );

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
// SUBMIT CAMPAIGN TO MODERATION
// ------------------------------------------------------------

app.post(
  "/api/ads/campaigns/:campaignId/submit",
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

      const {
        data: campaign,
        error: campaignLoadError,
      } = await supabase
        .from("ads_campaigns")
        .select("*")
        .eq("id", campaignId)
        .eq("owner_id", ownerId)
        .maybeSingle();

      if (campaignLoadError) {
        console.error(
          "[AUTODEAR][ADS][SUBMIT_CAMPAIGN_LOAD_ERROR]",
          {
            ownerId,
            campaignId,
            code:
              campaignLoadError.code,
            message:
              campaignLoadError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_LOAD_ERROR",
        });
      }

      if (!campaign) {
        return res.status(404).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_NOT_FOUND",
        });
      }

      const allowedSourceStatuses =
        new Set([
          "draft",
          "rejected",
          "moderation",
        ]);

      if (
        !allowedSourceStatuses.has(
          String(
            campaign.status ||
            ""
          )
        )
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_NOT_EDITABLE",
        });
      }

      const title =
        String(
          req.body?.title || ""
        ).trim();

      const description =
        String(
          req.body?.description ||
          ""
        ).trim();

      const ctaText =
        String(
          req.body?.ctaText ||
          "Подробнее"
        ).trim();

      const destinationUrl =
        String(
          req.body?.destinationUrl ||
          ""
        ).trim();

      const imageUri =
        String(
          req.body?.imageUri || ""
        ).trim() || null;

      const advertisedObjectType =
        String(
          req.body
            ?.advertisedObjectType ||
          ""
        ).trim();

      const advertisedObjectName =
        String(
          req.body
            ?.advertisedObjectName ||
          ""
        ).trim();

      const selectedPlacements =
        normalizeAdsStringArray(
          req.body?.placements
        );

      const allowedPlacementKeys =
        new Set([
          "feed",
          "search",
          "listings",
        ]);

      const placementKeys =
        selectedPlacements.filter(
          (item) =>
            allowedPlacementKeys.has(
              item
            )
        );

      const cityIds =
        normalizeAdsStringArray(
          req.body?.cityIds
        );

      const dailyBudgetKopecks =
        normalizeAdsInteger(
          req.body
            ?.dailyBudgetKopecks
        );

      const totalBudgetKopecks =
        normalizeAdsInteger(
          req.body
            ?.totalBudgetKopecks
        );

      const durationDays =
        Math.max(
          1,
          Math.min(
            365,
            normalizeAdsInteger(
              req.body?.durationDays
            )
          )
        );

      if (!title) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_TITLE_REQUIRED",
        });
      }

      if (!destinationUrl) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_DESTINATION_URL_REQUIRED",
        });
      }

      let parsedUrl = null;

      try {
        parsedUrl =
          new URL(
            destinationUrl
          );
      } catch {
        parsedUrl = null;
      }

      if (
        !parsedUrl ||
        ![
          "http:",
          "https:",
        ].includes(
          parsedUrl.protocol
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_DESTINATION_URL_INVALID",
        });
      }

      if (
        placementKeys.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_PLACEMENTS_REQUIRED",
        });
      }

      if (cityIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_CITIES_REQUIRED",
        });
      }

      if (
        dailyBudgetKopecks <
        10000
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_DAILY_BUDGET_TOO_LOW",
        });
      }

      if (
        totalBudgetKopecks <
        dailyBudgetKopecks
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ADS_TOTAL_BUDGET_INVALID",
        });
      }

      const startsAt =
        new Date();

      const endsAt =
        new Date(
          startsAt.getTime() +
          durationDays *
            24 *
            60 *
            60 *
            1000
        );

      const weights = {
        feed: 55,
        search: 25,
        listings: 20,
      };

      const totalWeight =
        placementKeys.reduce(
          (sum, key) =>
            sum +
            Number(
              weights[key] || 0
            ),
          0
        ) || 1;

      const placementLabels = {
        feed: "Главная",
        search: "Поиск",
        listings: "Объявления",
      };

      /*
       * Формат креатива должен соответствовать
       * реальному UI-слоту мобильного приложения.
       *
       * feed      -> главный Hero AUTODEAR
       * search    -> большая карточка в поиске
       * listings  -> нативная карточка объявлений
       */
      const placementFormats = {
        feed: "hero_image",
        search: "large_card",
        listings: "feed_native",
      };

      const creative = {
        advertisedObjectType,
        advertisedObjectName,
        title,
        description,
        ctaText,
        destinationUrl,
      };

      /*
       * Сначала удаляем старый набор размещений.
       * Кампания всё это время остаётся draft /
       * rejected / moderation и НЕ становится
       * moderation из-за этой операции.
       */
      const {
        error: deletePlacementsError,
      } = await supabase
        .from("ads_placements")
        .delete()
        .eq(
          "campaign_id",
          campaignId
        )
        .eq(
          "owner_id",
          ownerId
        );

      if (deletePlacementsError) {
        console.error(
          "[AUTODEAR][ADS][SUBMIT_PLACEMENTS_DELETE_ERROR]",
          {
            ownerId,
            campaignId,
            code:
              deletePlacementsError.code,
            message:
              deletePlacementsError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_PLACEMENTS_DELETE_ERROR",
        });
      }

      const placementRows =
        placementKeys.map(
          (placementKey) => {
            const share =
              Number(
                weights[
                  placementKey
                ] || 0
              ) / totalWeight;

            return {
              id:
                `ads_placement_${campaignId}_${placementKey}`,

              campaign_id:
                campaignId,

              owner_id:
                ownerId,

              /*
               * placementKey описывает поверхность,
               * format — реальный рекламный формат,
               * который понимает мобильный Ads Engine.
               */
              format:
                placementFormats[
                  placementKey
                ] ||
                "feed_native",

              title:
                `${title} · ${
                  placementLabels[
                    placementKey
                  ] ||
                  placementKey
                }`,

              status:
                "draft",

              billing_model:
                "cpc",

              price_per_click_kopecks:
                0,

              price_per_thousand_impressions_kopecks:
                0,

              price_per_view_kopecks:
                null,

              billable_video_event:
                null,

              budget_limit_kopecks:
                Math.round(
                  totalBudgetKopecks *
                    share
                ),

              daily_limit_kopecks:
                Math.round(
                  dailyBudgetKopecks *
                    share
                ),

              destination_url:
                destinationUrl,

              cta_text:
                ctaText,

              image_uri:
                imageUri,

              video_uri:
                null,

              creative,

              settings: {
                placementKey,

                placementLabel:
                  placementLabels[
                    placementKey
                  ] ||
                  placementKey,

                adFormat:
                  placementFormats[
                    placementKey
                  ] ||
                  "feed_native",

                masterAspectRatio:
                  "16:9",

                weight:
                  weights[
                    placementKey
                  ] || 0,
              },
            };
          }
        );

      const {
        error: insertPlacementsError,
      } = await supabase
        .from("ads_placements")
        .insert(
          placementRows
        );

      if (insertPlacementsError) {
        console.error(
          "[AUTODEAR][ADS][SUBMIT_PLACEMENTS_INSERT_ERROR]",
          {
            ownerId,
            campaignId,
            code:
              insertPlacementsError.code,
            message:
              insertPlacementsError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_PLACEMENTS_INSERT_ERROR",
        });
      }

      /*
       * Подготовленные placements переводим
       * на модерацию до самой кампании.
       * Если следующий UPDATE кампании упадёт,
       * кампания не будет ложно отмечена
       * как отправленная.
       */
      const {
        error:
          placementModerationError,
      } = await supabase
        .from("ads_placements")
        .update({
          status:
            "moderation",
        })
        .eq(
          "campaign_id",
          campaignId
        )
        .eq(
          "owner_id",
          ownerId
        );

      if (placementModerationError) {
        console.error(
          "[AUTODEAR][ADS][SUBMIT_PLACEMENT_STATUS_ERROR]",
          {
            ownerId,
            campaignId,
            code:
              placementModerationError.code,
            message:
              placementModerationError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_PLACEMENT_STATUS_ERROR",
        });
      }

      /*
       * КАМПАНИЯ ПЕРЕХОДИТ В MODERATION
       * ТОЛЬКО ПОСЛЕДНИМ ШАГОМ.
       */
      const {
        data: updatedCampaign,
        error: updateCampaignError,
      } = await supabase
        .from("ads_campaigns")
        .update({
          total_budget_kopecks:
            totalBudgetKopecks,

          daily_budget_kopecks:
            dailyBudgetKopecks,

          starts_at:
            startsAt.toISOString(),

          ends_at:
            endsAt.toISOString(),

          city_ids:
            cityIds,

          status:
            "moderation",
        })
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

      if (updateCampaignError) {
        console.error(
          "[AUTODEAR][ADS][SUBMIT_CAMPAIGN_UPDATE_ERROR]",
          {
            ownerId,
            campaignId,
            code:
              updateCampaignError.code,
            message:
              updateCampaignError.message,
          }
        );

        return res.status(500).json({
          ok: false,
          error:
            "ADS_CAMPAIGN_SUBMIT_UPDATE_ERROR",
        });
      }

      if (!updatedCampaign) {
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

      console.log(
        "[AUTODEAR][ADS][CAMPAIGN_SUBMITTED]",
        {
          ownerId,
          campaignId,
          placements:
            placementKeys,
          cityIds,
          dailyBudgetKopecks,
          totalBudgetKopecks,
        }
      );

      return res.json({
        ok: true,
        campaign:
          mapAdsCampaignRow(
            updatedCampaign,
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
        "[AUTODEAR][ADS][CAMPAIGN_SUBMIT_FATAL]",
        error
      );

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "ADS_CAMPAIGN_SUBMIT_FATAL",
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



/*
 * AUTODEAR business tomorrow reminder.
 *
 * Один вечерний push владельцу станции:
 * - источник записей: business_bookings;
 * - неподтверждённые business_requests не входят;
 * - время отправки: через 1 час после закрытия;
 * - если сегодня выходной / 24x7 / график неизвестен:
 *   используем 19:00;
 * - дата и время считаются в timezone станции;
 * - если timezone не заполнен, временный fallback:
 *   Europe/Moscow;
 * - notifications используется как постоянный журнал,
 *   чтобы после рестарта сервера не отправить push повторно.
 */

const AUTODEAR_BUSINESS_REMINDER_TYPE =
  "business_tomorrow_schedule";

const AUTODEAR_BUSINESS_REMINDER_FALLBACK_TIMEZONE =
  "Europe/Moscow";

const AUTODEAR_BUSINESS_REMINDER_FALLBACK_MINUTE =
  19 * 60;

let autodearBusinessReminderSweepRunning =
  false;

function autodearSafeTimezone(value) {
  const requested =
    String(value || "").trim();

  if (!requested) {
    return AUTODEAR_BUSINESS_REMINDER_FALLBACK_TIMEZONE;
  }

  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          requested,
      }
    ).format(
      new Date()
    );

    return requested;
  } catch {
    console.warn(
      "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][INVALID_TIMEZONE]",
      {
        timezone:
          requested,
        fallback:
          AUTODEAR_BUSINESS_REMINDER_FALLBACK_TIMEZONE,
      }
    );

    return AUTODEAR_BUSINESS_REMINDER_FALLBACK_TIMEZONE;
  }
}

function autodearZonedParts(
  value,
  timezone
) {
  const date =
    value instanceof Date
      ? value
      : new Date(value);

  const safeTimezone =
    autodearSafeTimezone(
      timezone
    );

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          safeTimezone,
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit",
        hour:
          "2-digit",
        minute:
          "2-digit",
        hourCycle:
          "h23",
      }
    );

  const parts =
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(
          (part) =>
            part.type !==
            "literal"
        )
        .map(
          (part) => [
            part.type,
            part.value,
          ]
        )
    );

  return {
    timezone:
      safeTimezone,

    date:
      `${parts.year}-${parts.month}-${parts.day}`,

    hour:
      Number(
        parts.hour
      ),

    minute:
      Number(
        parts.minute
      ),
  };
}

function autodearAddDaysToDateKey(
  dateKey,
  amount
) {
  const match =
    String(
      dateKey || ""
    ).match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    return "";
  }

  const value =
    new Date(
      Date.UTC(
        Number(
          match[1]
        ),
        Number(
          match[2]
        ) - 1,
        Number(
          match[3]
        )
      )
    );

  value.setUTCDate(
    value.getUTCDate() +
      Number(
        amount || 0
      )
  );

  const year =
    value.getUTCFullYear();

  const month =
    String(
      value.getUTCMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      value.getUTCDate()
    ).padStart(
      2,
      "0"
    );

  return `${year}-${month}-${day}`;
}

function autodearWeekdayIdFromDateKey(
  dateKey
) {
  const match =
    String(
      dateKey || ""
    ).match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    return "";
  }

  const value =
    new Date(
      Date.UTC(
        Number(
          match[1]
        ),
        Number(
          match[2]
        ) - 1,
        Number(
          match[3]
        ),
        12
      )
    );

  return [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
  ][
    value.getUTCDay()
  ];
}

function autodearParseClockMinutes(
  value
) {
  const match =
    String(
      value || ""
    )
      .trim()
      .match(
        /^(\d{1,2}):(\d{2})/
      );

  if (!match) {
    return null;
  }

  const hour =
    Number(
      match[1]
    );

  const minute =
    Number(
      match[2]
    );

  if (
    !Number.isInteger(
      hour
    ) ||
    !Number.isInteger(
      minute
    ) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return (
    hour * 60 +
    minute
  );
}

function autodearBusinessReminderMinute(
  station,
  todayKey
) {
  if (
    station?.works_24_7 ===
    true
  ) {
    return AUTODEAR_BUSINESS_REMINDER_FALLBACK_MINUTE;
  }

  const schedule =
    Array.isArray(
      station?.work_schedule
    )
      ? station.work_schedule
      : [];

  const weekdayId =
    autodearWeekdayIdFromDateKey(
      todayKey
    );

  const todaySchedule =
    schedule.find(
      (item) =>
        String(
          item?.id || ""
        )
          .trim()
          .toLowerCase() ===
        weekdayId
    );

  if (
    !todaySchedule ||
    todaySchedule.enabled ===
      false
  ) {
    return AUTODEAR_BUSINESS_REMINDER_FALLBACK_MINUTE;
  }

  const closeMinutes =
    autodearParseClockMinutes(
      todaySchedule.close
    );

  if (
    closeMinutes ==
    null
  ) {
    return AUTODEAR_BUSINESS_REMINDER_FALLBACK_MINUTE;
  }

  const reminderMinutes =
    closeMinutes + 60;

  if (
    reminderMinutes >=
    24 * 60
  ) {
    return 23 * 60 + 59;
  }

  return reminderMinutes;
}

function autodearBookingTime(value) {
  const raw =
    String(
      value || ""
    ).trim();

  if (!raw) {
    return "";
  }

  const match =
    raw.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return raw;
  }

  return `${String(
    match[1]
  ).padStart(
    2,
    "0"
  )}:${match[2]}`;
}

async function sendAutodearExpoPush({
  tokens,
  title,
  body,
  data,
}) {
  const cleanTokens =
    Array.from(
      new Set(
        (
          Array.isArray(
            tokens
          )
            ? tokens
            : []
        )
          .map(
            (item) =>
              String(
                item || ""
              ).trim()
          )
          .filter(
            Boolean
          )
      )
    );

  if (
    !cleanTokens.length
  ) {
    return {
      ok:
        true,
      sent:
        0,
      reason:
        "NO_PUSH_TOKENS",
    };
  }

  const messages =
    cleanTokens.map(
      (to) => ({
        to,
        sound:
          "default",
        title,
        body,
        data:
          data || {},
      })
    );

  const response =
    await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method:
          "POST",

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(
            messages
          ),
      }
    );

  const responseText =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `EXPO_PUSH_FAILED_${response.status}: ${responseText}`
    );
  }

  let payload =
    null;

  try {
    payload =
      JSON.parse(
        responseText
      );
  } catch {
    payload = {
      raw:
        responseText,
    };
  }

  return {
    ok:
      true,
    sent:
      cleanTokens.length,
    payload,
  };
}

async function buildBusinessTomorrowReminder(
  stationId
) {
  if (!supabase) {
    throw new Error(
      "SUPABASE_NOT_CONFIGURED"
    );
  }

  const targetStationId =
    String(
      stationId || ""
    ).trim();

  if (!targetStationId) {
    throw new Error(
      "STATION_ID_REQUIRED"
    );
  }

  const {
    data:
      station,
    error:
      stationError,
  } =
    await supabase
      .from(
        "stations"
      )
      .select(
        [
          "id",
          "owner_id",
          "name",
          "legal_name",
          "timezone",
          "work_schedule",
          "works_24_7",
        ].join(",")
      )
      .eq(
        "id",
        targetStationId
      )
      .maybeSingle();

  if (
    stationError
  ) {
    throw stationError;
  }

  if (!station) {
    throw new Error(
      "STATION_NOT_FOUND"
    );
  }

  const timezone =
    autodearSafeTimezone(
      station.timezone
    );

  const localNow =
    autodearZonedParts(
      new Date(),
      timezone
    );

  const tomorrow =
    autodearAddDaysToDateKey(
      localNow.date,
      1
    );

  const {
    data:
      bookingRows,
    error:
      bookingsError,
  } =
    await supabase
      .from(
        "business_bookings"
      )
      .select("*")
      .eq(
        "business_id",
        targetStationId
      )
      .eq(
        "booking_date",
        tomorrow
      );

  if (
    bookingsError
  ) {
    throw bookingsError;
  }

  const bookings =
    (
      Array.isArray(
        bookingRows
      )
        ? bookingRows
        : []
    )
      .filter(
        (item) => {
          const status =
            String(
              item?.status ||
                ""
            )
              .trim()
              .toLowerCase();

          return (
            status !==
              "cancelled" &&
            status !==
              "rejected"
          );
        }
      )
      .sort(
        (a, b) =>
          autodearBookingTime(
            a?.start_time
          ).localeCompare(
            autodearBookingTime(
              b?.start_time
            )
          )
      );

  const baseResult = {
    ok:
      true,

    stationId:
      targetStationId,

    ownerId:
      String(
        station.owner_id ||
          ""
      ).trim(),

    stationName:
      station.name ||
      station.legal_name ||
      "Бизнес AUTODEAR",

    timezone,

    localDate:
      localNow.date,

    localTime:
      `${String(
        localNow.hour
      ).padStart(
        2,
        "0"
      )}:${String(
        localNow.minute
      ).padStart(
        2,
        "0"
      )}`,

    workSchedule:
      station.work_schedule ||
      null,

    works24x7:
      station.works_24_7 ===
      true,

    tomorrow,
  };

  if (
    !bookings.length
  ) {
    return {
      ...baseResult,

      hasBookings:
        false,

      count:
        0,

      bookings:
        [],
    };
  }

  const first =
    bookings[0];

  const firstTime =
    autodearBookingTime(
      first?.start_time
    );

  const customerName =
    String(
      first?.customer_name ||
        ""
    ).trim();

  const car =
    String(
      first?.car || ""
    ).trim();

  const service =
    String(
      first?.service || ""
    ).trim();

  let title =
    "";

  let body =
    "";

  const sourceLabel =
    String(
      first?.source || ""
    )
      .trim()
      .toLowerCase() ===
    "manual"
      ? "своя запись"
      : "запись клиента";

  if (
    bookings.length ===
    1
  ) {
    const personAndCar =
      [
        customerName,
        car,
      ]
        .filter(
          Boolean
        )
        .join(
          ", "
        );

    title =
      firstTime
        ? `Завтра в ${firstTime}${
            personAndCar
              ? ` — ${personAndCar}`
              : ""
          }`
        : `Завтра запись${
            personAndCar
              ? ` — ${personAndCar}`
              : ""
          }`;

    const details =
      [
        service,
        sourceLabel,
      ].filter(
        Boolean
      );

    body =
      details.length
        ? details.join(
            " · "
          )
        : "Откройте расписание, чтобы посмотреть детали.";
  } else {
    const count =
      bookings.length;

    const mod10 =
      count % 10;

    const mod100 =
      count % 100;

    const bookingWord =
      mod10 === 1 &&
      mod100 !== 11
        ? "запись"
        : mod10 >= 2 &&
          mod10 <= 4 &&
          !(
            mod100 >= 12 &&
            mod100 <= 14
          )
        ? "записи"
        : "записей";

    title =
      `Завтра ${count} ${bookingWord}`;

    const personAndCar =
      [
        customerName,
        car,
      ]
        .filter(
          Boolean
        )
        .join(
          ", "
        );

    body =
      firstTime
        ? `Первая в ${firstTime}${
            personAndCar
              ? ` — ${personAndCar}`
              : ""
          }`
        : `Первая запись${
            personAndCar
              ? ` — ${personAndCar}`
              : ""
          }`;
  }

  return {
    ...baseResult,

    hasBookings:
      true,

    count:
      bookings.length,

    title,
    body,

    firstBookingId:
      first?.id ||
      null,

    bookings,
  };
}

async function autodearBusinessReminderAlreadySent({
  stationId,
  timezone,
  localDate,
}) {
  const {
    data:
      rows,
    error,
  } =
    await supabase
      .from(
        "notifications"
      )
      .select(
        "id,created_at"
      )
      .eq(
        "recipient_role",
        "business"
      )
      .eq(
        "recipient_id",
        stationId
      )
      .eq(
        "type",
        AUTODEAR_BUSINESS_REMINDER_TYPE
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        }
      )
      .limit(
        10
      );

  if (error) {
    throw error;
  }

  return (
    Array.isArray(
      rows
    )
      ? rows
      : []
  ).some(
    (row) => {
      if (
        !row?.created_at
      ) {
        return false;
      }

      return (
        autodearZonedParts(
          row.created_at,
          timezone
        ).date ===
        localDate
      );
    }
  );
}

async function autodearProcessBusinessTomorrowReminder(
  stationId
) {
  const reminder =
    await buildBusinessTomorrowReminder(
      stationId
    );

  if (
    !reminder.hasBookings
  ) {
    return {
      ok:
        true,
      skipped:
        true,
      reason:
        "NO_TOMORROW_BOOKINGS",
      stationId:
        reminder.stationId,
    };
  }

  if (
    !reminder.ownerId
  ) {
    return {
      ok:
        true,
      skipped:
        true,
      reason:
        "NO_OWNER",
      stationId:
        reminder.stationId,
    };
  }

  const now =
    autodearZonedParts(
      new Date(),
      reminder.timezone
    );

  const currentMinute =
    now.hour * 60 +
    now.minute;

  const {
    data:
      stationRow,
    error:
      stationError,
  } =
    await supabase
      .from(
        "stations"
      )
      .select(
        "id,work_schedule,works_24_7"
      )
      .eq(
        "id",
        reminder.stationId
      )
      .maybeSingle();

  if (
    stationError
  ) {
    throw stationError;
  }

  const dueMinute =
    autodearBusinessReminderMinute(
      stationRow || {},
      now.date
    );

  if (
    currentMinute <
    dueMinute
  ) {
    return {
      ok:
        true,
      skipped:
        true,
      reason:
        "NOT_DUE_YET",
      stationId:
        reminder.stationId,
      localTime:
        reminder.localTime,
      dueMinute,
    };
  }

  const alreadySent =
    await autodearBusinessReminderAlreadySent({
      stationId:
        reminder.stationId,

      timezone:
        reminder.timezone,

      localDate:
        now.date,
    });

  if (
    alreadySent
  ) {
    return {
      ok:
        true,
      skipped:
        true,
      reason:
        "ALREADY_SENT",
      stationId:
        reminder.stationId,
    };
  }

  const {
    data:
      tokenRows,
    error:
      tokensError,
  } =
    await supabase
      .from(
        "device_push_tokens"
      )
      .select(
        "expo_push_token"
      )
      .eq(
        "user_id",
        reminder.ownerId
      )
      .eq(
        "is_active",
        true
      );

  if (
    tokensError
  ) {
    throw tokensError;
  }

  const tokens =
    (
      Array.isArray(
        tokenRows
      )
        ? tokenRows
        : []
    )
      .map(
        (row) =>
          String(
            row?.expo_push_token ||
              ""
          ).trim()
      )
      .filter(
        Boolean
      );

  const pushResult =
    await sendAutodearExpoPush({
      tokens,

      title:
        reminder.title,

      body:
        reminder.body,

      data: {
        type:
          AUTODEAR_BUSINESS_REMINDER_TYPE,

        stationId:
          reminder.stationId,

        businessId:
          reminder.stationId,

        date:
          reminder.tomorrow,

        bookingId:
          reminder.firstBookingId ||
          null,
      },
    });

  if (
    !pushResult.sent
  ) {
    console.log(
      "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][NO_PUSH_TOKENS]",
      {
        stationId:
          reminder.stationId,

        ownerId:
          reminder.ownerId,
      }
    );

    return {
      ok:
        true,

      skipped:
        true,

      reason:
        "NO_PUSH_TOKENS",

      stationId:
        reminder.stationId,
    };
  }

  const {
    error:
      notificationError,
  } =
    await supabase
      .from(
        "notifications"
      )
      .insert({
        recipient_role:
          "business",

        recipient_id:
          reminder.stationId,

        title:
          reminder.title,

        body:
          reminder.body,

        type:
          AUTODEAR_BUSINESS_REMINDER_TYPE,

        is_read:
          false,

        created_at:
          new Date().toISOString(),
      });

  if (
    notificationError
  ) {
    throw notificationError;
  }

  console.log(
    "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][SENT]",
    {
      stationId:
        reminder.stationId,

      ownerId:
        reminder.ownerId,

      timezone:
        reminder.timezone,

      localDate:
        now.date,

      tomorrow:
        reminder.tomorrow,

      count:
        reminder.count,

      pushSent:
        pushResult.sent,
    }
  );

  return {
    ok:
      true,

    sent:
      true,

    stationId:
      reminder.stationId,

    push:
      pushResult,
  };
}

async function runAutodearBusinessTomorrowReminderSweep() {
  if (
    autodearBusinessReminderSweepRunning ||
    !supabase
  ) {
    return;
  }

  autodearBusinessReminderSweepRunning =
    true;

  try {
    const {
      data:
        stations,
      error:
        stationsError,
    } =
      await supabase
        .from(
          "stations"
        )
        .select(
          "id"
        );

    if (
      stationsError
    ) {
      throw stationsError;
    }

    for (
      const station of
      Array.isArray(
        stations
      )
        ? stations
        : []
    ) {
      const stationId =
        String(
          station?.id || ""
        ).trim();

      if (
        !stationId
      ) {
        continue;
      }

      try {
        await autodearProcessBusinessTomorrowReminder(
          stationId
        );
      } catch (error) {
        console.error(
          "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][STATION_ERROR]",
          {
            stationId,
            message:
              error?.message ||
              String(
                error
              ),
          }
        );
      }
    }
  } catch (error) {
    console.error(
      "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][SWEEP_ERROR]",
      error
    );
  } finally {
    autodearBusinessReminderSweepRunning =
      false;
  }
}


/*
 * AUTODEAR customer booking reminders.
 *
 * Источник истины:
 * business_bookings со status=confirmed.
 *
 * Напоминания:
 * - за 24 часа;
 * - за 1 час;
 * - за 15 минут.
 *
 * Дедупликация постоянная через notifications:
 * один booking + один eventType отправляются только один раз.
 */
const CUSTOMER_BOOKING_REMINDER_INTERVAL_MS =
  60 * 1000;

const CUSTOMER_BOOKING_REMINDER_WINDOWS = [
  {
    eventType: "booking_reminder_24h",
    minutesBefore: 24 * 60,
    toleranceMinutes: 2,
  },
  {
    eventType: "booking_reminder_1h",
    minutesBefore: 60,
    toleranceMinutes: 2,
  },
  {
    eventType: "booking_reminder_15m",
    minutesBefore: 15,
    toleranceMinutes: 2,
  },
];

let customerBookingReminderRunning = false;

function autodearBookingDateTimeUtc(
  dateKey,
  timeValue,
  timezone
) {
  const date = String(dateKey || "").trim();

  const time = autodearBookingTime(
    timeValue
  );

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}$/.test(time)
  ) {
    return null;
  }

  const [year, month, day] =
    date.split("-").map(Number);

  const [hour, minute] =
    time.split(":").map(Number);

  /*
   * Находим UTC instant, который соответствует
   * локальным дате/времени станции.
   *
   * Используем уже существующий
   * autodearZonedParts(), поэтому не вводим
   * стороннюю timezone-библиотеку.
   */
  let guess = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      0,
      0
    )
  );

  for (let index = 0; index < 3; index += 1) {
    const parts =
      autodearZonedParts(
        guess,
        timezone
      );

    const currentAsUtc =
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        0,
        0
      );

    const desiredAsUtc =
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        0,
        0
      );

    const delta =
      desiredAsUtc - currentAsUtc;

    if (Math.abs(delta) < 1000) {
      break;
    }

    guess =
      new Date(
        guess.getTime() + delta
      );
  }

  return guess;
}

function buildCustomerBookingReminderCopy(
  booking,
  station,
  eventType
) {
  const stationName =
    String(
      station?.name ||
        station?.legal_name ||
        "СТО AUTODEAR"
    ).trim();

  const stationAddress =
    String(
      station?.address_full ||
        station?.address ||
        ""
    ).trim();

  const service =
    String(
      booking?.service || ""
    ).trim();

  const time =
    autodearBookingTime(
      booking?.start_time
    );

  if (
    eventType ===
    "booking_reminder_15m"
  ) {
    const details = [
      stationName,
      stationAddress,
    ].filter(Boolean);

    return {
      title:
        "Запись через 15 минут",
      body:
        details.length
          ? `В ${time} — ${details.join(
              " · "
            )}`
          : `В ${time} у вас запись на СТО.`,
    };
  }

  if (
    eventType ===
    "booking_reminder_1h"
  ) {
    const details = [
      stationName,
      stationAddress,
    ].filter(Boolean);

    return {
      title:
        "Скоро запись на сервис",
      body:
        details.length
          ? `Через час, в ${time} — ${details.join(
              " · "
            )}`
          : `Через час, в ${time} у вас запись на СТО.`,
    };
  }

  const details = [
    service,
    stationName,
  ].filter(Boolean);

  return {
    title:
      "Напоминание о записи",
    body:
      details.length
        ? `Завтра в ${time} — ${details.join(
            " · "
          )}`
        : `Завтра в ${time} у вас запись на сервис.`,
  };
}

async function customerBookingReminderAlreadySent(
  bookingId,
  eventType
) {
  const {
    data,
    error,
  } = await supabase
    .from("notifications")
    .select("id")
    .eq(
      "related_type",
      eventType
    )
    .eq(
      "related_id",
      String(bookingId)
    )
    .limit(1);

  if (error) {
    throw error;
  }

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}

async function runCustomerBookingReminders() {
  if (
    customerBookingReminderRunning ||
    !supabase
  ) {
    return;
  }

  customerBookingReminderRunning = true;

  try {
    const now = new Date();

    /*
     * Достаточно ближайших ~24 часов.
     * Берём сегодня/завтра/послезавтра по UTC,
     * затем точное окно рассчитываем уже
     * в timezone станции.
     */
    const dateKeys = [];

    for (
      let offset = 0;
      offset <= 2;
      offset += 1
    ) {
      const date =
        new Date(
          now.getTime() +
            offset *
              24 *
              60 *
              60 *
              1000
        );

      dateKeys.push(
        date
          .toISOString()
          .slice(0, 10)
      );
    }

    const {
      data: bookingRows,
      error: bookingsError,
    } = await supabase
      .from("business_bookings")
      .select("*")
      .in(
        "booking_date",
        dateKeys
      )
      .eq(
        "status",
        "confirmed"
      );

    if (bookingsError) {
      throw bookingsError;
    }

    const bookings =
      Array.isArray(bookingRows)
        ? bookingRows
        : [];

    if (!bookings.length) {
      return;
    }

    const stationIds = [
      ...new Set(
        bookings
          .map(
            (booking) =>
              String(
                booking?.business_id ||
                  ""
              ).trim()
          )
          .filter(Boolean)
      ),
    ];

    if (!stationIds.length) {
      return;
    }

    const {
      data: stationRows,
      error: stationsError,
    } = await supabase
      .from("stations")
      .select(
        "id,name,legal_name,address,address_full,timezone"
      )
      .in(
        "id",
        stationIds
      );

    if (stationsError) {
      throw stationsError;
    }

    const stationsById =
      new Map(
        (
          Array.isArray(stationRows)
            ? stationRows
            : []
        ).map(
          (station) => [
            String(station.id),
            station,
          ]
        )
      );

    for (const booking of bookings) {
      const bookingId =
        String(
          booking?.id || ""
        ).trim();

      const customerId =
        String(
          booking?.customer_id ||
            ""
        ).trim();

      const stationId =
        String(
          booking?.business_id ||
            ""
        ).trim();

      if (
        !bookingId ||
        !customerId ||
        !stationId
      ) {
        continue;
      }

      const station =
        stationsById.get(
          stationId
        );

      if (!station) {
        continue;
      }

      const timezone =
        autodearSafeTimezone(
          station.timezone
        );

      const bookingAt =
        autodearBookingDateTimeUtc(
          booking.booking_date,
          booking.start_time,
          timezone
        );

      if (!bookingAt) {
        continue;
      }

      const minutesUntil =
        (
          bookingAt.getTime() -
          now.getTime()
        ) /
        60000;

      for (
        const rule of
        CUSTOMER_BOOKING_REMINDER_WINDOWS
      ) {
        const distance =
          Math.abs(
            minutesUntil -
              rule.minutesBefore
          );

        if (
          distance >
          rule.toleranceMinutes
        ) {
          continue;
        }

        const alreadySent =
          await customerBookingReminderAlreadySent(
            bookingId,
            rule.eventType
          );

        if (alreadySent) {
          continue;
        }

        const {
          data: tokenRows,
          error: tokensError,
        } = await supabase
          .from(
            "device_push_tokens"
          )
          .select(
            "expo_push_token"
          )
          .eq(
            "user_id",
            customerId
          )
          .eq(
            "is_active",
            true
          );

        if (tokensError) {
          throw tokensError;
        }

        const tokens =
          (
            Array.isArray(tokenRows)
              ? tokenRows
              : []
          )
            .map(
              (row) =>
                String(
                  row?.expo_push_token ||
                    ""
                ).trim()
            )
            .filter(Boolean);

        if (!tokens.length) {
          continue;
        }

        const copy =
          buildCustomerBookingReminderCopy(
            booking,
            station,
            rule.eventType
          );

        const requestId =
          String(
            booking?.request_id ||
              ""
          ).trim();

        /*
         * Клиент уже умеет открыть явный route.
         * Передаём также все ID, чтобы позже
         * маршрут можно было уточнять без
         * изменения scheduler.
         */
        const pushData = {
          type:
            rule.eventType,
          eventType:
            rule.eventType,
          category:
            "booking",
          bookingId,
          requestId:
            requestId || null,
          stationId,
          route:
            requestId
              ? `/profile/bookings?requestId=${encodeURIComponent(
                  requestId
                )}`
              : "/profile/bookings",
        };

        /*
         * Сначала резервируем notification как
         * постоянный ключ дедупликации.
         *
         * Если push не отправился — удаляем резерв,
         * чтобы следующий sweep мог повторить попытку.
         */
        const {
          data:
            reservedNotification,
          error:
            notificationError,
        } = await supabase
          .from("notifications")
          .insert({
            recipient_role:
              "user",
            recipient_id:
              customerId,
            title:
              copy.title,
            body:
              copy.body,
            type:
              "booking",
            related_type:
              rule.eventType,
            related_id:
              bookingId,
            is_read:
              false,
          })
          .select("id")
          .single();

        if (notificationError) {
          throw notificationError;
        }

        try {
          const pushResult =
            await sendAutodearExpoPush({
              tokens,
              title:
                copy.title,
              body:
                copy.body,
              data:
                pushData,
            });

          if (
            !pushResult ||
            !pushResult.sent
          ) {
            throw new Error(
              "CUSTOMER_BOOKING_REMINDER_PUSH_NOT_SENT"
            );
          }
        } catch (pushError) {
          const reservedId =
            String(
              reservedNotification?.id ||
                ""
            ).trim();

          if (reservedId) {
            const {
              error:
                rollbackError,
            } = await supabase
              .from("notifications")
              .delete()
              .eq(
                "id",
                reservedId
              );

            if (rollbackError) {
              console.error(
                "[AUTODEAR][CUSTOMER_BOOKING_REMINDER][ROLLBACK_ERROR]",
                {
                  bookingId,
                  eventType:
                    rule.eventType,
                  notificationId:
                    reservedId,
                  message:
                    rollbackError.message ||
                    String(
                      rollbackError
                    ),
                }
              );
            }
          }

          throw pushError;
        }

        console.log(
          "[AUTODEAR][CUSTOMER_BOOKING_REMINDER][SENT]",
          {
            eventType:
              rule.eventType,
            bookingId,
            customerId,
            stationId,
          }
        );
      }
    }
  } catch (error) {
    console.error(
      "[AUTODEAR][CUSTOMER_BOOKING_REMINDER][ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );
  } finally {
    customerBookingReminderRunning = false;
  }
}

function startCustomerBookingReminderScheduler() {
  setTimeout(
    () => {
      runCustomerBookingReminders();
    },
    5000
  );

  setInterval(
    () => {
      runCustomerBookingReminders();
    },
    CUSTOMER_BOOKING_REMINDER_INTERVAL_MS
  );
}

function startBusinessTomorrowReminderScheduler() {
  const run =
    () => {
      runAutodearBusinessTomorrowReminderSweep()
        .catch(
          (error) => {
            console.error(
              "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][UNHANDLED]",
              error
            );
          }
        );
    };

  setTimeout(
    run,
    5000
  );

  const timer =
    setInterval(
      run,
      60 * 1000
    );

  if (
    typeof timer.unref ===
    "function"
  ) {
    timer.unref();
  }

  console.log(
    "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][SCHEDULER_STARTED]"
  );
}

/*
 * Диагностический endpoint.
 * Ничего не отправляет.
 */
app.get(
  "/api/developer/business-tomorrow-reminder-preview",
  async (req, res) => {
    try {
      const stationId =
        String(
          req.query?.stationId ||
            ""
        ).trim();

      const result =
        await buildBusinessTomorrowReminder(
          stationId
        );

      return res.json({
        ok:
          true,

        reminder:
          result,
      });
    } catch (error) {
      console.error(
        "[AUTODEAR][BUSINESS_TOMORROW_REMINDER][PREVIEW_ERROR]",
        error
      );

      return res
        .status(
          500
        )
        .json({
          ok:
            false,

          error:
            error?.message ||
            "BUSINESS_TOMORROW_REMINDER_PREVIEW_FAILED",
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

  startCustomerBookingReminderScheduler();
startBusinessTomorrowReminderScheduler();
  startAutodearListingPricePlanScheduler();
});
