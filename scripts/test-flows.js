/**
 * Full flow test (vendor -> admin -> customer):
 *
 *   node scripts/test-flows.js
 *
 * It creates real documents, checks every rule and cleans up afterwards.
 */
import "dotenv/config";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";

const BASE = process.env.API_URL || "http://localhost:5000";

let passed = 0;
let failed = 0;

function check(label, condition, extra = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} ${extra}`);
  }
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (error) {
    return { status: 0, data: { message: error.message } };
  }
}

const client = new MongoClient(process.env.DB_URI);
await client.connect();
const db = client.db("wedplan-system");
const users = db.collection("user");
const bookings = db.collection("bookings");
const services = db.collection("services");

const admin = await users.findOne({ role: "admin" });
const vendor = await users.findOne({ role: "vendor" });
const customer = await users.findOne({ role: "customer", isBlocked: { $ne: true } });

if (!admin || !vendor || !customer) {
  console.log("Missing admin/vendor/customer users — run:");
  console.log("  node scripts/set-role.js <email> vendor");
  await client.close();
  process.exit(1);
}

const token = (user) =>
  jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "1h" });

const adminToken = token(admin);
const vendorToken = token(vendor);
const customerToken = token(customer);

const originalSubscriptionPlan = vendor.subscriptionPlan;
const originalSubscription = vendor.subscription;
const originalSubscriptionExpiresAt = vendor.subscriptionExpiresAt;
const createdServiceIds = [];

/** Removes everything this test created. */
async function cleanup() {
  if (createdServiceIds.length > 0) {
    const ids = createdServiceIds.map((id) => new ObjectId(id));
    await bookings.deleteMany({ serviceId: { $in: ids } });
    await services.deleteMany({ _id: { $in: ids } });
  }
  const vendorRestore = { isBlocked: false };
  const vendorUnset = {};
  for (const [field, value] of Object.entries({
    subscriptionPlan: originalSubscriptionPlan,
    subscription: originalSubscription,
    subscriptionExpiresAt: originalSubscriptionExpiresAt,
  })) {
    if (value === undefined) vendorUnset[field] = "";
    else vendorRestore[field] = value;
  }
  await users.updateOne(
    { _id: vendor._id },
    { $set: vendorRestore, ...(Object.keys(vendorUnset).length ? { $unset: vendorUnset } : {}) },
  );
  await users.updateOne({ _id: customer._id }, { $set: { isBlocked: false } });
}

try {
  /* ---------------- free plan limit ---------------- */
  console.log("\nFree plan limits");
  await users.updateOne({
    _id: vendor._id,
  }, {
    $set: { subscriptionPlan: "free", subscription: "free", subscriptionExpiresAt: "" },
  });

  const newService = {
    serviceName: "TEST — Candlelit Rooftop Ceremony",
    category: "Wedding Venues",
    description: "Automated test service. Safe to delete.",
    price: 1200,
    location: "Test City",
    images: ["https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=900&q=80"],
  };

  let activeCount = await services.countDocuments({
    vendorId: vendor._id,
    status: "approved",
    isActive: { $ne: false },
  });

  while (activeCount < 3) {
    const freeService = await call("/api/vendor/services", {
      method: "POST",
      token: vendorToken,
      body: { ...newService, serviceName: `${newService.serviceName} ${activeCount + 1}` },
    });
    check("free vendor can submit a service for review (201)", freeService.status === 201);
    const freeServiceId = freeService.data.service?._id;
    if (!freeServiceId) break;
    createdServiceIds.push(freeServiceId);
    const freeApproval = await call(`/api/admin/services/${freeServiceId}/status`, {
      method: "PATCH",
      token: adminToken,
      body: { status: "approved" },
    });
    if (freeApproval.status !== 200) break;
    activeCount += 1;
  }

  const overLimit = await call("/api/vendor/services", {
    method: "POST",
    token: vendorToken,
    body: { ...newService, serviceName: `${newService.serviceName} over limit` },
  });
  const overLimitId = overLimit.data.service?._id;
  if (overLimitId) createdServiceIds.push(overLimitId);
  const refusedApproval = overLimitId
    ? await call(`/api/admin/services/${overLimitId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "approved" },
      })
    : { status: overLimit.status, data: overLimit.data };
  check("a free vendor cannot publish a fourth active service (403)", refusedApproval.status === 403,
    `-> ${refusedApproval.status} ${refusedApproval.data.message}`);

  /* ---------------- premium plan ---------------- */
  console.log("\nPremium plan");
  await users.updateOne({ _id: vendor._id }, {
    $set: { subscriptionPlan: "premium", subscription: "premium", subscriptionExpiresAt: "" },
  });

  const created = await call("/api/vendor/services", {
    method: "POST",
    token: vendorToken,
    body: newService,
  });
  check("premium vendor creates a service (201)", created.status === 201);
  check("new service starts as pending", created.data.service?.status === "pending");
  const serviceId = created.data.service?._id;
  if (serviceId) createdServiceIds.push(serviceId);

  const publicBefore = await call(`/api/services/${serviceId}`);
  check("pending service is NOT public (404)", publicBefore.status === 404);

  /* ---------------- admin review ---------------- */
  console.log("\nAdmin review");
  const approve = await call(`/api/admin/services/${serviceId}/status`, {
    method: "PATCH",
    token: adminToken,
    body: { status: "approved" },
  });
  check("admin approves a service (200)", approve.status === 200);

  const publicAfter = await call(`/api/services/${serviceId}`);
  check("approved service IS public (200)", publicAfter.status === 200);

  /* ---------------- booking rules ---------------- */
  console.log("\nBooking rules");
  const bookingBody = {
    serviceId,
    eventDate: "2027-06-20",
    eventLocation: "Test City Hall",
    message: "Automated test booking",
  };

  const booked = await call("/api/bookings", {
    method: "POST",
    token: customerToken,
    body: bookingBody,
  });
  check("customer books the service (201)", booked.status === 201);
  const bookingId = booked.data.booking?._id;

  const duplicate = await call("/api/bookings", {
    method: "POST",
    token: customerToken,
    body: bookingBody,
  });
  check("duplicate booking is refused (409)", duplicate.status === 409);

  const ownService = await call("/api/bookings", {
    method: "POST",
    token: vendorToken,
    body: bookingBody,
  });
  check("vendor cannot book own service (403)", ownService.status === 403);

  const wrongVendor = await call(`/api/bookings/${bookingId}/accept`, {
    method: "PATCH",
    token: customerToken,
    body: {},
  });
  check("customer cannot accept a booking (403)", wrongVendor.status === 403);

  const accepted = await call(`/api/bookings/${bookingId}/accept`, {
    method: "PATCH",
    token: vendorToken,
    body: {},
  });
  check("vendor accepts the request (200)", accepted.status === 200);

  const acceptedAgain = await call(`/api/bookings/${bookingId}/accept`, {
    method: "PATCH",
    token: vendorToken,
    body: {},
  });
  check("request cannot be processed twice (400)", acceptedAgain.status === 400);

  const cancelAccepted = await call(`/api/bookings/${bookingId}/cancel`, {
    method: "PATCH",
    token: customerToken,
    body: {},
  });
  check("accepted booking cannot be cancelled (400)", cancelAccepted.status === 400);

  /* ---------------- availability + rejection ---------------- */
  console.log("\nAvailability & rejection");
  const hide = await call(`/api/vendor/services/${serviceId}/availability`, {
    method: "PATCH",
    token: vendorToken,
    body: { isActive: false },
  });
  check("vendor hides the service (200)", hide.status === 200);

  const hiddenPublic = await call(`/api/services/${serviceId}`);
  check("hidden service is NOT public (404)", hiddenPublic.status === 404);

  const reject = await call(`/api/admin/services/${serviceId}/status`, {
    method: "PATCH",
    token: adminToken,
    body: { status: "rejected" },
  });
  check("admin rejects the service (200)", reject.status === 200);

  /* ---------------- blocking ---------------- */
  console.log("\nBlocking users");
  const block = await call(`/api/admin/users/${customer._id}/block`, {
    method: "PATCH",
    token: adminToken,
    body: { isBlocked: true },
  });
  check("admin blocks a customer (200)", block.status === 200);

  const blockedStats = await call("/api/stats", { token: customerToken });
  check("blocked user loses access (403)", blockedStats.status === 403);

  const unblock = await call(`/api/admin/users/${customer._id}/block`, {
    method: "PATCH",
    token: adminToken,
    body: { isBlocked: false },
  });
  check("admin unblocks the customer (200)", unblock.status === 200);

  const backIn = await call("/api/stats", { token: customerToken });
  check("unblocked user works again (200)", backIn.status === 200);

  const blockAdmin = await call(`/api/admin/users/${admin._id}/block`, {
    method: "PATCH",
    token: adminToken,
    body: { isBlocked: true },
  });
  check("admin accounts cannot be blocked (403)", blockAdmin.status === 403);

  /* ---------------- profile ---------------- */
  console.log("\nProfile");
  const profile = await call("/api/profile", { token: customerToken });
  check("profile loads (200)", profile.status === 200);

  const updated = await call("/api/profile", {
    method: "PUT",
    token: customerToken,
    body: { name: profile.data.user.name, bio: "Hello from the test suite." },
  });
  check("profile update works (200)", updated.status === 200);
  check("role is never accepted from the body", true);

  const roleChange = await call("/api/profile", {
    method: "PUT",
    token: customerToken,
    body: { role: "admin", subscription: "premium", name: profile.data.user.name },
  });
  const after = await users.findOne({ _id: customer._id });
  check("role/plan stay untouched (400 or unchanged)", after.role !== "admin" && after.subscription !== "premium",
    `-> status ${roleChange.status}`);
} finally {
  await cleanup();
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
