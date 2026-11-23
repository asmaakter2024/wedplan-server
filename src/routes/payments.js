/** Stripe Billing routes for the vendor Premium subscription. */
import Stripe from "stripe";
import { Router } from "express";
import { usersCollection, servicesCollection, transactionsCollection } from "../db.js";
import { asyncHandler, ApiError, toObjectId } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const PREMIUM_AMOUNT_CENTS = 4900;
const CURRENCY = "usd";
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");

let stripeClient = null;
function getStripe() {
  // This project requirement is explicitly Stripe Test Mode. A live key must
  // never silently turn the checkout into a real-money flow.
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) return null;
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function subscriptionIdFromSession(session) {
  return typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id;
}

function subscriptionPeriodEnd(subscription) {
  const item = subscription.items?.data?.[0];
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  return typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null;
}

function subscriptionIsActive(subscription) {
  const expiresAt = subscriptionPeriodEnd(subscription);
  return ["active", "trialing"].includes(subscription.status) &&
    (!expiresAt || expiresAt.getTime() > Date.now());
}

async function syncSubscription(subscription, { allowReplace = false } = {}) {
  const vendorId = subscription.metadata?.vendorId;
  if (!vendorId || !/^[a-f0-9]{24}$/i.test(vendorId)) return;

  const vendorObjectId = toObjectId(vendorId);
  const [vendor, transaction] = await Promise.all([
    usersCollection.findOne({ _id: vendorObjectId, role: "vendor" }, { projection: { stripeSubscriptionId: 1 } }),
    transactionsCollection.findOne({
      vendorId: vendorObjectId,
      stripeSubscriptionId: subscription.id,
      status: "succeeded",
    }),
  ]);
  if (!vendor || !transaction) return;
  if (vendor.stripeSubscriptionId && vendor.stripeSubscriptionId !== subscription.id && !allowReplace) return;

  const expiresAt = subscriptionPeriodEnd(subscription);
  const plan = subscriptionIsActive(subscription) ? "premium" : "free";
  await usersCollection.updateOne(
    { _id: vendorObjectId, role: "vendor" },
    {
      $set: {
        subscriptionPlan: plan,
        subscription: plan,
        subscriptionExpiresAt: plan === "premium" && expiresAt ? expiresAt.toISOString() : "",
        subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        stripeSubscriptionId: subscription.id,
        updatedAt: new Date(),
      },
    },
  );

  if (plan === "free") {
    const activeServices = await servicesCollection
      .find({ vendorId: toObjectId(vendorId), status: "approved", isActive: { $ne: false } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const idsToHide = activeServices.slice(3).map((service) => service._id);
    if (idsToHide.length) {
      await servicesCollection.updateMany(
        { _id: { $in: idsToHide } },
        { $set: { isActive: false, updatedAt: new Date() } },
      );
    }
  }
}

/** Only this verified-webhook path enables Premium. */
async function activateFromCheckout(session) {
  const vendorId = session.metadata?.vendorId;
  const subscriptionId = subscriptionIdFromSession(session);
  if (!vendorId || !/^[a-f0-9]{24}$/i.test(vendorId) || !subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (
    subscription.metadata?.vendorId !== vendorId ||
    !subscriptionIsActive(subscription)
  ) {
    return;
  }

  const transaction = await transactionsCollection.updateOne(
    {
      stripeSessionId: session.id,
      vendorId: toObjectId(vendorId),
      status: { $in: ["pending", "succeeded"] },
    },
    {
      $set: {
        status: "succeeded",
        stripeSubscriptionId: subscriptionId,
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );

  // Never grant a plan unless the matching checkout record exists in our DB.
  if (transaction.matchedCount > 0) {
    await syncSubscription(subscription, { allowReplace: true });
  } else {
    const record = await transactionsCollection.findOne({ stripeSessionId: session.id });
    if (!record) throw new Error("Checkout transaction is not saved yet; Stripe should retry the webhook.");
  }
}

/**
 * POST /api/payments/checkout
 * Each authenticated vendor can only create a Checkout session for themselves.
 */
router.post(
  "/checkout",
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) throw new ApiError(503, "Stripe Test Mode is not configured. Set a backend STRIPE_SECRET_KEY beginning with sk_test_.");

    const plan = currentSubscriptionPlan(req.user);
    const expiry = req.user.subscriptionExpiresAt ? new Date(req.user.subscriptionExpiresAt) : null;
    if (plan === "premium" && (!expiry || expiry.getTime() > Date.now())) {
      throw new ApiError(400, "Your account is already on the Premium plan.");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: req.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: PREMIUM_AMOUNT_CENTS,
          recurring: { interval: "month" },
          product_data: {
            name: "WedPlan Premium",
            description: "Unlimited services, priority placement and premium badges.",
          },
        },
      }],
      metadata: { vendorId: req.userId, plan: "premium" },
      subscription_data: { metadata: { vendorId: req.userId, plan: "premium" } },
      success_url: `${CLIENT_URL}/dashboard/subscription/success`,
      cancel_url: `${CLIENT_URL}/dashboard/subscription/cancel`,
    });

    await transactionsCollection.insertOne({
      vendorId: toObjectId(req.userId),
      plan: "premium",
      amount: PREMIUM_AMOUNT_CENTS / 100,
      currency: CURRENCY,
      billingInterval: "month",
      stripeSessionId: session.id,
      stripeSubscriptionId: null,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.json({ url: session.url });
  }),
);

