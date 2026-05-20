# Workshop Status — Shopify embedded app

A simple Shopify admin app for DTF Now to update workshop department statuses with a single click. Updates both the status text **and** the timestamp in Shopify metafields so the storefront page (`/pages/workshop-status`) shows live "last updated" times automatically.

## What this app does

- Embedded inside Shopify admin (appears in the Apps menu)
- Shows 6 cards: Overall, DTF, UV-DTF, Vinyl Stickers, Sublimation, Artwork Setup
- Each card has 4 status buttons: Not Busy, Moderate, Busy, Full Capacity
- Clicking a button writes to two Shopify metafields:
  - `workshop_status.<department>` — the status text
  - `workshop_status.<department>_updated` — the current UTC timestamp
- Your existing Liquid section on the storefront reads both and renders them

---

## Deployment guide (one-time setup)

This takes about 30 minutes the first time. After that, updates are instant.

### Step 1 — Create a Custom App in Shopify

A "Custom App" is a private app that only your store can use — no Partner account, no app store, no review required.

1. In Shopify admin, go to **Settings → Apps and sales channels**
2. Click **Develop apps** (top right). If you've never used it before, click **Allow custom app development** and confirm.
3. Click **Create an app**
4. Name it `Workshop Status` and pick yourself as the developer
5. Click **Configure Admin API scopes**
6. Tick these scopes:
   - `read_metafields`
   - `write_metafields`
7. Click **Save**
8. Click **Install app** (top right) → confirm
9. After install, you'll see an **Admin API access token** that starts with `shpat_...`
   - **Copy this immediately and save it somewhere safe** — Shopify only shows it once
10. Also note your `.myshopify.com` domain (it's shown at the top of the Develop apps page, e.g. `dtfnow.myshopify.com`)

### Step 2 — Deploy the code to Vercel

Vercel hosts the app for free. You'll connect it to a GitHub repository so any changes auto-deploy.

1. **Create a GitHub account** if you don't have one (github.com)
2. **Create a new GitHub repository** called `workshop-status-app` (private is fine)
3. **Upload the contents of this folder** to that repository:
   - On GitHub.com, click "uploading an existing file"
   - Drag the entire contents of `C:\Users\User\Documents\Claude\Projects\Workshop Status\workshop-status-app` into the upload area
   - **EXCEPT** for `.env` (if it exists — you should never commit it). Make sure `.env.example` IS uploaded.
   - Commit the upload
4. **Sign up at vercel.com** (free) — use your GitHub account to sign in
5. On the Vercel dashboard, click **Add New → Project**
6. Find your `workshop-status-app` repo and click **Import**
7. **Don't** change any framework settings — leave them on auto-detect
8. Expand **Environment Variables** and add these three:
   - `SHOPIFY_SHOP_DOMAIN` = your `.myshopify.com` domain (e.g. `dtfnow.myshopify.com`)
   - `SHOPIFY_ACCESS_TOKEN` = the `shpat_...` token from Step 1
   - `ADMIN_PASS` = a long random string (you can use a password generator, or run this in any terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
9. Click **Deploy**
10. Wait ~1 minute. When it finishes, Vercel gives you a URL like `https://workshop-status-app-abc123.vercel.app` — **copy this URL**

### Step 3 — Point the Custom App at your Vercel URL

1. Back in Shopify admin → **Settings → Apps and sales channels → Develop apps → Workshop Status**
2. Click the **Configuration** tab
3. Scroll to **App URL** and set it to your Vercel URL from Step 2
4. Scroll to **Allowed redirection URL(s)** and add the same URL
5. Save

### Step 4 — Open the app

1. In Shopify admin, click **Apps** in the left sidebar
2. Click **Workshop Status**
3. The dashboard loads inside Shopify admin
4. Click a status button → it updates Shopify immediately and refreshes the page on your storefront within ~30 seconds

---

## Updating the code later

If you want to change anything (add a department, tweak the design, add new statuses):

1. Edit the file in GitHub directly (click the pencil icon on any file)
2. Commit the change
3. Vercel auto-deploys within a minute
4. Refresh the app inside Shopify admin

---

## File layout

```
workshop-status-app/
├── server.js              ← Backend: handles API calls, writes to Shopify
├── public/
│   └── app.html           ← The dashboard UI shown inside Shopify admin
├── package.json           ← Node.js dependencies
├── vercel.json            ← Tells Vercel how to deploy
├── .env.example           ← Template for environment variables (copy to .env locally)
├── .gitignore             ← Files git should ignore (keep this — protects secrets)
└── README.md              ← This file
```

## Running locally (optional — for development)

If you ever want to run this on your own computer:

1. Install Node.js v18+ (nodejs.org)
2. In a terminal in this folder: `npm install`
3. Copy `.env.example` to `.env` and fill in the real values
4. Run: `npm start`
5. Open `http://localhost:3000` in your browser

---

## Troubleshooting

**"Could not load statuses: Failed to load (401)"**
The `ADMIN_PASS` env var on Vercel doesn't match what the HTML has. Redeploy on Vercel after setting the env var.

**"Shopify rejected the update"**
Most likely the Custom App's API scopes don't include `write_metafields`. Go back to Step 1 and check.

**Status buttons don't appear, just a loading spinner**
Check the browser console (F12 in Chrome) for errors. Usually means the Vercel deployment isn't running — check the Vercel dashboard for build errors.

**Want to delete the old Manus app?**
Once this app is working, you can uninstall the Manus app from **Settings → Apps and sales channels** without losing your metafield data — the data lives in your Shopify store, not in the app.
