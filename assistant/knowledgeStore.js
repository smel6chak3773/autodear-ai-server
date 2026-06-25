// assistant/knowledgeStore.js
// Безопасная база знаний AUTODEAR.
// Это не самообучение модели. Это управляемый кэш проверенных маршрутов.

const knowledgeItems = new Map();

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeKey(intent, phrase) {
  return `${intent}:${normalize(phrase)}`;
}

function tokenize(text = "") {
  return normalize(text)
    .split(" ")
    .filter((x) => x.length >= 3);
}

function similarity(a = "", b = "") {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));

  if (!aa.size || !bb.size) return 0;

  let common = 0;
  for (const token of aa) {
    if (bb.has(token)) common++;
  }

  return common / Math.max(aa.size, bb.size);
}

function rememberVerifiedRoute(input = {}) {
  const {
    intent,
    phrase,
    routeType,
    serviceName,
    serviceId,
    answer,
    confidence = 1,
    source = "system_verified",
  } = input;

  if (!intent || !phrase || !routeType) {
    return null;
  }

  const key = makeKey(intent, phrase);

  const item = {
    id: key,
    intent,
    phrase: normalize(phrase),
    routeType,
    serviceName: serviceName || null,
    serviceId: serviceId || null,
    answer: answer || null,
    confidence,
    approved: true,
    source,
    hits: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  knowledgeItems.set(key, item);

  return item;
}

function findVerifiedRoute(text = "", options = {}) {
  const intent = options.intent || null;
  const threshold = options.threshold || 0.55;

  let best = null;

  for (const item of knowledgeItems.values()) {
    if (!item.approved) continue;
    if (intent && item.intent !== intent) continue;

    const score = similarity(text, item.phrase);

    if (score >= threshold && (!best || score > best.score)) {
      best = {
        ...item,
        score,
      };
    }
  }

  if (!best) return null;

  const current = knowledgeItems.get(best.id);
  if (current) {
    current.hits += 1;
    current.updatedAt = new Date().toISOString();
  }

  return best;
}

function listKnowledge() {
  return Array.from(knowledgeItems.values()).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
}

function seedDefaultKnowledge() {
  const defaults = [
    {
      intent: "service_search",
      phrase: "заварить пороги",
      routeType: "service",
      serviceName: "Автосварщик",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "сварка порогов",
      routeType: "service",
      serviceName: "Автосварщик",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "коробка пинается",
      routeType: "service",
      serviceName: "Ремонт АКПП",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "лобовое стекло треснуло",
      routeType: "service",
      serviceName: "Замена стекол",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "антикор",
      routeType: "service",
      serviceName: "Антикоррозийная обработка",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "машина не заводится",
      routeType: "service",
      serviceName: "Диагностика",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "акпп пинается",
      routeType: "service",
      serviceName: "Ремонт АКПП",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "коробка дергается",
      routeType: "service",
      serviceName: "Ремонт АКПП",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "течет масло",
      routeType: "service",
      serviceName: "Диагностика",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "горит чек",
      routeType: "service",
      serviceName: "Диагностика",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "стучит подвеска",
      routeType: "service",
      serviceName: "Ремонт подвески",
      source: "default_seed",
    },
    {
      intent: "service_search",
      phrase: "поменять колодки",
      routeType: "service",
      serviceName: "Замена тормозных колодок",
      source: "default_seed",
    },
  ];

  for (const item of defaults) {
    rememberVerifiedRoute(item);
  }

  return listKnowledge();
}

seedDefaultKnowledge();

module.exports = {
  normalize,
  rememberVerifiedRoute,
  findVerifiedRoute,
  listKnowledge,
  seedDefaultKnowledge,
};
