// assistant/data/stations.js

const stations = [
  {
    id: "station_welding_1",
    name: "Крым АвтоСварка",
    city: "Севастополь",
    address: "Севастополь, ул. Индустриальная, 12",
    services: ["Автосварщик", "Кузовной ремонт", "Антикоррозийная обработка"],
    rating: 4.9,
    reviews: 127,
    distanceKm: 2.4,
    photoUrl: "https://picsum.photos/400/300?random=21",
    availableSlots: ["Завтра 10:00", "Завтра 14:30", "Завтра 18:00"],
  },
  {
    id: "station_gearbox_1",
    name: "АКПП Сервис Юг",
    city: "Севастополь",
    address: "Севастополь, ул. Руднева, 41",
    services: ["Ремонт АКПП", "Ремонт МКПП", "Диагностика"],
    rating: 4.8,
    reviews: 89,
    distanceKm: 3.8,
    photoUrl: "https://picsum.photos/400/300?random=22",
    availableSlots: ["Завтра 11:30", "Завтра 16:00"],
  },
  {
    id: "station_glass_1",
    name: "АвтоСтекло Севастополь",
    city: "Севастополь",
    address: "Севастополь, пр-т Победы, 88",
    services: ["Замена стекол", "Установка лобового стекла"],
    rating: 4.7,
    reviews: 103,
    distanceKm: 5.1,
    photoUrl: "https://picsum.photos/400/300?random=23",
    availableSlots: ["Завтра 09:30", "Завтра 13:00"],
  },
  {
    id: "station_diagnostics_1",
    name: "Диагностика 24",
    city: "Севастополь",
    address: "Севастополь, ул. Генерала Острякова, 155",
    services: ["Диагностика", "Автоэлектрик", "Ремонт двигателя"],
    rating: 4.8,
    reviews: 211,
    distanceKm: 1.9,
    photoUrl: "https://picsum.photos/400/300?random=24",
    availableSlots: ["Завтра 10:00", "Завтра 12:30", "Завтра 17:00"],
  },
  {
    id: "station_tire_1",
    name: "Шиномонтаж Express",
    city: "Севастополь",
    address: "Севастополь, Камышовое шоссе, 7",
    services: ["Шиномонтаж", "Выездной шиномонтаж", "Развал-схождение"],
    rating: 4.6,
    reviews: 76,
    distanceKm: 4.4,
    photoUrl: "https://picsum.photos/400/300?random=25",
    availableSlots: ["Завтра 09:00", "Завтра 15:30"],
  }
];

function findStationsByService(serviceTitle) {
  const target = String(serviceTitle || "").toLowerCase();

  return stations
    .filter((station) =>
      station.services.some((service) =>
        service.toLowerCase().includes(target) || target.includes(service.toLowerCase())
      )
    )
    .map((station) => ({
      id: station.id,
      name: station.name,
      city: station.city,
      address: station.address,
      service: serviceTitle,
      rating: station.rating,
      reviews: station.reviews,
      distanceKm: station.distanceKm,
      photoUrl: station.photoUrl,
      availableSlots: station.availableSlots,
    }));
}

module.exports = {
  stations,
  findStationsByService,
};
