/**
 * Stripe payment routes — upgrade a vendor account to Premium.
 *
 * Security rules applied here:
 *   - Only the signed-in vendor can create a checkout for THEMSELVES.
 *   - The secret key never leaves the server.
 *   - The frontend redirect is NEVER trusted: premium is activated only
 *     inside the verified webhook below.
 */
import Stripe from "stripe";
import { Router } from "express";
import { usersCollection, transactionsCollection } from "../db.js";
import { asyncHandler, ApiError, toObjectId } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

/** Price of the premium plan (Stripe works in cents). */
const PREMIUM_AMOUNT_CENTS = 4900;
const PREMIUM_AMOUNT = PREMIUM_AMOUNT_CENTS / 100; // stored as 49 in transactions
const CURRENCY = "usd";

/** Lazily created so the server still runs without a Stripe key. */
let stripeClient = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

/**
 * POST /api/payments/checkout
 * Creates a Stripe Checkout session and returns its URL.
 */
router.post(
  "/checkout",
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) {
      throw new ApiError(503, "Payments are not configured yet (missing Stripe key).");
    }

    if (req.user.subscription === "premium") {
      throw new ApiError(400, "Your account is already on the Premium plan.");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: PREMIUM_AMOUNT_CENTS,
            product_data: {
              name: "WedPlan Premium",
              description: "Unlimited services, priority placement and premium badges.",
            },
          },
        },
      ],
      // The vendor's id travels with the session — verified by the webhook
      metadata: { vendorId: req.userId, plan: "premium" },
      success_url: `${CLIENT_URL}/dashboard/subscription/success`,
      cancel_url: `${CLIENT_URL}/dashboard/subscription/cancel`,
    });

    await transactionsCollection.insertOne({
      vendorId: toObjectId(req.userId),
      plan: "premium",
      amount: PREMIUM_AMOUNT,
      currency: CURRENCY,
      status: "pending",
      stripeSessionId: session.id,
      createdAt: new Date(),
    });

    res.json({ url: session.url });
  }),
);

/* ------------------------------------------------------------------ */
/* Webhook — the ONLY place where premium is activated                 */
/* ------------------------------------------------------------------ */

/** Marks the matching transaction + user as premium (safe to call twice). */
async function activatePremium(session) {
  const session_id = session.id;
  const vendorId = session.metadata?.vendorId;

  await transactionsCollection.updateOne(
    { stripeSessionId: session_id },
    {
      $set: {
        status: "succeeded",
        paidAt: new Date(session.created * 1000),
        stripePaymentIntent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      },
    },
  );

  if (vendorId && /^[a-f0-9]{24}$/i.test(vendorId)) {
    await usersCollection.updateOne(
      { _id: toObjectId(vendorId) },
      { $set: { subscription: "premium", premiumSince: new Date() } },
    );
  }
}

/**
 * POST /api/payments/webhook  (mounted with express.raw in index.js)
 * Stripe signs the body — we verify the signature before doing anything.
 */
export async function stripeWebhook(req, res) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret) {
    return res.status(503).json({ message: "Stripe webhook is not configured." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer
      req.headers["stripe-signature"],
      secret,
    );
  } catch (error) {
    return res.status(400).json({ message: `Webhook signature failed: ${error.message}` });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        await activatePremium(session);
      }
    }

    // Abandoned / timed-out checkouts stay "pending" and never grant premium
    if (event.type === "checkout.session.expired") {
      await transactionsCollection.updateOne(
        { stripeSessionId: event.data.object.id },
        { $set: { status: "expired" } },
      );
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    res.status(500).json({ message: "Webhook handling failed." });
  }
}

export default router;
