// server/assistant/tools/serviceTools.js

function findServices(query = "") {
  return [
    {
      id: "service_1",
      name: "AUTODEAR Glass Service",
      city: "Краснодар",
      address: "Краснодар, ул. Российская, 267",
      service: "Замена лобового стекла",
      rating: 4.9,
      reviews: 127,
      distanceKm: 2.4,
      photoUrl: "https://picsum.photos/400/300?random=1",
      availableSlots: ["Завтра 10:00", "Завтра 14:30", "Завтра 18:00"],
    },
    {
      id: "service_2",
      name: "СТО Комфорт",
      city: "Краснодар",
      address: "Краснодар, ул. Солнечная, 45",
      service: "Автостекла",
      rating: 4.7,
      reviews: 89,
      distanceKm: 3.8,
      photoUrl: "https://picsum.photos/400/300?random=2",
      availableSlots: ["Завтра 11:30", "Завтра 16:00"],
    },
    {
      id: "service_3",
      name: "Мастер Лобовое",
      city: "Краснодар",
      address: "Краснодар, ул. Восточная, 120",
      service: "Замена и ремонт стекол",
      rating: 4.8,
      reviews: 103,
      distanceKm: 5.1,
      photoUrl: "https://picsum.photos/400/300?random=3",
      availableSlots: ["Завтра 09:30", "Завтра 13:00"],
    },
  ];
}

module.exports = {
  findServices,
};
