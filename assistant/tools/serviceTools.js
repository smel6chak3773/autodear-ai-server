// server/assistant/tools/serviceTools.js

const { detectServiceByText } = require("../data/serviceCatalog");
const serviceSynonyms = require("../data/serviceSynonyms");

function normalize(text = "") {
  return String(text).toLowerCase().replaceAll("ё", "е").trim();
}

function detectService(query = "") {
  const q = normalize(query);

  const synonymKey = Object.keys(serviceSynonyms).find((key) =>
    q.includes(normalize(key))
  );

  if (synonymKey) {
    return {
      title: serviceSynonyms[synonymKey],
      source: "synonym",
    };
  }

  const catalogService = detectServiceByText(query);

  if (catalogService) {
    return {
      title: catalogService.title,
      source: "catalog",
    };
  }

  return {
    title: "Автосервис",
    source: "fallback",
  };
}

function findServices(query = "") {
  const detected = detectService(query);

  return [
    {
      id: "service_1",
      name: `${detected.title} · AUTODEAR Partner`,
      city: "Севастополь",
      address: "Севастополь, ул. Индустриальная, 12",
      service: detected.title,
      rating: 4.9,
      reviews: 127,
      distanceKm: 2.4,
      photoUrl: "https://picsum.photos/400/300?random=11",
      availableSlots: ["Завтра 10:00", "Завтра 14:30", "Завтра 18:00"],
    },
    {
      id: "service_2",
      name: `Мастер ${detected.title}`,
      city: "Севастополь",
      address: "Севастополь, ул. Руднева, 41",
      service: detected.title,
      rating: 4.8,
      reviews: 89,
      distanceKm: 3.8,
      photoUrl: "https://picsum.photos/400/300?random=12",
      availableSlots: ["Завтра 11:30", "Завтра 16:00"],
    },
    {
      id: "service_3",
      name: `${detected.title} 24`,
      city: "Севастополь",
      address: "Севастополь, пр-т Победы, 88",
      service: detected.title,
      rating: 4.7,
      reviews: 103,
      distanceKm: 5.1,
      photoUrl: "https://picsum.photos/400/300?random=13",
      availableSlots: ["Завтра 09:30", "Завтра 13:00"],
    },
  ];
}

module.exports = {
  findServices,
  detectService,
};
