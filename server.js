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

const adsCreativeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
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
     * New bookings:
     * only bookings belonging to one of
     * the authenticated owner's stations.
     */
    const bookingsPromise =
      supabase
        .from("business_bookings")
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
        `auth_user_id.eq.${authUserId},id.eq.${authUserId}`
      )
      .limit(1)
      .maybeSingle();

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
