// server/assistant/tools/serviceTools.js

const { detectServiceByText } = require("../data/serviceCatalog");
const serviceSynonyms = require("../data/serviceSynonyms");
const { findStationsByService } = require("../data/stations");

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

  const matchedStations = findStationsByService(detected.title);

  if (matchedStations.length) {
    return matchedStations;
  }

  return [
    {
      id: "service_fallback_1",
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
  ];
}

module.exports = {
  findServices,
  detectService,
};
