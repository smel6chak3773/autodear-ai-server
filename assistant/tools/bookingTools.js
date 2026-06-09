// server/assistant/tools/bookingTools.js

const bookingDrafts = new Map();

const BOOKING_STATUS = {
  DRAFT: "draft",
  CUSTOMER_CONFIRMED: "customer_confirmed",
  BUSINESS_PENDING: "business_pending",
  BUSINESS_CONFIRMED: "business_confirmed",
  BUSINESS_RESCHEDULED: "business_rescheduled",
  CUSTOMER_ACCEPTED_NEW_TIME: "customer_accepted_new_time",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};

function createBookingDraft(input = {}) {
  const draftId = `booking_draft_${Date.now()}`;

  const draft = {
    id: draftId,
    userId: input.userId || "guest_demo",
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    slot: input.slot,
    proposedSlot: null,
    status: BOOKING_STATUS.DRAFT,
    createdAt: new Date().toISOString(),
    customerConfirmedAt: null,
    businessConfirmedAt: null,
    businessRescheduledAt: null,
    customerAcceptedNewTimeAt: null,
    rejectedAt: null,
    cancelledAt: null,
  };

  bookingDrafts.set(draftId, draft);

  return draft;
}

function getBookingDraft(id) {
  return bookingDrafts.get(id);
}

function getLatestBookingDraftForUser(userId = "guest_demo") {
  const drafts = Array.from(bookingDrafts.values())
    .filter((item) => item.userId === userId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  return drafts[0] || null;
}

function customerConfirmBooking(id) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    status: BOOKING_STATUS.BUSINESS_PENDING,
    customerConfirmedAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

function businessConfirmBooking(id) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    status: BOOKING_STATUS.BUSINESS_CONFIRMED,
    businessConfirmedAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

function businessRescheduleBooking(id, proposedSlot) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    status: BOOKING_STATUS.BUSINESS_RESCHEDULED,
    proposedSlot,
    businessRescheduledAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

function customerAcceptNewTime(id) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    slot: draft.proposedSlot || draft.slot,
    proposedSlot: null,
    status: BOOKING_STATUS.CUSTOMER_ACCEPTED_NEW_TIME,
    customerAcceptedNewTimeAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

function rejectBooking(id) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    status: BOOKING_STATUS.REJECTED,
    rejectedAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

function cancelBooking(id) {
  const draft = bookingDrafts.get(id);

  if (!draft) return null;

  const updated = {
    ...draft,
    status: BOOKING_STATUS.CANCELLED,
    cancelledAt: new Date().toISOString(),
  };

  bookingDrafts.set(id, updated);

  return updated;
}

module.exports = {
  BOOKING_STATUS,
  createBookingDraft,
  getBookingDraft,
  getLatestBookingDraftForUser,
  customerConfirmBooking,
  businessConfirmBooking,
  businessRescheduleBooking,
  customerAcceptNewTime,
  rejectBooking,
  cancelBooking,
};
