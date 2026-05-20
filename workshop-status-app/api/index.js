// Workshop Status — Shopify Dev Dashboard app backend
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

async function getShopGid() {
  const data = await shopifyGraphQL(`{ shop { id } }`);
  return data.data?.shop?.id;
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

// ─── OAuth: step 2 — exchange code for token ──────────────────────────────
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
      <div class="token">${json.access_token}</div>
      <ol>
        <li>Click the yellow box, copy the token.</li>
        <li>Vercel → Settings → Environment Variables → SHOPIFY_ACCESS_TOKEN → paste → save.</li>
        <li>Deployments → ⋯ on latest → Redeploy (untick build cache).</li>
        <li>Refresh the app inside Shopify admin.</li>
      </ol>
      </body></html>`);
  } catch (e) {
    res.status(500).send(`<pre>OAuth error: ${e.message}</pre>`);
  }
});

// ─── Embedded dashboard ────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  if (!ADMIN_PASS) {
    return res.status(500).send('Server not configured — missing ADMIN_PASS env var on Vercel.');
  }
  if (!SHOPIFY_ACCESS_TOKEN) {
    return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h1>Setup needed</h1>
      <p>This app needs an Admin API access token before it can read or write metafields.</p>
      <p><a href="/install" style="display:inline-block;padding:12px 24px;background:#202223;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Run OAuth install</a></p>
      </body></html>`);
  }
  res.send(HTML_TEMPLATE.replace(/\{\{ADMIN_PASS\}\}/g, ADMIN_PASS));
});

// ─── API: read statuses + capacity ────────────────────────────────────────
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
          dtf_capacity_total: metafield(namespace: "dtfcapacity", key: "total") { value }
          dtf_capacity_used: metafield(namespace: "dtfcapacity", key: "used") { value }
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
    const shopGid = await getShopGid();
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

// ─── API: update DTF capacity (total or used in meters) ───────────────────
app.post('/api/capacity', requireAuth, async (req, res) => {
  try {
    const { total, used } = req.body;
    const metafields = [];
    const shopGid = await getShopGid();
    if (!shopGid) return res.status(500).json({ error: 'Could not load shop ID' });

    if (Number.isFinite(total)) {
      if (total < 0 || total > 100000) {
        return res.status(400).json({ error: 'Invalid total (must be 0–100000)' });
      }
      metafields.push({
        ownerId: shopGid,
        namespace: 'dtfcapacity',
        key: 'total',
        type: 'number_integer',
        value: String(Math.round(total)),
      });
    }
    if (Number.isFinite(used)) {
      if (used < 0 || used > 100000) {
        return res.status(400).json({ error: 'Invalid used (must be 0–100000)' });
      }
      metafields.push({
        ownerId: shopGid,
        namespace: 'dtfcapacity',
        key: 'used',
        type: 'number_integer',
        value: String(Math.round(used)),
      });
    }
    if (metafields.length === 0) {
      return res.status(400).json({ error: 'Provide at least one of: total, used' });
    }
    // Also stamp dtf_updated so storefront timestamp reflects capacity change too
    metafields.push({
      ownerId: shopGid,
      namespace: 'workshop_status',
      key: 'dtf_updated',
      type: 'date_time',
      value: new Date().toISOString(),
    });
    const mutation = `
      mutation SetCapacity($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message }
        }
      }
    `;
    const data = await shopifyGraphQL(mutation, { metafields });
    const errors = data.data?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      return res.status(400).json({ error: 'Shopify rejected the update', details: errors });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/capacity error:', e);
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