/** Schedule the current vendor subscription to end at the paid period boundary. */
router.post(
  "/cancel",
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) throw new ApiError(503, "Stripe Test Mode is not configured. Set a backend STRIPE_SECRET_KEY beginning with sk_test_.");

    const record = await transactionsCollection.findOne(
      {
        vendorId: toObjectId(req.userId),
        stripeSubscriptionId: { $type: "string" },
        status: "succeeded",
      },
      { sort: { createdAt: -1 } },
    );
    if (!record?.stripeSubscriptionId) throw new ApiError(404, "No active Premium subscription was found.");

    const subscription = await stripe.subscriptions.retrieve(record.stripeSubscriptionId);
    if (subscription.metadata?.vendorId !== req.userId) {
      throw new ApiError(403, "This subscription does not belong to your account.");
    }
    if (subscription.status !== "active" || subscription.cancel_at_period_end) {
      throw new ApiError(400, "This subscription cannot be cancelled at this time.");
    }

    const updated = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    await syncSubscription(updated);
    const expiresAt = subscriptionPeriodEnd(updated);
    res.json({
      message: "Premium will remain active until the current billing period ends.",
      subscriptionExpiresAt: expiresAt?.toISOString() ?? null,
    });
  }),
);

/**
 * POST /api/payments/webhook (registered before express.json in index.js).
 * Never grant or remove Premium from a browser redirect.
 */
export async function stripeWebhook(req, res) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ message: "Stripe Test Mode webhook is not configured." });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch {
    return res.status(400).json({ message: "Webhook signature verification failed." });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (
        session.mode === "subscription" &&
        session.payment_status === "paid" &&
        session.amount_total === PREMIUM_AMOUNT_CENTS &&
        session.currency === CURRENCY
      ) {
        await activateFromCheckout(session);
      }
    } else if (event.type === "checkout.session.expired") {
      await transactionsCollection.updateOne(
        { stripeSessionId: event.data.object.id, status: "pending" },
        { $set: { status: "expired", updatedAt: new Date() } },
      );
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      await syncSubscription(event.data.object);
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.parent?.subscription_details?.subscription;
      if (typeof subscriptionId === "string") {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription);

        if (event.type === "invoice.paid" && invoice.billing_reason !== "subscription_create") {
          const vendorId = subscription.metadata?.vendorId;
          if (vendorId && /^[a-f0-9]{24}$/i.test(vendorId)) {
            await transactionsCollection.updateOne(
              { stripeInvoiceId: invoice.id },
              { $setOnInsert: {
                vendorId: toObjectId(vendorId),
                plan: "premium",
                amount: (invoice.amount_paid ?? 0) / 100,
                currency: invoice.currency || CURRENCY,
                billingInterval: "month",
                stripeInvoiceId: invoice.id,
                stripeSubscriptionId: subscriptionId,
                status: "succeeded",
                paidAt: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000),
                createdAt: new Date(),
              } },
              { upsert: true },
            );
          }
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handling failed:", error);
    res.status(500).json({ message: "Webhook handling failed." });
  }
}

export default router;
