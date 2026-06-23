// server/assistant/tools/serviceTools.js

const { detectServiceByText } = require("../data/serviceCatalog");
const serviceSynonyms = require("../data/serviceSynonyms");
const { findStationsByService } = require("../data/stations");
const { findStationsByServiceFromSupabase } = require("./stationSearchTools");

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

  return [];
}

module.exports = {
  findServices,
  detectService,
};
