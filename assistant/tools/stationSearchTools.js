const { supabase, isSupabaseReady } = require("../supabaseClient");

function normalizeText(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function toSlug(value = "") {
  return normalizeText(value)
    .replace(/[^a-zа-я0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

function toServiceCard(row, requestedServiceTitle) {
  const station = row.stations || row.station || row;

  return {
    id: String(station.id),
    name: station.name || "СТО AUTODEAR",
    city: station.city || "",
    address: station.address || "",
    service: requestedServiceTitle,
    rating: Number(station.rating || 0),
    reviews: Number(station.reviews_count || station.reviewsCount || 0),
    distanceKm: station.distance_km || station.distanceKm || null,
    photoUrl: station.photo_url || null,
    availableSlots: [],
  };
}

async function findStationsByServiceFromSupabase(serviceTitle, options = {}) {
  if (!isSupabaseReady || !supabase) {
    return [];
  }

  const title = String(serviceTitle || "").trim();
  if (!title) return [];

  const serviceId = toSlug(title);

  try {
    let serviceIds = [serviceId];

    const { data: servicesByTitle } = await supabase
      .from("services")
      .select("id,title")
      .or(`id.eq.${serviceId},title.ilike.%${title}%`)
      .limit(10);

    if (servicesByTitle?.length) {
      serviceIds = servicesByTitle.map((item) => item.id);
    }

    const { data, error } = await supabase
      .from("station_services")
      .select(`
        service_id,
        stations (
          id,
          name,
          address,
          city,
          lat,
          lng,
          rating,
          reviews_count
        )
      `)
      .in("service_id", serviceIds)
      .limit(20);

    if (error) {
      console.warn("[stationSearchTools] Supabase error:", error.message);
      return [];
    }

    if (!data?.length) return [];

    return data
      .filter((row) => row.stations)
      .map((row) => toServiceCard(row, title));
  } catch (error) {
    console.warn("[stationSearchTools] fallback:", error.message);
    return [];
  }
}

module.exports = {
  findStationsByServiceFromSupabase,
};
