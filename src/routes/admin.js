/**
 * Admin routes — user, service and transaction management.
 * Every route requires the "admin" role (checked server-side).
 */
import { Router } from "express";
import {
  usersCollection,
  servicesCollection,
  bookingsCollection,
  transactionsCollection,
} from "../db.js";
import { asyncHandler, ApiError, contains, toObjectId, currentSubscriptionPlan } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

// Admin only — from here on
router.use(requireRole("admin"));

/* ------------------------------------------------------------------ */
/* Overview statistics                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/stats
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const [
      totalUsers,
      totalVendors,
      totalCustomers,
      totalServices,
      pendingServices,
      transactionCount,
      revenueResult,
    ] = await Promise.all([
      usersCollection.countDocuments({}),
      usersCollection.countDocuments({ role: "vendor" }),
      usersCollection.countDocuments({ role: "customer" }),
      servicesCollection.countDocuments({}),
      servicesCollection.countDocuments({ status: "pending" }),
      transactionsCollection.countDocuments({}),
      transactionsCollection
        .aggregate([
          { $match: { status: "succeeded" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
    ]);

    res.json({
      totalUsers,
      totalVendors,
      totalCustomers,
      totalServices,
      pendingServices,
      transactions: transactionCount,
      revenue: revenueResult[0]?.total ?? 0,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Manage users                                                        */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/users?search=ayman&role=vendor
 * Search by name or e-mail and filter by role.
 */
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? "").trim();
    const role = String(req.query.role ?? "").trim();

    const filter = {};
    if (search) {
      const rx = contains(search);
      filter.$or = [{ name: rx }, { email: rx }];
    }
    if (["customer", "vendor", "admin"].includes(role)) {
      filter.role = role;
    }

    const users = await usersCollection
      .find(filter, {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          subscription: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          isBlocked: 1,
          createdAt: 1,
          businessName: 1,
        },
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      users: users.map((user) => ({
        ...user,
        subscription: currentSubscriptionPlan(user),
        subscriptionPlan: currentSubscriptionPlan(user),
        _id: user._id.toString(),
      })),
    });
  }),
);

/**
 * PATCH /api/admin/users/:id/block
 * Body: { isBlocked: true | false }
 * A blocked user loses access to every protected route immediately.
 */
router.patch(
  "/users/:id/block",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "Invalid user id.");
    const isBlocked = req.body?.isBlocked;

    if (typeof isBlocked !== "boolean") {
      throw new ApiError(400, '"isBlocked" must be true or false.');
    }

    const user = await usersCollection.findOne({ _id });
    if (!user) throw new ApiError(404, "User not found.");

    // Never allow blocking another admin (or yourself)
    if (user.role === "admin") {
      throw new ApiError(403, "Admin accounts cannot be blocked.");
    }

    await usersCollection.updateOne({ _id }, { $set: { isBlocked } });

    res.json({
      message: isBlocked
        ? `${user.name} has been blocked.`
        : `${user.name} has been unblocked.`,
      isBlocked,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Manage services                                                     */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/services?search=&status=&category=
 * Includes pending services so an admin can review them.
 */
router.get(
  "/services",
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const category = String(req.query.category ?? "").trim();

    const filter = {};
    if (search) {
      const rx = contains(search);
      filter.$or = [{ serviceName: rx }, { location: rx }, { category: rx }];
    }
    if (["pending", "approved", "rejected"].includes(status)) {
      filter.status = status;
    }
    if (category) filter.category = category;

    const services = await servicesCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    // Attach the vendor + small booking stats for the review screen
    const vendorIds = [
      ...new Set(services.map((service) => service.vendorId?.toString()).filter(Boolean)),
    ];
    const vendors = await usersCollection
      .find(
        { _id: { $in: vendorIds.map((id) => toObjectId(id)) } },
        { projection: { name: 1, email: 1, businessName: 1, image: 1 } },
      )
      .toArray();
    const vendorMap = new Map(
      vendors.map((vendor) => [vendor._id.toString(), vendor]),
    );

    res.json({
      services: services.map((service) => ({
        ...service,
        _id: service._id.toString(),
        vendorId: service.vendorId
          ? {
              ...vendorMap.get(service.vendorId.toString()),
              _id: service.vendorId.toString(),
            }
          : null,
      })),
    });
  }),
);

