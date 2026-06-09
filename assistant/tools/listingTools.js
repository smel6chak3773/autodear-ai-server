// server/assistant/tools/listingTools.js

const LISTINGS = [
  {
    id: "listing_1",
    title: "Toyota Camry 2020",
    category: "Транспорт",
    city: "Краснодар",
    price: 1950000,
    description:
      "Toyota Camry 2020, автомат, хорошее состояние, без серьёзных ДТП.",
    tags: ["toyota", "camry", "камри", "седан", "авто", "транспорт"],
  },
  {
    id: "listing_2",
    title: "BMW X5 2018",
    category: "Транспорт",
    city: "Краснодар",
    price: 4250000,
    description:
      "BMW X5 2018, дизель, полный привод, хорошая комплектация.",
    tags: ["bmw", "x5", "бмв", "кроссовер", "авто", "транспорт"],
  },
  {
    id: "listing_3",
    title: "Автосварщик / сварочные работы",
    category: "Услуги",
    city: "Краснодар",
    price: 3000,
    description:
      "Сварочные работы по авто, аргон, кузовной ремонт, ремонт порогов.",
    tags: [
      "сварка",
      "сварочные работы",
      "автосварщик",
      "аргон",
      "кузовной ремонт",
      "пороги",
      "услуги",
    ],
  },
  {
    id: "listing_4",
    title: "Выездной шиномонтаж",
    category: "Услуги",
    city: "Краснодар",
    price: 1500,
    description:
      "Выездной шиномонтаж, балансировка, ремонт проколов, сезонная замена.",
    tags: [
      "шиномонтаж",
      "выездной шиномонтаж",
      "шины",
      "колеса",
      "балансировка",
      "ремонт проколов",
      "услуги",
    ],
  },
];

function normalize(text = "") {
  return String(text).toLowerCase().replaceAll("ё", "е").trim();
}

function findListings(query = "") {
  const text = normalize(query);

  if (!text) return [];

  return LISTINGS.filter((item) => {
    const haystack = normalize(
      [
        item.title,
        item.category,
        item.city,
        item.description,
        ...(item.tags || []),
      ].join(" ")
    );

    return text
      .split(" ")
      .filter(Boolean)
      .some((word) => haystack.includes(word));
  }).slice(0, 5);
}

module.exports = {
  findListings,
};
