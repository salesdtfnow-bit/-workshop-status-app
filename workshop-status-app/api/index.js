// Workshop Status — Shopify Dev Dashboard app backend
// Provides:
//  - OAuth handlers (one-time token capture flow)
//  - Dashboard UI for status updates
//  - API endpoints that write to shop metafields
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  ADMIN_PASS,
  PORT = 3000,
} = process.env;

const API_VERSION = '2025-01';
const GRAPHQL_URL = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const OAUTH_SCOPES = 'read_content,write_content,read_metaobjects,write_metaobjects';

const HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.html'),
  'utf8'
);

async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Server not configured — missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN. Run /install to obtain a token.');
  }
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Shopify API ${resp.status}: ${bodyText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`Shopify returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  if (SHOPIFY_SHOP_DOMAIN) {
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors https://${SHOPIFY_SHOP_DOMAIN} https://admin.shopify.com;`
    );
  }
  next();
});

function requireAuth(req, res, next) {
  if (!ADMIN_PASS) {
    return res.status(500).json({ error: 'Server not configured — missing ADMIN_PASS env var on Vercel' });
  }
  const pass = req.headers['x-admin-pass'];
  if (!pass) return res.status(401).json({ error: 'Missing X-Admin-Pass header' });
  const a = Buffer.from(String(pass));
  const b = Buffer.from(ADMIN_PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
}

// ─── OAuth: step 1 — kick off install ─────────────────────────────────────
app.get('/install', (req, res) => {
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_SHOP_DOMAIN) {
    return res.status(500).send('Missing env vars: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and SHOPIFY_SHOP_DOMAIN must all be set on Vercel.');
  }
  const host = req.get('host');
  const redirectUri = `https://${host}/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  const url =
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_API_KEY)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;
  res.redirect(url);
});

// ─── OAuth: step 2 — exchange code for token, show it to user ─────────────
app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) {
    return res.status(400).send('Missing shop or code parameters in callback URL.');
  }
  try {
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });
    const json = await tokenResp.json();
    if (!json.access_token) {
      return res.status(500).send(`<pre>Token exchange failed:\n${JSON.stringify(json, null, 2)}</pre>`);
    }
    res.send(`<!doctype html>
      <html><head><meta charset="utf-8"><title>OAuth complete</title>
      <style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}
      .token{background:#fef3c7;border:2px solid #d97706;padding:20px;border-radius:8px;font-family:monospace;font-size:16px;word-break:break-all;user-select:all;margin:20px 0}
      ol{padding-left:20px} li{margin:8px 0}</style></head><body>
      <h1>Success! Your Admin API access token</h1>
      <p>This token starts with <code>shpat_</code> and grants this app read/write access to your shop's metafields.</p>
      <div class="token">${json.access_token}</div>
      <h2>Next steps</h2>
      <ol>
        <li>Click the yellow box above to select the whole token, then copy (Ctrl+C / Cmd+C).</li>
        <li>Open <a href="https://vercel.com" target="_blank">vercel.com</a> → your <code>workshop-status-app</code> project → <strong>Settings → Environment Variables</strong>.</li>
        <li>Find <code>SHOPIFY_ACCESS_TOKEN</code> → click ⋯ → <strong>Edit</strong> → paste the new token → save.</li>
        <li>Go to <strong>Deployments</strong> tab → ⋯ on the latest deployment → <strong>Redeploy</strong> (untick build cache).</li>
        <li>After redeploy finishes (~1 min), refresh the Workshop Status app inside Shopify admin. The dashboard should now load with all 6 cards.</li>
      </ol>
      <p style="color:#7f1d1d"><strong>Important:</strong> this token won't be shown again — make sure you save it to Vercel before closing this page.</p>
      </body></html>`);
  } catch (e) {
    res.status(500).send(`<pre>OAuth error: ${e.message}</pre>`);
  }
});

// ─── Embedded dashboard ────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  if (!ADMIN_PASS) {
    return res.status(500).send('Server not configured — missing ADMIN_PASS env var on Vercel. Set it then redeploy.');
  }
  if (!SHOPIFY_ACCESS_TOKEN) {
    return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h1>Setup needed</h1>
      <p>This app needs an Admin API access token before it can read or write metafields.</p>
      <p><a href="/install" style="display:inline-block;padding:12px 24px;background:#202223;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Run OAuth install</a></p>
      <p style="color:#6b7280;font-size:14px">After install, you'll receive a token to paste into Vercel's env vars.</p>
      </body></html>`);
  }
  res.send(HTML_TEMPLATE.replace(/\{\{ADMIN_PASS\}\}/g, ADMIN_PASS));
});

