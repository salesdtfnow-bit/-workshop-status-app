// Workshop Status — Shopify Custom App backend
// Reads/writes the shop's workshop_status metafields. Designed to be embedded
// inside Shopify admin via a Custom App's App URL.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SHOPIFY_SHOP_DOMAIN,       // e.g. dtfnow.myshopify.com
  SHOPIFY_ACCESS_TOKEN,      // Admin API access token from your Custom App
  ADMIN_PASS,                // Any random secret string you choose — protects the API
  PORT = 3000,
} = process.env;

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN || !ADMIN_PASS) {
  console.error('Missing required env vars. Check .env against .env.example');
  process.exit(1);
}

const API_VERSION = '2025-01';
const GRAPHQL_URL = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`Shopify API ${resp.status}`);
  }
  return resp.json();
}

const app = express();
app.use(express.json());

// Allow Shopify admin to embed this app in an iframe
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://${SHOPIFY_SHOP_DOMAIN} https://admin.shopify.com;`
  );
  next();
});

// API auth middleware — protects /api/* against random outside callers
function requireAuth(req, res, next) {
  const pass = req.headers['x-admin-pass'];
  if (!pass) return res.status(401).json({ error: 'Missing X-Admin-Pass header' });
  // Constant-time comparison
  const a = Buffer.from(String(pass));
  const b = Buffer.from(ADMIN_PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
}

// ── Serve the embedded dashboard ────────────────────────────────────────────
app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  res.send(html.replace(/\{\{ADMIN_PASS\}\}/g, ADMIN_PASS));
});

// ── API: read current statuses ──────────────────────────────────────────────
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
    res.status(500).json({ error: e.message });
  }
});

// ── API: update a department status ─────────────────────────────────────────
const VALID_DEPARTMENTS = ['overall', 'dtf', 'uv_dtf', 'vinyl_stickers', 'sublimation', 'artwork_setup'];
const VALID_STATUSES = ['not_busy', 'moderate', 'busy', 'full_capacity'];

app.post('/api/update', requireAuth, async (req, res) => {
  try {
    const { department, status } = req.body;
    if (!VALID_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: 'Invalid department' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Fetch the shop's GraphQL ID (used as ownerId on the metafieldsSet mutation)
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
        {
          ownerId: shopGid,
          namespace: 'workshop_status',
          key: department,
          type: 'single_line_text_field',
          value: status,
        },
        {
          ownerId: shopGid,
          namespace: 'workshop_status',
          key: `${department}_updated`,
          type: 'date_time',
          value: nowIso,
        },
      ],
    };

    const data = await shopifyGraphQL(mutation, variables);
    const errors = data.data?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      return res.status(400).json({ error: 'Shopify rejected the update', details: errors });
    }
    res.json({ ok: true, department, status, updatedAt: nowIso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Workshop Status app on port ${PORT}`);
});
