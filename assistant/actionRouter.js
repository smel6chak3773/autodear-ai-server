// assistant/actionRouter.js

function buildAction(intent, toolData = {}) {
  if (toolData.services?.length) {
    return {
      type: "SHOW_SERVICES",
      payload: {
        services: toolData.services,
      },
    };
  }

  if (toolData.bookingDraft) {
    return {
      type: "SHOW_BOOKING_DRAFT",
      payload: {
        booking: toolData.bookingDraft,
      },
    };
  }

  if (toolData.customerConfirmedBooking) {
    return {
      type: "BOOKING_SENT",
      payload: {
        booking: toolData.customerConfirmedBooking,
      },
    };
  }

  if (intent === "create_listing") {
    return {
      type: "OPEN_SCREEN",
      payload: {
        route: "/listing/category",
      },
    };
  }

  if (intent === "parts_search") {
    return {
      type: "OPEN_SCREEN",
      payload: {
        route: "/parts",
      },
    };
  }

  return null;
}

module.exports = {
  buildAction,
};
