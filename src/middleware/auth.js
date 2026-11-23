/**
 * Authentication & role middleware.
 *
 * Flow:
 *   1. The Next.js client asks /api/auth/token for a short-lived JWT.
 *   2. The client sends it as "Authorization: Bearer <token>".
 *   3. We verify the signature, then reload the user from MongoDB so that
 *      a blocked account or a changed role is always respected.
 */
import jwt from "jsonwebtoken";
import { usersCollection, ObjectId } from "../db.js";
import { ApiError } from "../utils.js";

/** Returns the raw token from the Authorization header (or null). */
function readToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

/**
 * Usage:  router.get("/path", requireRole("vendor"), handler)
 *         router.post("/path", requireRole("customer", "admin"), handler)
 *
 * With no arguments the user only needs to be signed in.
 */
export function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const token = readToken(req);
      if (!token) {
        throw new ApiError(401, "Please sign in to continue.");
      }

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        throw new ApiError(401, "Your session has expired. Please sign in again.");
      }

      if (!payload?.userId || !/^[a-f0-9]{24}$/i.test(payload.userId)) {
        throw new ApiError(401, "Invalid session. Please sign in again.");
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(payload.userId) });
      if (!user) {
        throw new ApiError(401, "Account not found. Please sign in again.");
      }
      if (user.isBlocked) {
        throw new ApiError(403, "This account has been blocked. Contact support.");
      }

      const role = user.role || "customer";
      if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        throw new ApiError(403, "You do not have permission to do this.");
      }

      // Handy values for the route handlers
      req.user = user;
      req.userId = user._id.toString();
      req.role = role;
      next();
    } catch (error) {
      next(error);
    }
  };
}
