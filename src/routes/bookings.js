/**
 * Booking routes.
 *
 * Customers send a booking request from the service details page.
 * Vendors accept / reject the requests that arrive for their services.
 * Every rule below is also reflected in the UI, but is enforced here.
 */
import { Router } from "express";
import { bookingsCollection, servicesCollection, usersCollection } from "../db.js";
import { asyncHandler, ApiError, readString, toObjectId } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

/** Statuses that still count as "active" (used for duplicate checks). */
const ACTIVE_STATUSES = ["pending", "accepted"];

/** Adds the service, the customer and the vendor to a booking document. */
async function populateBooking(booking) {
  const [service, customer, vendor] = await Promise.all([
    servicesCollection.findOne(
      { _id: booking.serviceId },
      { projection: { serviceName: 1, category: 1, price: 1, images: 1, location: 1 } },
    ),
    usersCollection.findOne(
      { _id: booking.customerId },
      { projection: { name: 1, email: 1, image: 1 } },
    ),
    usersCollection.findOne(
      { _id: booking.vendorId },
      { projection: { name: 1, email: 1, image: 1, businessName: 1 } },
    ),
  ]);

  return {
    ...booking,
    _id: booking._id.toString(),
    serviceId: service ? { ...service, _id: service._id.toString() } : null,
    customerId: customer ? { ...customer, _id: customer._id.toString() } : null,
    vendorId: vendor ? { ...vendor, _id: vendor._id.toString() } : null,
  };
}

/** Loads a booking and checks that the signed-in user owns it. */
async function findBooking(bookingId) {
  const _id = toObjectId(bookingId, "Invalid booking id.");
  const booking = await bookingsCollection.findOne({ _id });
  if (!booking) throw new ApiError(404, "Booking not found.");
  return booking;
}

/* ------------------------------------------------------------------ */
/* Customer: create a booking request                                  */
/* ------------------------------------------------------------------ */

/**
 * POST /api/bookings
 * Body: { serviceId, eventDate, eventLocation, message }
 */
