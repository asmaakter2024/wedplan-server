/**
 * Seeds demo services into MongoDB so the Browse page, the vendor
 * dashboard and the admin review screen have real data to show.
 *
 *   node scripts/seed-services.js [vendorEmail]
 *
 * - Inserts the 8 demo services as "approved" + active
 * - Inserts 1 extra service as "pending" so an admin can approve/reject
 * - Safe to run twice: it only inserts services that do not exist yet
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const vendorEmail = (process.argv[2] || "monni@gmail.com").toLowerCase();

/** The same showcase data the client uses as an offline fallback. */
const DEMO_SERVICES = [
  {
    serviceName: "Bespoke Garden Arch & Candlelit Ceremony",
    category: "Decoration & Florist",
    description:
      "Custom seasonal ceremony arch installation, bridal and bridesmaid bouquets, lush runner centerpiece styling and candlelit tablescapes for your venue.",
    price: 3400,
    location: "San Francisco, CA",
    images: [
      "https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=900&q=80",
      "https://images.unsplash.com/photo-1519741497674-611481863552?w=900&q=80",
    ],
  },
  {
    serviceName: "Super 8mm Documentary Wedding Film",
    category: "Photography & Videography",
    description:
      "Nostalgic Super 8mm film blended with digital 4K audio capture for vows and toasts, producing an heirloom cinematic wedding documentary.",
    price: 3100,
    location: "Santa Barbara, CA",
    images: [
      "https://images.unsplash.com/photo-1460978812857-470ed1c77af0?w=900&q=80",
      "https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=900&q=80",
    ],
  },
  {
    serviceName: "Haute Bridal Couture & Custom Gown Experience",
    category: "Wedding Fashion",
    description:
      "Private showroom appointment with European silk gowns, cathedral veils, bespoke tuxedo tailoring and three fittings with your personal stylist.",
    price: 2900,
    location: "Beverly Hills, CA",
    images: ["https://images.unsplash.com/photo-1594552072238-b8a33785b261?w=900&q=80"],
  },
  {
    serviceName: "Grand Crystal Ballroom Reception Package",
    category: "Wedding Venues",
    description:
      "Historic chandelier ballroom for 250 guests with gold chiavari seating, private bridal suite, valet parking and an on-site event coordinator.",
    price: 7800,
    location: "New York, NY",
    images: ["https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=900&q=80"],
  },
  {
    serviceName: "Chef's Tasting Menu & Live Cooking Stations",
    category: "Catering Services",
    description:
      "Five-course plated dinner or interactive live stations, craft cocktail bar, artisan patisserie table and full service staff for up to 200 guests.",
    price: 4200,
    location: "Chicago, IL",
    images: ["https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=900&q=80"],
  },
  {
    serviceName: "Bridal Glamour: Hair & Makeup Artistry",
    category: "Makeup & Styling",
    description:
      "Airbrush foundation, individual lash application, soft-glam hairstyle trials and an on-site touch-up artist who stays with you through the reception.",
    price: 950,
    location: "Miami, FL",
    images: ["https://images.unsplash.com/photo-1560066984-138dadb4c035?w=900&q=80"],
  },
  {
    serviceName: "Enchanted Gazebo Ceremony & Photography",
    category: "Photography & Videography",
    description:
      "Full-day coverage with a second shooter, an enchanted garden gazebo first-look session, 600+ edited digital images and a handcrafted heirloom album.",
    price: 2600,
    location: "Austin, TX",
    images: ["https://images.unsplash.com/photo-1546195643-70f48f9c5b87?w=900&q=80"],
  },
  {
    serviceName: "Rustic Estate Reception Styling",
    category: "Decoration & Florist",
    description:
      "Long-table farm styling with dried florals, layered linens, warm bistro lighting and a custom welcome installation designed around your palette.",
    price: 3800,
    location: "Seattle, WA",
    images: ["https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?w=900&q=80"],
  },
];

/** Extra service that waits for the admin's approval. */
const PENDING_SERVICE = {
  serviceName: "Moonlit Beach Vow Renewal Setup",
  category: "Wedding Venues",
  description:
    "Intimate sunset ceremony on the private beach with draped canopy, seagrass aisle runner, lantern pathway and a string-light reception lounge.",
  price: 5400,
  location: "San Diego, CA",
  images: ["https://images.unsplash.com/photo-1519225421980-715cb0215aed?w=900&q=80"],
  status: "pending",
};

const client = new MongoClient(process.env.DB_URI);

try {
  await client.connect();
  const db = client.db("wedplan-system");
  const users = db.collection("user");
  const services = db.collection("services");

  const vendor = await users.findOne({ email: vendorEmail });
  if (!vendor) {
    console.log(`No user found with email "${vendorEmail}".`);
    console.log("Create the account first, or pass another email:");
    console.log("  node scripts/seed-services.js someone@example.com");
    process.exit(1);
  }

  let inserted = 0;

  for (const service of DEMO_SERVICES) {
    const exists = await services.findOne({
      vendorId: vendor._id,
      serviceName: service.serviceName,
    });
    if (exists) continue;

    await services.insertOne({
      ...service,
      vendorId: vendor._id,
      status: "approved",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inserted += 1;
  }

  const pendingExists = await services.findOne({
    vendorId: vendor._id,
    serviceName: PENDING_SERVICE.serviceName,
  });
  if (!pendingExists) {
    await services.insertOne({
      ...PENDING_SERVICE,
      vendorId: new ObjectId(vendor._id),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inserted += 1;
  }

  console.log(`Done — ${inserted} new service(s) inserted for ${vendorEmail}.`);
  console.log(`Total services now: ${await services.countDocuments({})}`);
} finally {
  await client.close();
}
