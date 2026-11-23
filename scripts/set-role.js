/**
 * Small command-line tool to change a user's role (or plan).
 *
 *   node scripts/set-role.js ayman@gmail.com vendor
 *   node scripts/set-role.js monni@gmail.com vendor premium
 *
 * Roles: customer | vendor | admin     Plan: free | premium
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const [, , email, role, plan = "free"] = process.argv;

const ROLES = ["customer", "vendor", "admin"];
const PLANS = ["free", "premium"];

if (!email || !ROLES.includes(role) || !PLANS.includes(plan)) {
  console.log("Usage: node scripts/set-role.js <email> <customer|vendor|admin> [free|premium]");
  process.exit(1);
}

const client = new MongoClient(process.env.DB_URI);

try {
  await client.connect();
  const users = client.db("wedplan-system").collection("user");

  const result = await users.updateOne(
    { email: email.toLowerCase() },
    { $set: { role, subscription: plan, isBlocked: false } },
  );

  if (result.matchedCount === 0) {
    console.log(`No user found with email "${email}".`);
    process.exit(1);
  }

  console.log(`Updated ${email} -> role: ${role}, plan: ${plan}`);
} finally {
  await client.close();
}
