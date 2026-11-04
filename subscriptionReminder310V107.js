"use strict";

// AUTODEAR_SUBSCRIPTION_310_V107
// СЕРВЕР: единственный источник уведомлений за 3 / 1 / 0 дней.
// Не списывает деньги, не активирует/отключает тарифы, не меняет их дату.
// Отправка отключена до явного AUTODEAR_SUBSCRIPTION_310_ENABLED=true.
const crypto = require("node:crypto");
const DAY = 86400000;
const EVENT_TYPES = Object.freeze({3: "business_subscription_3d_v107", 1: "business_subscription_1d_v107", 0: "business_subscription_0d_v107"});
let sweepRunning = false;

function isPaidPlan(plan) {
  return ["pro", "max"].includes(String(plan || "").trim().toLowerCase());
}

function subscriptionThreshold310(expiresAt, now = Date.now()) {
  const expires = Date.parse(String(expiresAt || ""));
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current)) return null;
  const left = expires - current;
  if (left <= 0 && left >= -DAY) return 0;
  if (left > 0 && left <= DAY) return 1;
  if (left > 2 * DAY && left <= 3 * DAY) return 3;
  return null;
}

// Детеминированный UUID v5-подобный, по business_id + периоду + порогу.
// Один и тот же бизнес на двух телефонах получает ОДИН event_id на событие.
function subscriptionEventId310(businessId, expiresAt, threshold) {
  const iso = new Date(expiresAt).toISOString();
  if (!EVENT_TYPES[threshold]) throw new Error("INVALID_SUBSCRIPTION_THRESHOLD");
  const key = `AUTODEAR-SUB310-V107|${String(businessId).trim()}|${iso}|${threshold}`;
  const raw = Buffer.from(crypto.createHash("sha256").update(key).digest().subarray(0, 16));
  raw[6] = (raw[6] & 0x0f) | 0x50;
  raw[8] = (raw[8] & 0x3f) | 0x80;
  const h = raw.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function subscriptionCopy310(plan, threshold) {
  const tariff = String(plan).toLowerCase() === "max" ? "Business MAX" : "Business PRO";
  if (threshold === 3) return {
    title: "Скоро закончится бизнес-тариф",
    body: `Тариф ${tariff} закончится через 3 дня. Проверьте дату окончания подписки.`,
  };
  if (threshold === 1) return {
    title: "Завтра закончится бизнес-тариф",
    body: `Срок действия тарифа ${tariff} закончится через 1 день.`,
  };
  return {
    title: "Срок бизнес-тарифа истёк",
    body: `Срок действия тарифа ${tariff} закончился. Доступность платных возможностей зависит от статуса подписки.`,
  };
}

async function resolveSubscriptionRecipient310(db, businessId) {
  const key = String(businessId || "").trim();
  if (!key) return null;

  let ownerAuthId = "";
  let accountResult = await db.from("business_accounts")
    .select("id,auth_user_id").eq("id", key).limit(1).maybeSingle();
  if (accountResult.error) throw accountResult.error;
  if (!accountResult.data) {
    accountResult = await db.from("business_accounts")
      .select("id,auth_user_id").eq("auth_user_id", key).limit(1).maybeSingle();
    if (accountResult.error) throw accountResult.error;
  }
  ownerAuthId = String(accountResult.data?.auth_user_id || "").trim();
  // Нет подтверждённой личности — НЕ используем идентификаторы из личного профиля по умолчанию.
  if (!ownerAuthId) return null;

  const {data: profile, error: profileError} = await db.from("profiles")
    .select("id").eq("auth_user_id", ownerAuthId).limit(1).maybeSingle();
  if (profileError) throw profileError;
  const ownerKeys = Array.from(new Set([ownerAuthId, String(profile?.id || "").trim()].filter(Boolean)));

  const {data: stationRows, error: stationError} = await db.from("stations")
    .select("id,owner_id").in("owner_id", ownerKeys)
    .order("created_at", {ascending: true}).limit(1);
  if (stationError) throw stationError;

  const stationId = String((stationRows || [])[0]?.id || "").trim();
  return stationId
    ? {ownerAuthId, recipientRole: "business", recipientId: stationId}
    : {ownerAuthId, recipientRole: "user", recipientId: ownerAuthId};
}

async function runSubscriptionReminder310({db, sendPush, now = new Date(), logger = console}) {
  if (!db) throw new Error("SUB310_SERVICE_ROLE_DB_REQUIRED");
  if (sweepRunning) return {skipped: "RUNNING"};
  sweepRunning = true;
  const stats = {checked: 0, due: 0, created: 0, duplicates: 0, unresolved: 0, pushAttempts: 0, errors: 0};
  try {
    const clock = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(clock.getTime())) throw new Error("SUB310_INVALID_CLOCK");
    const {data: subscriptions, error: loadError} = await db.from("business_subscriptions")
      .select("business_id,plan,active,expires_at")
      .in("plan", ["pro", "max"])
      .gte("expires_at", new Date(clock.getTime() - DAY).toISOString())
      .lte("expires_at", new Date(clock.getTime() + 3 * DAY).toISOString())
      .order("expires_at", {ascending: true}).limit(500);
    if (loadError) throw loadError;
    for (const sub of subscriptions || []) {
      stats.checked++;
      try {
        if (!isPaidPlan(sub.plan)) continue;
        const businessId = String(sub.business_id || "").trim();
        const threshold = subscriptionThreshold310(sub.expires_at, clock);
        if (!businessId || threshold === null) continue;
        // До окончания — только активный план. В день окончания
        // уведомляем также уже помеченную как inactive подписку.
        if (threshold !== 0 && sub.active !== true) continue;
        stats.due++;
        const recipient = await resolveSubscriptionRecipient310(db, businessId);
        if (!recipient) {
          stats.unresolved++;
          logger.warn("[AUTODEAR][SUB310][RECIPIENT_NOT_RESOLVED]", {businessId});
          continue;
        }
        const eventId = subscriptionEventId310(businessId, sub.expires_at, threshold);
        const copy = subscriptionCopy310(sub.plan, threshold);
        // ОДНА атомарная серверная транзакция: claim + запись в notifications.
        // При конкуренции между процессами RPC возвращает null, ничего не дублируется.
        const {data: notificationId, error: claimError} = await db.rpc(
          "autodear_claim_subscription_notice_310_v107", {
            p_event_id: eventId,
            p_business_id: businessId,
            p_expires_at: new Date(sub.expires_at).toISOString(),
            p_threshold: threshold,
            p_recipient_role: recipient.recipientRole,
            p_recipient_id: recipient.recipientId,
            p_title: copy.title,
            p_body: copy.body,
          });
        if (claimError) throw claimError;
        if (!notificationId) {stats.duplicates++; continue;}
        stats.created++;

        // Push — вторичный канал: только после успешного атомарного claim.
        // Не повторяем push автоматически после сетевой неопределённости,
        // чтобы одно событие не пришло дважды.
        try {
          const {data: devices, error: devicesError} = await db.from("device_push_tokens")
            .select("expo_push_token").eq("user_id", recipient.ownerAuthId).eq("is_active", true);
          if (devicesError) throw devicesError;
          const tokens = Array.from(new Set((devices || [])
            .map(row => String(row?.expo_push_token || "").trim()).filter(Boolean)));
          if (!tokens.length) continue; // запись в центре уведомлений уже создана
          stats.pushAttempts++;
          const outcome = await sendPush({
            tokens, title: copy.title, body: copy.body,
            data: {
              recipient_role: recipient.recipientRole,
              type: EVENT_TYPES[threshold],
              eventType: EVENT_TYPES[threshold],
              category: "finance",
              notificationId: String(notificationId),
              businessId, threshold,
              route: "/profile/notification-center",
            },
          });
          logger.log("[AUTODEAR][SUB310][PUSH_ATTEMPT]", {
            businessId, threshold, tokens: tokens.length,
            accepted: Boolean(outcome?.ok),
          });
        } catch (pushError) {
          logger.warn("[AUTODEAR][SUB310][PUSH_FAILED_NO_RETRY]", {
            businessId, threshold, error: String(pushError?.message || pushError),
          });
        }
      } catch (subError) {
        stats.errors++;
        logger.error("[AUTODEAR][SUB310][ROW_ERROR]", {
          businessId: String(sub?.business_id || ""),
          error: String(subError?.message || subError),
        });
      }
    }
    logger.log("[AUTODEAR][SUB310][SWEEP]", stats);
    return stats;
  } finally {
    sweepRunning = false;
  }
}

