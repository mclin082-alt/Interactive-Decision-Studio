# Cloudflare Deployment

This project now has a Cloudflare Workers deployment path alongside the existing Railway/Node server.

## What Changes

- `src/worker.mjs` runs the app API on Cloudflare Workers.
- Cloudflare D1 stores app metadata in the `app_state` table.
- Cloudflare R2 stores generated deck HTML and previous versions.
- Static frontend assets are served from `dist` through Workers Assets.
- PDF export is disabled on Cloudflare because Workers cannot launch headless Chrome. Users can download HTML and print to PDF in the browser.

## One-Time Cloudflare Setup

Install Wrangler if it is not already available:

```bash
npm install --save-dev wrangler
```

Log in:

```bash
npx wrangler login
```

Create the D1 database:

```bash
npx wrangler d1 create slide-studio
```

Copy the returned `database_id` into `wrangler.toml`.

Create the R2 bucket:

```bash
npx wrangler r2 bucket create slide-studio-decks
```

Initialize the D1 schema:

```bash
npx wrangler d1 execute slide-studio --file cloudflare/schema.sql --remote
```

Set your model API key as a secret:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Update `APP_BASE_URL` in `wrangler.toml` to your Cloudflare domain or custom domain.

Deploy:

```bash
npm run cf:deploy
```

## Local Cloudflare Preview

```bash
npm run cf:dev
```

## Migrating Existing Railway Data

Export the local SQLite state:

```bash
npm run cf:export-state
```

This writes:

- `cloudflare/app-state.sql`
- `cloudflare/r2-upload-manifest.json`

Load the metadata into D1:

```bash
npx wrangler d1 execute slide-studio --file cloudflare/app-state.sql --remote
```

Upload each object from `cloudflare/r2-upload-manifest.json` to R2:

```bash
npx wrangler r2 object put slide-studio-decks/<key> --file <source>
```

Important: existing Railway users use Node `scrypt` password hashes. The Cloudflare Worker uses Web Crypto PBKDF2, so migrated users should reset/recreate passwords. New Cloudflare signups work normally.

## Operational Notes

- Keep Railway running until Cloudflare generation, login, and deck viewing have been tested on the production domain.
- D1 is currently used as a compact JSON state store to minimize migration risk. If usage grows, split the state into normalized D1 tables.
- R2 is the durable source of truth for generated deck files on Cloudflare.
