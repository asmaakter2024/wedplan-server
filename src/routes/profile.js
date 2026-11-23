/**
 * Profile routes — available to every signed-in user.
 *
 * A user can edit their personal details, but NEVER their role or their
 * subscription plan (those are changed by the admin / Stripe webhook).
 */
import { Router } from "express";
import { usersCollection } from "../db.js";
import { asyncHandler, ApiError, toObjectId } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

/** Fields a user is allowed to change about themselves. */
const EDITABLE_FIELDS = ["name", "image", "businessName", "phone", "address", "bio"];

/**
 * GET /api/profile
 */
router.get(
  "/",
  requireRole(),
  asyncHandler(async (req, res) => {
    const user = await usersCollection.findOne(
      { _id: toObjectId(req.userId) },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          businessName: 1,
          phone: 1,
          address: 1,
          bio: 1,
          subscription: 1,
          isBlocked: 1,
          createdAt: 1,
        },
      },
    );

    if (!user) throw new ApiError(404, "Account not found.");

    res.json({ user: { ...user, _id: user._id.toString() } });
  }),
);

/**
 * PUT /api/profile
 * Body: { name, image, businessName, phone, address, bio }
 */
router.put(
  "/",
  requireRole(),
  asyncHandler(async (req, res) => {
    const updates = {};

    for (const field of EDITABLE_FIELDS) {
      const raw = req.body?.[field];
      if (raw === undefined || raw === null) continue;

      const value = typeof raw === "string" ? raw.trim() : "";

      if (field === "name") {
        if (!value) throw new ApiError(400, "Name cannot be empty.");
        if (value.length > 100) throw new ApiError(400, "Name is too long.");
      }
      if (field === "image" && value && !value.startsWith("http")) {
        throw new ApiError(400, "Profile image must be a valid URL.");
      }
      if (value.length > 500) {
        throw new ApiError(400, `"${field}" is too long.`);
      }

      updates[field] = value;
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    await usersCollection.updateOne(
      { _id: toObjectId(req.userId) },
      { $set: updates },
    );

    res.json({ message: "Profile updated successfully." });
  }),
);

export default router;
