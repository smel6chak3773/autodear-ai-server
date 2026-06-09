// server/assistant/data/serviceCatalog.js

const serviceCatalog = [
  {
    id: "engine_repair",
    title: "Ремонт двигателя",
    kind: "station",
    group: "Ремонт",
    keywords: ["двигатель", "мотор", "капиталка", "капремонт", "ремонт двс"],
  },
  {
    id: "gearbox_repair",
    title: "Ремонт коробки передач",
    kind: "station",
    group: "Ремонт",
    keywords: ["акпп", "мкпп", "коробка", "робот", "вариатор", "dsg"],
  },
  {
    id: "suspension_repair",
    title: "Ремонт ходовой части",
    kind: "station",
    group: "Ремонт",
    keywords: ["ходовка", "подвеска", "стойки", "рычаги", "шаровые"],
  },
  {
    id: "computer_diagnostics",
    title: "Компьютерная диагностика",
    kind: "station",
    group: "Диагностика",
    keywords: ["диагностика", "ошибки", "чек", "check engine", "сканер"],
  },
  {
    id: "auto_electrician",
    title: "Автоэлектрик",
    kind: "station",
    group: "Электрика",
    keywords: ["электрик", "проводка", "стартер", "генератор", "датчик"],
  },
  {
    id: "auto_welder",
    title: "Автосварщик",
    kind: "station",
    group: "Кузов",
    keywords: ["сварка", "сварщик", "аргон", "аргоновая сварка", "сварочные работы"],
  },
  {
    id: "body_repair",
    title: "Кузовной ремонт",
    kind: "station",
    group: "Кузов",
    keywords: ["кузов", "рихтовка", "геометрия", "лонжерон", "стапель"],
  },
  {
    id: "paint",
    title: "Автопокраска",
    kind: "station",
    group: "Кузов",
    keywords: ["покраска", "малярка", "окрас", "покрасить", "краска"],
  },
  {
    id: "dent_repair",
    title: "Удаление вмятин без покраски",
    kind: "station",
    group: "Кузов",
    keywords: ["вмятина", "pdr", "без покраски", "удалить вмятину"],
  },
  {
    id: "wheel_alignment",
    title: "Развал-схождение",
    kind: "station",
    group: "Колёса",
    keywords: ["развал", "схождение", "геометрия колес", "руль тянет"],
  },
  {
    id: "tire_service",
    title: "Шиномонтаж",
    kind: "station",
    group: "Колёса",
    keywords: ["шиномонтаж", "переобуть", "балансировка", "резина"],
  },
  {
    id: "mobile_tire_service",
    title: "Выездной шиномонтаж",
    kind: "mobile",
    group: "Выездные услуги",
    keywords: ["выездной шиномонтаж", "прокол", "колесо", "на дороге", "переобуть на месте"],
  },
  {
    id: "tire_storage",
    title: "Хранение шин",
    kind: "station",
    group: "Колёса",
    keywords: ["хранение шин", "хранение колес", "сезонное хранение"],
  },
  {
    id: "oil_filters",
    title: "Замена масла и фильтров",
    kind: "station",
    group: "ТО",
    keywords: ["масло", "фильтр", "то", "замена масла", "масляный фильтр"],
  },
  {
    id: "ac_refill",
    title: "Заправка кондиционера",
    kind: "station",
    group: "Климат",
    keywords: ["кондиционер", "заправка кондиционера", "фреон", "не холодит"],
  },
  {
    id: "anticorrosion",
    title: "Антикоррозийная обработка",
    kind: "station",
    group: "Защита",
    keywords: ["антикор", "антикоррозийная", "обработка днища", "ржавчина"],
  },
  {
    id: "detailing",
    title: "Детейлинг",
    kind: "station",
    group: "Уход",
    keywords: ["детейлинг", "химчистка", "полировка", "керамика"],
  },
  {
    id: "headlight_polishing",
    title: "Полировка фар",
    kind: "station",
    group: "Уход",
    keywords: ["фары", "полировка фар", "мутные фары"],
  },
  {
    id: "body_polishing",
    title: "Полировка кузова",
    kind: "station",
    group: "Уход",
    keywords: ["полировка кузова", "царапины", "лак", "блеск"],
  },
  {
    id: "windshield_install",
    title: "Установка лобового стекла",
    kind: "station",
    group: "Стёкла",
    keywords: ["лобовое стекло", "замена стекла", "стекло", "трещина"],
  },
  {
    id: "head_unit_install",
    title: "Установка автомагнитол",
    kind: "station",
    group: "Электроника",
    keywords: ["магнитола", "автомагнитола", "установка магнитолы", "поставить магнитолу", "поставить автомагнитолу", "андроид магнитола"],
  },
  {
    id: "dashcam_install",
    title: "Установка видеорегистраторов",
    kind: "station",
    group: "Электроника",
    keywords: ["регистратор", "видеорегистратор", "камера", "установка регистратора"],
  },
  {
    id: "alarm_install",
    title: "Установка сигнализации",
    kind: "station",
    group: "Охрана",
    keywords: ["сигнализация", "автосигнализация", "старлайн", "пандора"],
  },
  {
    id: "lpg_install",
    title: "Установка ГБО",
    kind: "station",
    group: "Газ",
    keywords: ["гбо", "газ", "метан", "пропан", "газовое оборудование"],
  },
  {
    id: "tow_truck",
    title: "Эвакуатор",
    kind: "mobile",
    group: "Выездные услуги",
    keywords: ["эвакуатор", "эвакуация", "забрать авто", "сломалась машина"],
  },
  {
    id: "accident_commissioner",
    title: "Аварийный комиссар",
    kind: "emergency",
    group: "ДТП",
    keywords: ["комиссар", "аварийный комиссар", "дтп", "оформить дтп", "авария"],
  },
  {
    id: "auto_lawyer",
    title: "Автоюрист",
    kind: "legal",
    group: "Юридические услуги",
    keywords: ["юрист", "автоюрист", "страховая", "дтп", "лишение прав"],
  },
  {
    id: "insurance",
    title: "Автострахование",
    kind: "other",
    group: "Страхование",
    keywords: ["осаго", "каско", "страховка", "страхование"],
  },
];

function normalize(text = "") {
  return String(text).toLowerCase().replaceAll("ё", "е").trim();
}

function hasWord(text, word) {
  return text.split(/\s+/).includes(word);
}

function safeIncludes(text, value) {
  if (!value) return false;

  if (value.length <= 2) {
    return hasWord(text, value);
  }

  return text.includes(value);
}

function detectServiceByText(query = "") {
  const q = normalize(query);

  if (!q) return null;

  return (
    serviceCatalog.find((service) => {
      const title = normalize(service.title);
      const group = normalize(service.group);

      if (safeIncludes(q, title) || safeIncludes(q, group)) {
        return true;
      }

      return service.keywords.some((keyword) => {
        const k = normalize(keyword);

        return safeIncludes(q, k);
      });
    }) || null
  );
}

module.exports = {
  serviceCatalog,
  detectServiceByText,
};