function startSubscriptionReminder310({db, sendPush, env = process.env, logger = console}) {
  if (String(env?.AUTODEAR_SUBSCRIPTION_310_ENABLED || "").toLowerCase() !== "true") {
    logger.log("[AUTODEAR][SUB310][DISABLED] Set AUTODEAR_SUBSCRIPTION_310_ENABLED=true after SQL migration and rollout approval");
    return null;
  }
  if (!db || typeof sendPush !== "function") {
    logger.error("[AUTODEAR][SUB310][NOT_STARTED] Service-role database or push sender missing");
    return null;
  }
  const run = () => runSubscriptionReminder310({db, sendPush, logger})
    .catch(error => logger.error("[AUTODEAR][SUB310][SWEEP_ERROR]", String(error?.message || error)));
  const startup = setTimeout(run, 15000);
  if (typeof startup.unref === "function") startup.unref();
  const interval = setInterval(run, 60 * 60 * 1000);
  if (typeof interval.unref === "function") interval.unref();
  logger.log("[AUTODEAR][SUB310][SCHEDULER_STARTED]");
  return interval;
}

module.exports = {
  isPaidPlan, subscriptionThreshold310, subscriptionEventId310,
  subscriptionCopy310, resolveSubscriptionRecipient310,
  runSubscriptionReminder310, startSubscriptionReminder310,
};