// ─── API: read current statuses ────────────────────────────────────────────
app.get('/api/statuses', requireAuth, async (_req, res) => {
  try {
    const query = `
      query ShopMetafields {
        shop {
          overall: metafield(namespace: "workshop_status", key: "overall") { value }
          dtf: metafield(namespace: "workshop_status", key: "dtf") { value }
          uv_dtf: metafield(namespace: "workshop_status", key: "uv_dtf") { value }
          vinyl_stickers: metafield(namespace: "workshop_status", key: "vinyl_stickers") { value }
          sublimation: metafield(namespace: "workshop_status", key: "sublimation") { value }
          artwork_setup: metafield(namespace: "workshop_status", key: "artwork_setup") { value }
          overall_updated: metafield(namespace: "workshop_status", key: "overall_updated") { value }
          dtf_updated: metafield(namespace: "workshop_status", key: "dtf_updated") { value }
          uv_dtf_updated: metafield(namespace: "workshop_status", key: "uv_dtf_updated") { value }
          vinyl_stickers_updated: metafield(namespace: "workshop_status", key: "vinyl_stickers_updated") { value }
          sublimation_updated: metafield(namespace: "workshop_status", key: "sublimation_updated") { value }
          artwork_setup_updated: metafield(namespace: "workshop_status", key: "artwork_setup_updated") { value }
        }
      }
    `;
    const data = await shopifyGraphQL(query);
    res.json(data.data?.shop || {});
  } catch (e) {
    console.error('GET /api/statuses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: update a department status ───────────────────────────────────────
const VALID_DEPARTMENTS = ['overall', 'dtf', 'uv_dtf', 'vinyl_stickers', 'sublimation', 'artwork_setup'];
const VALID_STATUSES = ['not_busy', 'moderate', 'busy', 'full_capacity'];

app.post('/api/update', requireAuth, async (req, res) => {
  try {
    const { department, status } = req.body;
    if (!VALID_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: 'Invalid department: ' + department });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status: ' + status });
    }
    const shopIdData = await shopifyGraphQL(`{ shop { id } }`);
    const shopGid = shopIdData.data?.shop?.id;
    if (!shopGid) return res.status(500).json({ error: 'Could not load shop ID' });
    const nowIso = new Date().toISOString();
    const mutation = `
      mutation SetStatus($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message }
        }
      }
    `;
    const variables = {
      metafields: [
        { ownerId: shopGid, namespace: 'workshop_status', key: department, type: 'single_line_text_field', value: status },
        { ownerId: shopGid, namespace: 'workshop_status', key: `${department}_updated`, type: 'date_time', value: nowIso },
      ],
    };
    const data = await shopifyGraphQL(mutation, variables);
    const errors = data.data?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      return res.status(400).json({ error: 'Shopify rejected the update', details: errors });
    }
    res.json({ ok: true, department, status, updatedAt: nowIso });
  } catch (e) {
    console.error('POST /api/update error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Debug endpoint ────────────────────────────────────────────────────────
app.get('/api/debug', requireAuth, async (_req, res) => {
  const mask = (s) => {
    if (!s) return null;
    if (s.length < 12) return '***SHORT***';
    return `${s.slice(0, 6)}_${s.slice(-4)} (length ${s.length})`;
  };
  const info = {
    SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP_DOMAIN || '(missing)',
    SHOPIFY_ACCESS_TOKEN: mask(SHOPIFY_ACCESS_TOKEN),
    SHOPIFY_API_KEY: mask(SHOPIFY_API_KEY),
    SHOPIFY_API_SECRET: mask(SHOPIFY_API_SECRET),
    ADMIN_PASS: mask(ADMIN_PASS),
    GRAPHQL_URL,
    apiVersion: API_VERSION,
    oauthScopes: OAUTH_SCOPES,
    deploymentRegion: process.env.VERCEL_REGION || 'local',
  };
  try {
    const test = await shopifyGraphQL('{ shop { name id myshopifyDomain } }');
    info.shopifyTest = { ok: true, shop: test.data?.shop };
  } catch (e) {
    info.shopifyTest = { ok: false, error: e.message };
  }
  res.json(info);
});

app.get('/healthz', (_req, res) => res.send('ok'));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Workshop Status app on port ${PORT}`);
  });
}

export default app;
