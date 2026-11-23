# WedPlan API

Express API for the WedPlan wedding-services marketplace. It manages services, bookings, profiles, admin review, ImgBB uploads, and Stripe Checkout/webhooks.

## Run locally

1. Copy `.env.example` to `.env` and set MongoDB and secret values.
2. Install dependencies with `npm install`.
3. Run `npm run dev`.

The API listens on `http://localhost:5000` by default; `/api/health` is the health check.
For local Stripe testing, use the CLI with `stripe listen --events checkout.session.completed,checkout.session.expired,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed --forward-to localhost:5000/api/payments/webhook`, then copy the CLI webhook signing secret into `STRIPE_WEBHOOK_SECRET`.
To seed showcase services, create one or more vendor accounts, then run `npm run seed -- vendor1@example.com,vendor2@example.com`. The script observes the free-plan active-service limit; extra listings stay pending until review. To show six featured services, use at least two vendors with free plans or one active Premium vendor.

## Environment variables

| Name | Purpose |
| --- | --- |
| `PORT` | API listen port. |
| `CLIENT_URL` | Exact production client origin for CORS and Stripe return URLs. |
| `CLIENT_ORIGINS` | Optional comma-separated exact additional origins, such as Vercel Preview URLs. |
| `DB_URI` | MongoDB connection URI shared with the Better Auth app. |
| `JWT_SECRET` | Shared with the client token route; keep private. |
| `IMGBB_API_KEY` | Server-only key for profile and service image uploads. |
| `STRIPE_SECRET_KEY` | Stripe server key. Use a test key while testing. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the Stripe webhook endpoint. |

## Production deployment

Deploy this Node.js API separately from the Next.js client. Set the environment variables in the hosting provider. Set `CLIENT_URL` to the Vercel production origin, and set Vercel's `NEXT_PUBLIC_API_URL` to this API's public HTTPS URL. Configure the Stripe test-mode webhook at `https://<api-domain>/api/payments/webhook` for Checkout Session and subscription/invoice events, and use its signing secret as `STRIPE_WEBHOOK_SECRET`. Premium costs $49/month; vendors can schedule cancellation at the period end.

Keep `.env` out of version control. Admins assign admin roles outside public registration; API authorization re-reads the user's role from MongoDB.

## Links

- Live API: not deployed yet
- Client repository: add repository URL
- Server repository: add repository URL
