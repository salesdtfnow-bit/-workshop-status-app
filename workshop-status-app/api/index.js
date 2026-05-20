// Workshop Status — Shopify Custom App backend (Vercel serverless entry point)
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
  ADMIN_PASS,
  PORT = 3000,
} = process.env;

const missing = [];
if (!SHOPIFY_SHOP_DOMAIN) missing.push('SHOPIFY_SHOP_DOMAIN');
if (!SHOPIFY_ACCESS_TOKEN) missing.push('SHOPIFY_ACCESS_TOKEN');
if (!ADMIN_PASS) missing.push('ADMIN_PASS');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  if (!process.env.VERCEL) process.exit(1);
}

const API_VERSION = '2025-01';
const GRAPHQL_URL = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.html'),
  'utf8'
);

async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Server not configured — missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN env var on Vercel');
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
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://${SHOPIFY_SHOP_DOMAIN} https://admin.shopify.com;`
  );
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

app.get('/', (_req, res) => {
  if (!ADMIN_PASS) {
    return res.status(500).send('Server not configured — missing ADMIN_PASS env var on Vercel');
  }
  res.send(HTML_TEMPLATE.replace(/\{\{ADMIN_PASS\}\}/g, ADMIN_PASS));
});

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

// Debug endpoint — protected by ADMIN_PASS. Shows env var presence
// (not the full values) and a live Shopify test result.
app.get('/api/debug', requireAuth, async (_req, res) => {
  const mask = (s) => {
    if (!s) return null;
    if (s.length < 12) return '***SHORT***';
    return `${s.slice(0, 6)}_${s.slice(-4)} (length ${s.length})`;
  };
  const info = {
    SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP_DOMAIN || '(missing)',
    SHOPIFY_ACCESS_TOKEN: mask(SHOPIFY_ACCESS_TOKEN),
    ADMIN_PASS: mask(ADMIN_PASS),
    GRAPHQL_URL,
    apiVersion: API_VERSION,
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
