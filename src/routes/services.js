/**
 * Public service routes — no sign-in required.
 *
 * Only services that an admin approved AND that are active are shown here.
 * Rejected / pending / inactive services never reach the Browse page.
 */
import { Router } from "express";
import { servicesCollection } from "../db.js";
import { asyncHandler, ApiError, contains, toObjectId } from "../utils.js";

const router = Router();

/** Vendor fields we attach to every service. */
const VENDOR_LOOKUP = {
  from: "user",
  localField: "vendorId",
  foreignField: "_id",
  as: "vendorId",
  pipeline: [
    {
      $project: {
        name: 1,
        image: 1,
        businessName: 1,
        subscription: 1,
        subscriptionPlan: 1,
        subscriptionExpiresAt: 1,
      },
    },
  ],
};

/** The rule that hides unfinished services from customers. */
const PUBLIC_FILTER = {
  status: "approved",
  isActive: { $ne: false },
};

const PREMIUM_RANK = {
  $cond: [
    {
      $and: [
        {
          $or: [
            { $eq: ["$vendorId.subscriptionPlan", "premium"] },
            {
              $and: [
                { $eq: [{ $ifNull: ["$vendorId.subscriptionPlan", null] }, null] },
                { $eq: ["$vendorId.subscription", "premium"] },
              ],
            },
          ],
        },
        {
          $or: [
            { $eq: [{ $ifNull: ["$vendorId.subscriptionExpiresAt", ""] }, ""] },
            {
              $gt: [
                {
                  $dateFromString: {
                    dateString: "$vendorId.subscriptionExpiresAt",
                    onError: new Date(0),
                    onNull: new Date(0),
                  },
                },
                "$$NOW",
              ],
            },
          ],
        },
      ],
    },
    1,
    0,
  ],
};

function toPublicVendor(vendor) {
  if (!vendor) return null;
  const legacyPremium = !vendor.subscriptionPlan && vendor.subscription === "premium";
  const expiry = vendor.subscriptionExpiresAt ? new Date(vendor.subscriptionExpiresAt).getTime() : null;
  const isPremium = (vendor.subscriptionPlan === "premium" || legacyPremium) &&
    (expiry === null || (Number.isFinite(expiry) && expiry > Date.now()));
  return {
    ...vendor,
    subscriptionPlan: isPremium ? "premium" : "free",
    subscription: isPremium ? "premium" : "free",
  };
}

/**
 * GET /api/services?search=&category=&location=&sort=price-asc
 * Returns every publicly visible service with its vendor populated.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search = "", category = "", location = "", sort = "" } = req.query;

    const filter = { ...PUBLIC_FILTER };

    // Free-text search across the main fields
    if (String(search).trim()) {
      const rx = contains(search);
      filter.$or = [
        { serviceName: rx },
        { description: rx },
        { category: rx },
        { location: rx },
      ];
    }

    if (String(category).trim() && category !== "all") {
      filter.category = String(category).trim();
    }

    if (String(location).trim()) {
      filter.location = contains(location);
    }

    let sortOption = { _premiumRank: -1, createdAt: -1, _id: -1 };
    if (sort === "price-asc") sortOption = { _premiumRank: -1, price: 1, createdAt: -1 };
    if (sort === "price-desc") sortOption = { _premiumRank: -1, price: -1, createdAt: -1 };

    const pipeline = [
      { $match: filter },
      { $lookup: VENDOR_LOOKUP },
      { $unwind: { path: "$vendorId", preserveNullAndEmptyArrays: true } },
      { $addFields: { _premiumRank: PREMIUM_RANK } },
      { $sort: sortOption },
    ];

    const services = await servicesCollection.aggregate(pipeline).toArray();

    res.json({
      services: services.map((service) => {
        const { _premiumRank, ...publicService } = service;
        return {
          ...publicService,
          _id: service._id.toString(),
          vendorId: service.vendorId
            ? { ...toPublicVendor(service.vendorId), _id: service.vendorId._id.toString() }
            : null,
        };
      }),
    });
  }),
);

/**
 * GET /api/services/featured
 * A small selection for the homepage.
 */
router.get(
  "/featured",
  asyncHandler(async (req, res) => {
    const pipeline = [
      { $match: PUBLIC_FILTER },
      { $lookup: VENDOR_LOOKUP },
      { $unwind: { path: "$vendorId", preserveNullAndEmptyArrays: true } },
      { $addFields: { _premiumRank: PREMIUM_RANK } },
      { $sort: { _premiumRank: -1, createdAt: -1, _id: -1 } },
      { $limit: 6 },
    ];

    const services = await servicesCollection.aggregate(pipeline).toArray();

    res.json({
      services: services.map((service) => {
        const { _premiumRank, ...publicService } = service;
        return {
          ...publicService,
          _id: service._id.toString(),
          vendorId: service.vendorId
            ? { ...toPublicVendor(service.vendorId), _id: service.vendorId._id.toString() }
            : null,
        };
      }),
    });
  }),
);

/**
 * GET /api/services/:id
 * Service details — same public visibility rules as the list.
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "Invalid service id.");
    const service = await servicesCollection.findOne({ _id, ...PUBLIC_FILTER });

    if (!service) {
      throw new ApiError(404, "Service not found or not available.");
    }

    let vendor = null;
    if (service.vendorId) {
      const found = await servicesCollection.db
        .collection("user")
        .findOne(
          { _id: service.vendorId },
          { projection: { name: 1, image: 1, businessName: 1, subscription: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } },
        );
    if (found) vendor = { ...toPublicVendor(found), _id: found._id.toString() };
    }

    res.json({
      service: {
        ...service,
        _id: service._id.toString(),
        vendorId: vendor,
      },
    });
  }),
);

export default router;
