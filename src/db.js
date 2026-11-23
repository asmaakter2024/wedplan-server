/**
 * MongoDB connection for the WedPlan API.
 *
 * The same database is shared with the Next.js client (Better Auth):
 *   - "user", "session", "account", "verification" -> created by Better Auth
 *   - "services", "bookings", "transactions"        -> created by this API
 */
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const DB_URI = process.env.DB_URI;

if (!DB_URI) {
  console.error("Missing DB_URI in .env — the server cannot start.");
  process.exit(1);
}

/** Better Auth stores users in this database. */
const DB_NAME = "wedplan-system";

export const client = new MongoClient(DB_URI);
export const db = client.db(DB_NAME);

/** Users (created/managed by Better Auth). */
export const usersCollection = db.collection("user");
/** Wedding services published by vendors. */
export const servicesCollection = db.collection("services");
/** Booking requests sent by customers. */
export const bookingsCollection = db.collection("bookings");
/** Stripe subscription payments (read-only for admins). */
export const transactionsCollection = db.collection("transactions");

/** Opens the connection once, when the server starts. */
export async function connectToDatabase() {
  await client.connect();
  console.log("MongoDB connected.");
}

export { ObjectId };
