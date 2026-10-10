# Blockhost Baton coordinator (free)

This small Cloudflare Worker keeps two things for your friend group:

1. **Who is hosting** (a lease with a safety number, so two PCs can never write the world at once).
2. **The world files** (stored in a free Durable Object, or optionally in R2).

It only runs when someone is using it, and one group needs a tiny fraction of the free limits.

## Setup (once, by the owner, about 5 minutes)

You need a free Cloudflare account and Node.js. Open a terminal **in this folder** and run:

```
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROUP_SECRET
```

- `deploy` prints an address ending in `workers.dev`. Copy it.
- `secret put` asks for a secret. Blockhost's **Cloud Host** page shows one to paste (any 18+ character secret works).
- Then open **Cloud Host** in Blockhost, paste the address, and press *Upload my world & create group*.
  Send the **group code** it shows you to your friends (privately: it contains the secret).

## Optional: use R2 instead

R2 gives 10 GB free but Cloudflare may ask for payment details to enable it. If you prefer it:

```
npx wrangler r2 bucket create blockhost-world
npx wrangler deploy -c wrangler.r2.toml
```

## Checking it works

In Blockhost: **Cloud Host -> Group -> Test connection** proves the secret works and does a real 4 MB upload and download.

Open `https://<your-worker>.workers.dev/?k=<secret>` in a browser to see who is hosting.
