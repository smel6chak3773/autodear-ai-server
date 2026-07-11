const OpenAI = require("openai");

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function cleanText(value, max = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeProblems(items = []) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 5)
    .map((item) => ({
      level: cleanText(item?.level, 30),
      title: cleanText(item?.title, 160),
      message: cleanText(item?.message, 500),
      source: cleanText(item?.source, 120),
      screen: cleanText(item?.screen, 120),
      type: cleanText(item?.type, 120),
    }));
}

function buildFallback(snapshot) {
  const problems = sanitizeProblems(snapshot?.problems);

  if (!snapshot?.online) {
    return {
      severity: "critical",
      summary: "Устройство находится offline.",
      likelyCause:
        "Нет соединения с интернетом либо включён тестовый offline-режим.",
      checks: [
        "Проверить Wi-Fi или мобильную сеть",
        "Проверить networkStore",
        "Проверить доступность Render и Supabase",
      ],
      steps: [
        "Восстановить интернет",
        "Повторить диагностику",
        "Проверить очередь синхронизации",
      ],
      avoid: [
        "Не очищать локальное хранилище до проверки очереди синхронизации",
      ],
    };
  }

  if (snapshot?.aiStatus === "bad") {
    return {
      severity: "critical",
      summary: "AI-сервер недоступен.",
      likelyCause:
        "Render не отвечает, произошёл таймаут либо сервер вернул ошибку.",
      checks: [
        "Проверить /health",
        "Проверить Render deploy и логи",
        "Проверить переменные окружения",
      ],
      steps: [
        "Открыть состояние системы",
        "Проверить endpoint /health",
        "Повторить запрос после проверки Render",
      ],
      avoid: [
        "Не менять мобильный AI-клиент, пока не подтверждена проблема на сервере",
      ],
    };
  }

  if (Number(snapshot?.failedCount || 0) > 0) {
    return {
      severity: "critical",
      summary: "Есть проваленные операции синхронизации.",
      likelyCause:
        "Backend отклонил данные либо операция зависла после сетевой ошибки.",
      checks: [
        "Проверить failed items в sync queue",
        "Проверить payload",
        "Проверить Supabase и backend",
      ],
      steps: [
        "Открыть состояние системы",
        "Найти первую failed-операцию",
        "Повторить синхронизацию после устранения причины",
      ],
      avoid: [
        "Не очищать очередь до сохранения диагностических данных",
      ],
    };
  }

  if (problems.length > 0) {
    return {
      severity: "warning",
      summary: `Найдено событий для анализа: ${problems.length}.`,
      likelyCause:
        "Точная причина зависит от первого события в журнале.",
      checks: [
        "Проверить первое событие по времени",
        "Проверить экран и источник ошибки",
        "Сравнить с последними изменениями проекта",
      ],
      steps: [
        "Открыть журнал ошибок или уведомлений",
        "Воспроизвести проблему",
        "Сохранить stack trace и контекст",
      ],
      avoid: [
        "Не удалять историю до завершения диагностики",
      ],
    };
  }

  return {
    severity: "stable",
    summary: "Критических проблем не обнаружено.",
    likelyCause: "Контролируемые модули работают стабильно.",
    checks: [
      "Проверить основные пользовательские сценарии",
      "Проверить push на реальном устройстве",
      "Проверить синхронизацию перед APK",
    ],
    steps: [
      "Запустить контрольную диагностику",
      "Проверить основные роли",
      "Собрать APK после успешной проверки",
    ],
    avoid: [
      "Не считать локальную проверку заменой теста на реальном устройстве",
    ],
  };
}

function normalizeDiagnosis(value, fallback) {
  const severity = ["critical", "warning", "stable"].includes(value?.severity)
    ? value.severity
    : fallback.severity;

  const list = (input, fallbackList) =>
    Array.isArray(input) && input.length
      ? input.slice(0, 6).map((item) => cleanText(item, 300))
      : fallbackList;

  return {
    severity,
    summary: cleanText(value?.summary, 700) || fallback.summary,
    likelyCause:
      cleanText(value?.likelyCause, 900) || fallback.likelyCause,
    checks: list(value?.checks, fallback.checks),
    steps: list(value?.steps, fallback.steps),
    avoid: list(value?.avoid, fallback.avoid),
  };
}

async function diagnoseDeveloperSnapshot(snapshot = {}) {
  const sanitized = {
    online: !!snapshot.online,
    supabaseReady: !!snapshot.supabaseReady,
    aiStatus: cleanText(snapshot.aiStatus, 30),
    aiLatency: Number.isFinite(snapshot.aiLatency)
      ? snapshot.aiLatency
      : null,
    pendingCount: Math.max(0, Number(snapshot.pendingCount || 0)),
    failedCount: Math.max(0, Number(snapshot.failedCount || 0)),
    problems: sanitizeProblems(snapshot.problems),
  };

  const fallback = buildFallback(sanitized);

  if (!openai) {
    return {
      diagnosis: fallback,
      aiUsed: false,
    };
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_DEVELOPER_DIAG_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Ты технический диагност AUTODEAR. Анализируй только предоставленный диагностический snapshot. Не выдумывай факты. Верни JSON с полями severity, summary, likelyCause, checks, steps, avoid. severity только critical, warning или stable. Пиши по-русски, кратко и практически.",
        },
        {
          role: "user",
          content: JSON.stringify(sanitized),
        },
      ],
    });

    const raw = completion?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return {
      diagnosis: normalizeDiagnosis(parsed, fallback),
      aiUsed: true,
    };
  } catch (error) {
    console.error(
      "[AUTODEAR][DEVELOPER_DIAGNOSE]",
      {
        status: error?.status || null,
        code: error?.code || null,
        message: error?.message || String(error),
        type: error?.type || null,
        requestId:
          error?.request_id ||
          error?.headers?.["x-request-id"] ||
          null,
        responseData:
          error?.response?.data ||
          error?.error ||
          null,
      }
    );

    return {
      diagnosis: fallback,
      aiUsed: false,
    };
  }
}

module.exports = {
  diagnoseDeveloperSnapshot,
};
