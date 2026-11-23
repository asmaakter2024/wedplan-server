/**
 * GET /api/stats
 * One endpoint, three answers: the overview numbers of whichever role
 * is signed in (customer / vendor / admin).
 */
import { Router } from "express";
import {
  usersCollection,
  servicesCollection,
  bookingsCollection,
  transactionsCollection,
} from "../db.js";
import { asyncHandler, toObjectId, currentSubscriptionPlan } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

router.get(
  "/",
  requireRole("customer", "vendor", "admin"),
  asyncHandler(async (req, res) => {
    const userId = toObjectId(req.userId);

    /* Customer ---------------------------------------------------- */
    if (req.role === "customer") {
      const [totalBookings, pendingBookings, acceptedBookings, rejectedBookings] =
        await Promise.all([
          bookingsCollection.countDocuments({ customerId: userId }),
          bookingsCollection.countDocuments({ customerId: userId, status: "pending" }),
          bookingsCollection.countDocuments({ customerId: userId, status: "accepted" }),
          bookingsCollection.countDocuments({ customerId: userId, status: "rejected" }),
        ]);

      return res.json({
        role: "customer",
        totalBookings,
        pendingBookings,
        acceptedBookings,
        rejectedBookings,
      });
    }

    /* Vendor ------------------------------------------------------ */
    if (req.role === "vendor") {
      const [totalServices, activeServices, pendingRequests, acceptedBookings] =
        await Promise.all([
          servicesCollection.countDocuments({ vendorId: userId }),
          servicesCollection.countDocuments({
            vendorId: userId,
            status: "approved",
            isActive: { $ne: false },
          }),
          bookingsCollection.countDocuments({ vendorId: userId, status: "pending" }),
          bookingsCollection.countDocuments({ vendorId: userId, status: "accepted" }),
        ]);

      return res.json({
        role: "vendor",
        totalServices,
        activeServices,
        pendingRequests,
        acceptedBookings,
        plan: currentSubscriptionPlan(req.user),
      });
    }

    /* Admin ------------------------------------------------------- */
    const [totalUsers, totalVendors, totalCustomers, totalServices, pendingServices] =
      await Promise.all([
        usersCollection.countDocuments({}),
        usersCollection.countDocuments({ role: "vendor" }),
        usersCollection.countDocuments({ role: "customer" }),
        servicesCollection.countDocuments({}),
        servicesCollection.countDocuments({ status: "pending" }),
      ]);

    const revenueResult = await transactionsCollection
      .aggregate([
        { $match: { status: "succeeded" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ])
      .toArray();

    res.json({
      role: "admin",
      totalUsers,
      totalVendors,
      totalCustomers,
      totalServices,
      pendingServices,
      transactions: await transactionsCollection.countDocuments({}),
      revenue: revenueResult[0]?.total ?? 0,
    });
  }),
);

export default router;
