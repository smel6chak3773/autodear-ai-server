// server/assistant/brain.js

const OpenAI = require("openai");
const { APP_KNOWLEDGE } = require("./appKnowledge");
const { detectIntent } = require("./intentDetector");
const { buildAction } = require("./actionRouter");
const { findServices, detectService } = require("./tools/serviceTools");
const {
  createBookingDraft,
  saveLatestServicesForUser,
  getLatestServicesForUser,
  getLatestBookingDraftForUser,
  customerConfirmBooking,
} = require("./tools/bookingTools");

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function normalize(text = "") {
  return String(text).toLowerCase().replaceAll("ё", "е").trim();
}

function isConfirmation(text = "") {
  const normalized = normalize(text);

  return (
    normalized === "да" ||
    normalized.includes("да подтверждаю") ||
    normalized.includes("подтверждаю") ||
    normalized.includes("подтвердить") ||
    normalized.includes("согласен")
  );
}

function buildFallbackAnswer(toolData = {}, intent = "general_chat") {
  if (toolData.customerConfirmedBooking) {
    const booking = toolData.customerConfirmedBooking;

    return `Заявка отправлена в СТО. Ожидаем подтверждение от бизнеса.\n\nСТО: ${booking.serviceName}\nВремя: ${booking.slot}`;
  }

  if (toolData.bookingDraft) {
    const booking = toolData.bookingDraft;

    return `Черновик записи подготовлен.\n\nСТО: ${booking.serviceName}\nВремя: ${booking.slot}\n\nНажмите “Подтвердить запись”, чтобы отправить заявку в СТО.`;
  }

  if (toolData.services?.length) {
    return "Нашёл подходящие СТО. Выберите удобное время в карточке сервиса.";
  }

  if (intent === "create_listing") {
    return "Помогу создать объявление. Укажите категорию, марку, модель, год, цену, город, состояние и описание.";
  }

  if (intent === "parts_search") {
    return "Помогу подобрать запчасти. Укажите марку, модель, год, двигатель или VIN.";
  }

  return "Я на связи. Могу помочь с поиском авто, СТО, запчастей, объявлений и функциями AUTODEAR.";
}

function getIntentInstruction(intent) {
  if (intent === "service_search") {
    return `
Пользователь ищет СТО, услугу или запись на ремонт.

Если в toolData.services есть список СТО:
- ответь коротко: "Нашёл подходящие СТО. Выберите удобное время в карточке сервиса."
- не перечисляй СТО текстом, потому что приложение само покажет карточки.

Если в toolData.bookingDraft есть черновик записи:
- скажи, что черновик записи подготовлен;
- попроси пользователя подтвердить запись.

Если в toolData.customerConfirmedBooking есть запись:
- скажи, что клиент подтвердил запись;
- объясни, что запрос отправлен в СТО и теперь ожидается подтверждение бизнеса.
`;
  }

  if (intent === "create_listing") {
    return `
Пользователь хочет создать или улучшить объявление.
Помоги собрать поля: категория, название, цена, город, описание, фото, состояние, характеристики.
Не показывай СТО.
`;
  }

  if (intent === "parts_search") {
    return `
Пользователь ищет запчасти.
Уточни марку, модель, год, двигатель, VIN или номер детали.
`;
  }

  if (intent === "help") {
    return `
Кратко объясни возможности AUTODEAR.
`;
  }

  return `
Обычный диалог. Отвечай полезно и не выдумывай действий.
`;
}

function findSelectedServiceFromText(text, services = []) {
  const normalized = normalize(text);

  const byId = services.find((item) =>
    normalized.includes(item.id.toLowerCase())
  );

  if (byId) return byId;

  const byName = services.find((item) =>
    normalized.includes(normalize(item.name))
  );

  if (byName) return byName;

  if (
    normalized.includes("перв") ||
    normalized.includes("1 ") ||
    normalized.includes("№1")
  ) {
    return services[0];
  }

  if (
    normalized.includes("втор") ||
    normalized.includes("2 ") ||
    normalized.includes("№2")
  ) {
    return services[1];
  }

  if (
    normalized.includes("трет") ||
    normalized.includes("3 ") ||
    normalized.includes("№3")
  ) {
    return services[2];
  }

  return null;
}

function findSelectedSlotFromText(text, service) {
  const normalized = normalize(text);

  if (!service?.availableSlots?.length) return null;

  return (
    service.availableSlots.find((slot) => {
      const cleanSlot = normalize(slot);
      const timeOnly = cleanSlot.replace("завтра ", "");

      return (
        normalized.includes(cleanSlot) ||
        normalized.includes(timeOnly) ||
        normalized.includes(timeOnly.replace(":", ""))
      );
    }) || null
  );
}

