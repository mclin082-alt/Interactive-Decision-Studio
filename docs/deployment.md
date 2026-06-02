# Deployment Guide

This project is packaged as one Node/Express service with a built frontend, SQLite database, local generated files, and headless Chromium for PDF export.

## Recommended Portfolio Setup

Use Docker on Render, Railway, or Fly.io. Docker is preferred because PDF export needs Chromium and Node 24 for `node:sqlite`.

Required runtime:

- Node 24+
- Persistent disk
- Chromium or Chrome

## Render

The repository includes `render.yaml`.

1. Create a new Render Blueprint or Web Service from the repository.
2. Use Docker environment.
3. Attach a persistent disk at `/var/data`.
4. Set these environment variables:
   - `NODE_ENV=production`
   - `SLIDE_STUDIO_DATA_DIR=/var/data`
   - `CHROME_PATH=/usr/bin/chromium`
   - `SEED_DEMO=true`
   - `DEMO_EMAIL=demo@slidestudio.local`
   - `DEMO_PASSWORD=demo1234`
5. Set `OPENAI_API_KEY` or `AI_API_KEY` so reviewers can generate new decks without configuring anything in the app.

After deploy, open:

- `/product.html` for the portfolio explanation
- `/` for the app

## Railway

1. Create a new project from the repository.
2. Select Dockerfile deploy.
3. Add a persistent volume and mount it at `/var/data`.
4. Add the same environment variables listed above.
5. Deploy.

Railway will provide the public URL. Use that URL in the README, resume, or portfolio page.

## Fly.io

1. Create a Fly app.
2. Use the included Dockerfile.
3. Create a volume and mount it at `/var/data`.
4. Set secrets:

```bash
fly secrets set NODE_ENV=production SLIDE_STUDIO_DATA_DIR=/var/data CHROME_PATH=/usr/bin/chromium SEED_DEMO=true
```

5. Configure the server-side model key:

```bash
fly secrets set OPENAI_API_KEY=...
```

## Vercel Note

Vercel is not the best fit for this version because the app needs:

- A long-running Express server
- SQLite file persistence
- Local generated file storage
- Headless Chrome PDF export

For Vercel, split the product into a hosted frontend plus a separate backend/database/storage service.

## Demo Account

The app seeds:

- Email: `demo@slidestudio.local`
- Password: `demo1234`

Change these with `DEMO_EMAIL` and `DEMO_PASSWORD`.

## Production Hardening Later

- Move SQLite to Postgres or Supabase
- Move generated HTML/PDF files to S3/R2/Supabase Storage
- Add password reset and stronger session controls
- Store provider API keys with a managed secret store and add usage controls
- Add rate limits and usage tracking
- Add background jobs for generation/export
