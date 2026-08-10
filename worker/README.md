# Daily Pods — Cloudflare Worker

A self-hosted Cloudflare Worker that keeps a Spotify playlist ("Daily Pods") filled with today's episodes of your favorite daily podcasts. It runs automatically every morning via a cron trigger — no computer needs to be on — and includes a small web UI for connecting Spotify and managing your podcast list.

This is the automated alternative to the Python script in the repo root: same idea, but always-on and configurable from the browser.

## How it works

- Every day at the scheduled time, the worker fetches the newest episode of each podcast you follow and replaces the contents of your "Daily Pods" playlist with them.
- User tokens and podcast lists are stored in Cloudflare KV. Multiple people can connect to your deployment (Spotify development mode allows up to 25 users you invite manually), but the intended use is: everyone deploys their own copy.
- Routes: `/` (landing + connect), `/settings` (manage podcasts, trigger a manual update), `/status`, `/api/podcasts`.

## Setup

You need a free [Cloudflare](https://dash.cloudflare.com) account and a [Spotify developer](https://developer.spotify.com/dashboard) account.

### 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Note the **Client ID** and **Client Secret**.
3. Under **User Management**, add the Spotify account(s) that will use it (including your own) — required while the app is in development mode.
4. You'll add the Redirect URI in step 4 below, once you know your worker's URL.

### 2. Create the KV namespace

```bash
npm install
npx wrangler kv namespace create USERS
```

Copy the returned `id` into `wrangler.toml`, replacing `your-kv-namespace-id`.

### 3. Configure credentials

- In `wrangler.toml`, set `SPOTIFY_CLIENT_ID` to your app's client ID.
- Store the client secret as a Worker secret (never commit it):

```bash
npx wrangler secret put SPOTIFY_CLIENT_SECRET
```

### 4. Deploy and set the redirect URI

```bash
npm run deploy
```

Wrangler prints your worker URL, e.g. `https://daily-podcasts.<your-subdomain>.workers.dev`. In the Spotify app settings, add:

```
https://daily-podcasts.<your-subdomain>.workers.dev/callback
```

as a Redirect URI. (The worker derives this URI from the incoming request, so no code change is needed.)

### 5. Connect Spotify

Open your worker URL in a browser, click **Connect Spotify**, and authorize. Then visit `/settings` to customize your podcast list — the defaults are FT News Briefing, Up First, and The Daily. Podcasts are identified by their Spotify show ID (the part after `/show/` in a show's Spotify URL).

## Schedule

The daily update runs at 12:00 UTC (7am EST) by default. Change the cron expression in `wrangler.toml` to suit your timezone, then redeploy:

```toml
[triggers]
crons = ["0 12 * * *"]
```

You can also trigger an update any time from the `/settings` page.

## Custom cover image

The playlist cover lives in `src/cover.js` as a base64 JPEG. To use your own, base64-encode a JPEG under 256 KB (`base64 -i cover.jpg`) and replace the string.

## Local development

```bash
npm run dev     # local dev server
npm run tail    # stream logs from the deployed worker
```
