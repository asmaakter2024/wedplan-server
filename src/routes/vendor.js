/**
 * Vendor routes — manage the vendor's own services.
 * Everything here requires the "vendor" role (checked server-side).
 */
import { Router } from "express";
import { servicesCollection, usersCollection, bookingsCollection } from "../db.js";
import {
  asyncHandler,
  ApiError,
  readString,
  readNumber,
  toObjectId,
} from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

// Every route in this file is vendor-only
router.use(requireRole("vendor"));

/** Free plan can keep up to this many services. Premium has no limit. */
const FREE_PLAN_SERVICE_LIMIT = 3;

/** The service fields a vendor is allowed to send. */
function readServiceInput(body) {
  return {
    serviceName: readString(body, "serviceName", { maxLength: 150 }),
    category: readString(body, "category", { maxLength: 100 }),
    description: readString(body, "description", { maxLength: 3000 }),
    price: readNumber(body, "price", { min: 1, max: 1000000 }),
    location: readString(body, "location", { maxLength: 200 }),
    images: Array.isArray(body?.images)
      ? body.images.filter((url) => typeof url === "string" && url.startsWith("http")).slice(0, 5)
      : [],
  };
}

/** Loads one service and makes sure it belongs to the signed-in vendor. */
async function findOwnService(serviceId, vendorId) {
  const _id = toObjectId(serviceId, "Invalid service id.");
  const service = await servicesCollection.findOne({ _id });

  if (!service) throw new ApiError(404, "Service not found.");
  if (service.vendorId?.toString() !== vendorId) {
    throw new ApiError(403, "You can only manage your own services.");
  }
  return service;
}

/**
 * GET /api/vendor/services
 * Every service of the signed-in vendor (any status).
 */
router.get(
  "/services",
  asyncHandler(async (req, res) => {
    const services = await servicesCollection
      .find({ vendorId: toObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      services: services.map((service) => ({ ...service, _id: service._id.toString() })),
      limit: FREE_PLAN_SERVICE_LIMIT,
      plan: req.user.subscription === "premium" ? "premium" : "free",
    });
  }),
);

/**
 * GET /api/vendor/stats
 * Numbers for the vendor overview page.
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const vendorId = toObjectId(req.userId);

    const [totalServices, activeServices, pendingRequests, acceptedBookings] =
      await Promise.all([
        servicesCollection.countDocuments({ vendorId }),
        servicesCollection.countDocuments({
          vendorId,
          status: "approved",
          isActive: { $ne: false },
        }),
        bookingsCollection.countDocuments({ vendorId, status: "pending" }),
        bookingsCollection.countDocuments({ vendorId, status: "accepted" }),
      ]);

    res.json({
      totalServices,
      activeServices,
      pendingRequests,
      acceptedBookings,
      plan: req.user.subscription === "premium" ? "premium" : "free",
    });
  }),
);

/**
 * POST /api/vendor/services
 * Creates a service — its status is always "pending" until an admin approves it.
 * Free plan: maximum 3 services. Premium: unlimited.
 */
router.post(
  "/services",
  asyncHandler(async (req, res) => {
    const input = readServiceInput(req.body);

    const plan = req.user.subscription === "premium" ? "premium" : "free";
    if (plan === "free") {
      const currentCount = await servicesCollection.countDocuments({
        vendorId: toObjectId(req.userId),
        status: { $ne: "rejected" },
      });

      if (currentCount >= FREE_PLAN_SERVICE_LIMIT) {
        throw new ApiError(
          403,
          `The free plan allows a maximum of ${FREE_PLAN_SERVICE_LIMIT} services. Upgrade to Premium for unlimited services.`,
        );
      }
    }

    const now = new Date();
    const document = {
      ...input,
      vendorId: toObjectId(req.userId),
      status: "pending", // waiting for admin approval
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const result = await servicesCollection.insertOne(document);

    res.status(201).json({
      message: "Service submitted. It will be visible after admin approval.",
      service: { ...document, _id: result.insertedId.toString() },
    });
  }),
);

/**
 * PUT /api/vendor/services/:id
 * Updates the content of one of the vendor's own services.
 * The approval status can only be changed by an admin.
 */
router.put(
  "/services/:id",
  asyncHandler(async (req, res) => {
    await findOwnService(req.params.id, req.userId);
    const input = readServiceInput(req.body);

    const result = await servicesCollection.updateOne(
      { _id: toObjectId(req.params.id) },
      { $set: { ...input, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) throw new ApiError(404, "Service not found.");

    res.json({ message: "Service updated successfully." });
  }),
);

/**
 * PATCH /api/vendor/services/:id/availability
 * Turns a service on/off for customers ("availability management").
 */
router.patch(
  "/services/:id/availability",
  asyncHandler(async (req, res) => {
    await findOwnService(req.params.id, req.userId);

    const isActive = req.body?.isActive;
    if (typeof isActive !== "boolean") {
      throw new ApiError(400, '"isActive" must be true or false.');
    }

    await servicesCollection.updateOne(
      { _id: toObjectId(req.params.id) },
      { $set: { isActive, updatedAt: new Date() } },
    );

    res.json({
      message: isActive
        ? "Service is now available for customers."
        : "Service is hidden from customers.",
    });
  }),
);

/**
 * DELETE /api/vendor/services/:id
 */
router.delete(
  "/services/:id",
  asyncHandler(async (req, res) => {
    await findOwnService(req.params.id, req.userId);

    await servicesCollection.deleteOne({ _id: toObjectId(req.params.id) });

    res.json({ message: "Service deleted." });
  }),
);

/**
 * GET /api/vendor/profile-completeness
 * Simple helper used by the subscription/profile pages.
 */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await usersCollection.findOne(
      { _id: toObjectId(req.userId) },
      { projection: { name: 1, email: 1, image: 1, businessName: 1, subscription: 1 } },
    );

    res.json({
      user: { ...user, _id: user._id.toString() },
      plan: user.subscription === "premium" ? "premium" : "free",
    });
  }),
);

export default router;