router.post(
  "/",
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const serviceId = readString(req.body, "serviceId", { maxLength: 50 });
    const eventDate = readString(req.body, "eventDate", { maxLength: 20 });
    const eventLocation = readString(req.body, "eventLocation", { maxLength: 200 });
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (message.length > 2000) throw new ApiError(400, "Message must be at most 2000 characters.");

    // The event date must be a real date (the form sends YYYY-MM-DD)
    const dateObject = new Date(`${eventDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
      Number.isNaN(dateObject.getTime()) ||
      dateObject.toISOString().slice(0, 10) !== eventDate
    ) {
      throw new ApiError(400, "Please provide a valid event date.");
    }

    const _id = toObjectId(serviceId, "Invalid service id.");
    const service = await servicesCollection.findOne({ _id });

    if (!service || service.status !== "approved" || service.isActive === false) {
      throw new ApiError(404, "This service is not available for booking.");
    }

    const customerId = toObjectId(req.userId);

    // Vendors cannot book their own services
    if (service.vendorId?.toString() === req.userId) {
      throw new ApiError(403, "You cannot book your own service.");
    }

    // One active booking per service + event date
    const duplicate = await bookingsCollection.findOne({
      serviceId: _id,
      eventDate,
      status: { $in: ACTIVE_STATUSES },
    });

    if (duplicate) {
      throw new ApiError(
        409,
        "This service already has an active booking for the selected event date.",
      );
    }

    const now = new Date();
    const document = {
      serviceId: _id,
      customerId,
      vendorId: service.vendorId,
      eventDate,
      activeBookingKey: `${_id.toString()}:${eventDate}`,
      eventLocation,
      message,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const result = await bookingsCollection.insertOne(document);

    res.status(201).json({
      message: "The vendor will review and accept or reject your request.",
      booking: { ...document, _id: result.insertedId.toString() },
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Customer: my bookings                                               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/bookings/mine
 */
router.get(
  "/mine",
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const bookings = await bookingsCollection
      .find({ customerId: toObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    const populated = await Promise.all(bookings.map(populateBooking));

    res.json({ bookings: populated });
  }),
);

/* ------------------------------------------------------------------ */
/* Vendor: incoming requests                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/bookings/requests
 */
router.get(
  "/requests",
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const bookings = await bookingsCollection
      .find({ vendorId: toObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    const populated = await Promise.all(bookings.map(populateBooking));

    res.json({ bookings: populated });
  }),
);

/* ------------------------------------------------------------------ */
/* Vendor: accept / reject                                             */
/* ------------------------------------------------------------------ */

/** Shared logic for accept & reject. */
async function updateRequestStatus(req, res, newStatus) {
  const booking = await findBooking(req.params.id);

  // Only the vendor of this booking may process it
  if (booking.vendorId?.toString() !== req.userId) {
    throw new ApiError(403, "You can only process requests for your own services.");
  }

  // Only pending requests can be processed — never twice
  if (booking.status !== "pending") {
    throw new ApiError(
      400,
      `This request has already been processed (status: ${booking.status}).`,
    );
  }

  const updated = await bookingsCollection.updateOne(
    { _id: booking._id, vendorId: toObjectId(req.userId), status: "pending" },
    newStatus === "rejected"
      ? { $set: { status: newStatus, updatedAt: new Date() }, $unset: { activeBookingKey: "" } }
      : { $set: { status: newStatus, updatedAt: new Date() } },
  );
  if (updated.modifiedCount === 0) {
    throw new ApiError(409, "This booking request has already been processed.");
  }

  res.json({
    message:
      newStatus === "accepted"
        ? "Booking request accepted."
        : "Booking request rejected.",
    status: newStatus,
  });
}

/** PATCH /api/bookings/:id/accept */
router.patch(
  "/:id/accept",
  requireRole("vendor"),
  asyncHandler((req, res) => updateRequestStatus(req, res, "accepted")),
);

/** PATCH /api/bookings/:id/reject */
router.patch(
  "/:id/reject",
  requireRole("vendor"),
  asyncHandler((req, res) => updateRequestStatus(req, res, "rejected")),
);

/* ------------------------------------------------------------------ */
/* Customer: cancel                                                    */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/bookings/:id/cancel
 * Customers may only cancel while the request is still pending.
 */
router.patch(
  "/:id/cancel",
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const booking = await findBooking(req.params.id);

    if (booking.customerId?.toString() !== req.userId) {
      throw new ApiError(403, "You can only cancel your own bookings.");
    }
    if (booking.status !== "pending") {
      throw new ApiError(400, "Only pending requests can be cancelled.");
    }

    const updated = await bookingsCollection.updateOne(
      { _id: booking._id, customerId: toObjectId(req.userId), status: "pending" },
      { $set: { status: "cancelled", updatedAt: new Date() }, $unset: { activeBookingKey: "" } },
    );
    if (updated.modifiedCount === 0) {
      throw new ApiError(409, "This booking request has already been processed.");
    }

    res.json({ message: "Booking request cancelled.", status: "cancelled" });
  }),
);

/* ------------------------------------------------------------------ */
/* Details (customer or vendor of that booking)                        */
/* ------------------------------------------------------------------ */

/**
 * GET /api/bookings/:id
 */
router.get(
  "/:id",
  requireRole("customer", "vendor"),
  asyncHandler(async (req, res) => {
    const booking = await findBooking(req.params.id);

    const isCustomer = booking.customerId?.toString() === req.userId;
    const isVendor = booking.vendorId?.toString() === req.userId;
    if (!isCustomer && !isVendor) {
      throw new ApiError(403, "You do not have access to this booking.");
    }

    res.json({ booking: await populateBooking(booking) });
  }),
);

export default router;
