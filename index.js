/**
 * WedPlan REST API — Express server entry point.
 *
 * Start with:   npm run dev     (auto restart)
 *               npm start       (production)
 */
// Load the server-local .env before modules read database or payment settings.
import "./src/load-env.js";

import express from "express";
import cors from "cors";

import { connectToDatabase } from "./src/db.js";
import { errorHandler, notFoundHandler } from "./src/middleware/error.js";

import servicesRouter from "./src/routes/services.js";
import vendorRouter from "./src/routes/vendor.js";
import bookingsRouter from "./src/routes/bookings.js";
import adminRouter from "./src/routes/admin.js";
import profileRouter from "./src/routes/profile.js";
import statsRouter from "./src/routes/stats.js";
import uploadRouter from "./src/routes/upload.js";
import paymentsRouter, { stripeWebhook } from "./src/routes/payments.js";

const app = express();

if (!process.env.JWT_SECRET) {
  throw new Error("Missing JWT_SECRET. Set the same private secret on the Next.js app and API server.");
}

const allowedClientOrigins = new Set(
  [process.env.CLIENT_URL || "http://localhost:3000", ...(process.env.CLIENT_ORIGINS || "").split(",")]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin),
);

// CORS — only the Next.js client may call this API
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedClientOrigins.has(origin));
    },
    credentials: true,
  }),
);

// Stripe sends a signed raw body — it must be captured BEFORE express.json()
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), stripeWebhook);

// Normal JSON bodies for everything else
app.use(express.json({ limit: "10mb" }));

/** Simple health check. */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Route groups
app.use("/api/services", servicesRouter); // public
app.use("/api/vendor", vendorRouter); // vendor dashboard
app.use("/api/bookings", bookingsRouter); // customers + vendors
app.use("/api/admin", adminRouter); // admin dashboard
app.use("/api/profile", profileRouter); // any signed-in user
app.use("/api/stats", statsRouter); // overview numbers per role
app.use("/api/upload", uploadRouter); // ImgBB image upload
app.use("/api/payments", paymentsRouter); // Stripe checkout

// Unknown routes + centralized error handling
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectToDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WedPlan API listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Could not connect to MongoDB:", error);
    process.exit(1);
  });