function maybeCreateBookingDraft(userId, text, services = []) {
  const normalized = normalize(text);

  const wantsBooking =
    normalized.includes("запиш") ||
    normalized.includes("заброниру") ||
    normalized.includes("хочу на") ||
    normalized.includes("на завтра") ||
    normalized.includes("завтра на");

  if (!wantsBooking) return null;

  const latestServices = getLatestServicesForUser(userId);
  const candidateServices = services?.length ? services : latestServices;

  let selectedService =
    findSelectedServiceFromText(text, candidateServices) || candidateServices[0];

  if (!selectedService) return null;

  const selectedSlot =
    findSelectedSlotFromText(text, selectedService) ||
    selectedService.availableSlots?.find((slot) => {
      const normalizedSlot = normalize(slot);
      return (
        normalized.includes(normalizedSlot.replace("завтра ", "")) ||
        normalized.includes(normalizedSlot.replace("завтра ", "").replace(":", ""))
      );
    });

  if (!selectedSlot) return null;

  return createBookingDraft({
    userId,
    serviceId: selectedService.id,
    serviceName: selectedService.name,
    slot: selectedSlot,
  });
}

function getToolData(userId, intent, text) {
  if (isConfirmation(text)) {
    const latestDraft = getLatestBookingDraftForUser(userId);

    if (latestDraft && latestDraft.status === "draft") {
      const customerConfirmedBooking = customerConfirmBooking(latestDraft.id);

      return {
        customerConfirmedBooking,
      };
    }
  }

  if (intent === "service_search") {
    const services = findServices(text);
    const isBookingRequest =
      normalize(text).includes("запиш") ||
      normalize(text).includes("заброниру") ||
      normalize(text).includes("завтра на") ||
      normalize(text).includes("хочу на");

    const bookingDraft = maybeCreateBookingDraft(
      userId,
      text,
      isBookingRequest ? getLatestServicesForUser(userId) : services
    );

    if (services?.length && !isBookingRequest) {
      saveLatestServicesForUser(userId, services);
    }

    return {
      services: bookingDraft ? [] : services,
      bookingDraft,
    };
  }

  return {};
}

async function processMessage({ userId, message, session }) {
  const text = String(message || "").trim();
  const intentResult = detectIntent(text);

  const detectedService = detectService(text);

  if (
    detectedService &&
    detectedService.source !== "fallback" &&
    intentResult.intent === "general_chat"
  ) {
    intentResult.intent = "service_search";
    intentResult.confidence = 0.95;
  }

  const toolData = getToolData(userId, intentResult.intent, text);

  const action = buildAction(intentResult.intent, toolData);

  if (!openai) {
    return {
      answer: buildFallbackAnswer(toolData, intentResult.intent),
      intent: intentResult.intent,
      action,
      toolData,
    };
  }

  const isGuest = !userId || userId === "guest_demo";

  const systemPrompt = `
Ты — умный ассистент AUTODEAR.

AUTODEAR — это приложение для авто:
- объявления транспорта;
- запчасти;
- шины и диски;
- услуги и СТО;
- QR-сделки;
- бонусы;
- кошелёк;
- помощь с размещением объявлений.

Текущий пользователь:
- userId: ${userId}
- гость: ${isGuest ? "да" : "нет"}

Определённый intent:
- ${intentResult.intent}
- confidence: ${intentResult.confidence}

Данные из инструментов AUTODEAR:
${JSON.stringify(toolData, null, 2)}

Сценарная инструкция:
${getIntentInstruction(intentResult.intent)}

Правила:
- отвечай кратко и понятно;
- если есть toolData.services, не перечисляй СТО текстом, карточки покажет приложение;
- если есть toolData.bookingDraft, скажи, что черновик записи подготовлен;
- если есть toolData.customerConfirmedBooking, скажи, что заявка отправлена в СТО и ожидает подтверждения бизнеса;
- не говори, что СТО подтвердило запись, если нет подтверждения от бизнеса;
- для оплаты, публикации и удаления всегда проси подтверждение;
- если пользователь гость, мягко предложи регистрацию для персональных функций;
- не проси лишнее, если данные уже есть в сообщении.
`;

  const previousMessages = (session?.messages || [])
    .slice(-8)
    .map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...previousMessages,
        {
          role: "user",
          content: text,
        },
      ],
    });

    return {
      answer:
        response.output_text ||
        buildFallbackAnswer(toolData, intentResult.intent),
      intent: intentResult.intent,
      action,
      toolData,
    };
  } catch (error) {
    console.error("OpenAI connection failed, using fallback:", error?.message);

    return {
      answer: buildFallbackAnswer(toolData, intentResult.intent),
      intent: intentResult.intent,
      action,
      toolData,
    };
  }
}

module.exports = {
  processMessage,
};
