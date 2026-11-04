"use strict";
const assert = require("node:assert/strict");
const {
  isPaidPlan, subscriptionThreshold310, subscriptionEventId310,
  subscriptionCopy310, startSubscriptionReminder310,
  runSubscriptionReminder310,
} = require("./subscriptionReminder310V107");
const DAY = 86400000;
const t0 = new Date("2026-11-04T12:00:00.000Z");
const due = offset => new Date(t0.getTime() + offset).toISOString();
const messageLogger = {log() {}, warn() {}, error() {}};

assert.equal(subscriptionThreshold310(due(3 * DAY), t0), 3);
assert.equal(subscriptionThreshold310(due(2.5 * DAY), t0), 3);
assert.equal(subscriptionThreshold310(due(2 * DAY), t0), null);
assert.equal(subscriptionThreshold310(due(1 * DAY), t0), 1);
assert.equal(subscriptionThreshold310(due(0.5 * DAY), t0), 1);
assert.equal(subscriptionThreshold310(due(0), t0), 0);
assert.equal(subscriptionThreshold310(due(-0.5 * DAY), t0), 0);
assert.equal(subscriptionThreshold310(due(-2 * DAY), t0), null);
assert.equal(subscriptionThreshold310("invalid", t0), null);
assert.equal(isPaidPlan("pro"), true);
assert.equal(isPaidPlan("max"), true);
for (const plan of ["trial", "partner", "start", "free", ""]) assert.equal(isPaidPlan(plan), false);
const id = subscriptionEventId310("business-id", due(3 * DAY), 3);
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(id, subscriptionEventId310("business-id", due(3 * DAY), 3));
assert.notEqual(id, subscriptionEventId310("business-id", due(3 * DAY + 1), 3));
assert.notEqual(id, subscriptionEventId310("business-id", due(3 * DAY), 1));
assert.match(subscriptionCopy310("pro", 3).body, /3 дня/);
assert.match(subscriptionCopy310("pro", 1).body, /1 день/);
assert.match(subscriptionCopy310("pro", 0).title, /истёк/);
assert.equal(startSubscriptionReminder310({env: {}, logger: messageLogger}), null);

// Сценарий двух запусков: одна запись + один push, повторное сканирование -> 0.
const savedEvents = new Set();
const subscriptions = [
  {business_id: "business-id", plan: "pro", active: true, expires_at: due(3 * DAY)},
  {business_id: "free-business", plan: "partner", active: true, expires_at: due(3 * DAY)},
];
let pushes = 0;
function query(table) {
  const q = {
    select() {return q;}, eq() {return q;}, in() {return q;}, gte() {return q;},
    lte() {return q;}, order() {return q;}, limit() {return q;},
    async maybeSingle() {
      if (table === "business_accounts") return {data: {id: "business-id", auth_user_id: "owner-auth"}, error: null};
      if (table === "profiles") return {data: {id: "owner-profile"}, error: null};
      return {data: null, error: null};
    },
    then(resolve, reject) {
      let data = [];
      if (table === "business_subscriptions") data = subscriptions;
      if (table === "stations") data = [{id: "station-id"}];
      if (table === "device_push_tokens") data = [{expo_push_token: "token-A"}];
      return Promise.resolve({data, error: null}).then(resolve, reject);
    },
  };
  return q;
}
const db = {
  from: query,
  async rpc(name, args) {
    assert.equal(name, "autodear_claim_subscription_notice_310_v107");
    if (savedEvents.has(args.p_event_id)) return {data: null, error: null};
    savedEvents.add(args.p_event_id);
    return {data: "notification-id", error: null};
  },
};
(async () => {
  const a = await runSubscriptionReminder310({db, now: t0, logger: messageLogger, sendPush: async () => {pushes++; return {ok:true};}});
  assert.equal(a.created, 1); assert.equal(a.errors, 0); assert.equal(pushes, 1);
  const b = await runSubscriptionReminder310({db, now: t0, logger: messageLogger, sendPush: async () => {pushes++; return {ok:true};}});
  assert.equal(b.created, 0); assert.equal(b.duplicates, 1); assert.equal(pushes, 1);
  subscriptions.push({business_id:"old-paid", plan:"max", active:false, expires_at:due(-0.5*DAY)});
  const c = await runSubscriptionReminder310({db, now:t0, logger:messageLogger, sendPush:async()=>{pushes++;return {ok:true};}});
  assert.equal(c.created, 1); assert.equal(pushes, 2); // 0-day event after expiry even if no longer active
  console.log("SUCCESS: SUB310 V107 tests (3 / 1 / 0, free plan excluded, per-period idempotency, no resend)");
})().catch(error => {console.error(error); process.exitCode = 1;});
