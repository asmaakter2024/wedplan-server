/**
 * API smoke test — run it while the server is up:
 *
 *   node scripts/test-api.js
 *
 * It checks the public routes and a few protected ones (role checks).
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
  } catch {
    return { status: 0, data: {} };
  }
}

const client = new MongoClient(process.env.DB_URI);
await client.connect();
const users = client.db("wedplan-system").collection("user");

const admin = await users.findOne({ role: "admin" });
const vendor = await users.findOne({ role: "vendor" });
const customer = await users.findOne({ role: "customer", isBlocked: { $ne: true } });

const sign = (user) =>
  jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "1h" });

console.log("\nPublic routes");
{
  const list = await call("/api/services");
  check("GET /api/services -> 200", list.status === 200);
  check("returns an array", Array.isArray(list.data.services));

  const featured = await call("/api/services/featured");
  check("GET /api/services/featured -> 200", featured.status === 200);
}

console.log("\nAuth / roles");
{
  const noAuth = await call("/api/profile");
  check("no token -> 401", noAuth.status === 401);

  const asCustomer = await call("/api/admin/users", { token: sign(customer) });
  check("customer on admin route -> 403", asCustomer.status === 403);

  const asAdmin = await call("/api/admin/users", { token: sign(admin) });
  check("admin users -> 200", asAdmin.status === 200);
}

console.log("\nVendor & bookings (needs seeded data)");
if (vendor && customer) {
  const stats = await call("/api/vendor/stats", { token: sign(vendor) });
  check("vendor stats -> 200", stats.status === 200);

  const list = await call("/api/vendor/services", { token: sign(vendor) });
  check("vendor services -> 200", list.status === 200);

  const mine = await call("/api/bookings/mine", { token: sign(customer) });
  check("customer bookings -> 200", mine.status === 200);
} else {
  console.log("  skipped — run scripts/set-role.js and scripts/seed-services.js first");
}

await client.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
