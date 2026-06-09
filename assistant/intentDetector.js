// server/assistant/intentDetector.js

function normalize(text = "") {
  return String(text).toLowerCase().replaceAll("ё", "е").trim();
}

function detectIntent(message = "") {
  const text = normalize(message);

  if (
    text.includes("объявлен") ||
    text.includes("продать") ||
    text.includes("продаю") ||
    text.includes("размест") ||
    text.includes("описание") ||
    text.includes("создать объяв") ||
    text.includes("транспорт") ||
    text.includes("авто в хорошем") ||
    text.includes("пробег") ||
    text.includes("год выпуска") ||
    text.includes("шкода") ||
    text.includes("октавия") ||
    text.includes("bmw") ||
    text.includes("mercedes") ||
    text.includes("toyota") ||
    text.includes("kia") ||
    text.includes("hyundai")
  ) {
    return {
      intent: "create_listing",
      confidence: 0.9,
    };
  }

  if (
    text.includes("service_") ||
    text.includes("выбираю service") ||
    text.includes("записаться") ||
    text.includes("запиши") ||
    text.includes("записывай")
  ) {
    return {
      intent: "service_search",
      confidence: 0.95,
    };
  }

  if (
    text.includes("сто") ||
    text.includes("сервис") ||
    text.includes("ремонт") ||
    text.includes("замен") ||
    text.includes("лобов") ||
    text.includes("шиномонтаж") ||
    text.includes("диагност") ||
    text.includes("автосвар") ||
    text.includes("свароч") ||
    text.includes("сварка") ||
    text.includes("завар") ||
    text.includes("порог") ||
    text.includes("днище") ||
    text.includes("аргон") ||
    text.includes("кузов") ||
    text.includes("акпп") ||
    text.includes("мкпп") ||
    text.includes("коробк") ||
    text.includes("антикор")
  ) {
    return {
      intent: "service_search",
      confidence: 0.85,
    };
  }

  if (
    text.includes("запчаст") ||
    text.includes("колод") ||
    text.includes("масло") ||
    text.includes("фильтр") ||
    text.includes("свеч") ||
    text.includes("аккумулятор")
  ) {
    return {
      intent: "parts_search",
      confidence: 0.8,
    };
  }

  if (
    text.includes("что умеешь") ||
    text.includes("помощ") ||
    text.includes("как работает") ||
    text.includes("расскажи")
  ) {
    return {
      intent: "help",
      confidence: 0.9,
    };
  }

  return {
    intent: "general_chat",
    confidence: 0.5,
  };
}

module.exports = {
  detectIntent,
};