/**
 * PATCH /api/admin/services/:id/status
 * Body: { status: "approved" | "rejected" | "pending" }
 */
router.patch(
  "/services/:id/status",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "Invalid service id.");
    const status = req.body?.status;

    if (!["pending", "approved", "rejected"].includes(status)) {
      throw new ApiError(400, "Status must be pending, approved or rejected.");
    }

    if (status === "approved") {
      const service = await servicesCollection.findOne({ _id });
      if (!service) throw new ApiError(404, "Service not found.");
      const vendor = await usersCollection.findOne({ _id: service.vendorId });
      if (vendor && currentSubscriptionPlan(vendor) === "free" && service.isActive !== false) {
        const activeCount = await servicesCollection.countDocuments({
          vendorId: service.vendorId,
          status: "approved",
          isActive: { $ne: false },
          _id: { $ne: _id },
        });
        if (activeCount >= 3) {
          throw new ApiError(403, "This vendor has reached the free-plan limit of 3 active services. They must upgrade to Premium before another service can be published.");
        }
      }
    }

    const result = await servicesCollection.updateOne(
      { _id },
      { $set: { status, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) throw new ApiError(404, "Service not found.");

    const messages = {
      approved: "Service approved — it is now visible to customers.",
      rejected: "Service rejected — customers can no longer see it.",
      pending: "Service moved back to pending review.",
    };

    res.json({ message: messages[status], status });
  }),
);

/**
 * PATCH /api/admin/services/:id/availability
 * Body: { isActive: true | false }
 */
router.patch(
  "/services/:id/availability",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "Invalid service id.");
    const isActive = req.body?.isActive;

    if (typeof isActive !== "boolean") {
      throw new ApiError(400, '"isActive" must be true or false.');
    }

    if (isActive) {
      const service = await servicesCollection.findOne({ _id });
      if (!service) throw new ApiError(404, "Service not found.");
      if (service.status === "approved") {
        const vendor = await usersCollection.findOne({ _id: service.vendorId });
        if (vendor && currentSubscriptionPlan(vendor) === "free") {
          const activeCount = await servicesCollection.countDocuments({
            vendorId: service.vendorId,
            status: "approved",
            isActive: { $ne: false },
            _id: { $ne: _id },
          });
          if (activeCount >= 3) {
            throw new ApiError(403, "The vendor must upgrade to Premium before activating more than 3 services.");
          }
        }
      }
    }

    const result = await servicesCollection.updateOne(
      { _id },
      { $set: { isActive, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) throw new ApiError(404, "Service not found.");

    res.json({ message: "Availability updated.", isActive });
  }),
);

/**
 * DELETE /api/admin/services/:id
 */
router.delete(
  "/services/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "Invalid service id.");

    const result = await servicesCollection.deleteOne({ _id });
    if (result.deletedCount === 0) throw new ApiError(404, "Service not found.");

    // Remove bookings that belong to the deleted service
    await bookingsCollection.deleteMany({ serviceId: _id });

    res.json({ message: "Service deleted." });
  }),
);

/* ------------------------------------------------------------------ */
/* Transactions (read-only)                                            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/transactions
 * Payment records are never modified by the admin dashboard.
 */
router.get(
  "/transactions",
  asyncHandler(async (req, res) => {
    const transactions = await transactionsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const vendorIds = [
      ...new Set(
        transactions
          .map((transaction) => transaction.vendorId?.toString())
          .filter(Boolean),
      ),
    ];
    const vendors = await usersCollection
      .find(
        { _id: { $in: vendorIds.map((id) => toObjectId(id)) } },
        { projection: { name: 1, email: 1, businessName: 1 } },
      )
      .toArray();
    const vendorMap = new Map(vendors.map((vendor) => [vendor._id.toString(), vendor]));

    res.json({
      transactions: transactions.map((transaction) => ({
        ...transaction,
        _id: transaction._id.toString(),
        vendorId: transaction.vendorId
          ? {
              ...vendorMap.get(transaction.vendorId.toString()),
              _id: transaction.vendorId.toString(),
            }
          : null,
      })),
    });
  }),
);

export default router;
