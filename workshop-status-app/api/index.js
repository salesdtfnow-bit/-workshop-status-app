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
const OAUTH_SCOPES = 'read_content,write_content,read_metaobjects,write_metaobjects,read_orders,write_orders';

// DTF SKU → cm consumed on the daily capacity (per single unit ordered).
// Multiplied by line-item quantity at runtime, rounded to int.
const DTF_CM = {
  // Gang sheets (length in cm)
  'DTF_GANG_100': 100,
  'DTF_GANG_125': 125,
  'DTF_GANG_150': 150,
  'DTF_GANG_175': 175,
  'DTF_GANG_200': 200,
  // Individual transfers (longer side in cm)
  '5x5-DTF': 5,
  '7x7-DTF': 7,
  '10x10-DTF': 10,
  '12.5x12.5-DTF': 12.5,
  '15x15-DTF': 15,
  '17x17-DTF': 17,
  '25x25-DTF': 25,
  '25x55-DTF': 55,
  '28x28-DTF': 28,
  // A-sized sheets (longer side in cm)
  'A4-DTF': 30,
  'A3-DTF': 42,
};

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
// Capture the raw body so /api/webhooks/orders can verify Shopify's HMAC.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

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

// ─── OAuth: step 2 — exchange code for token, then auto-register webhooks ─
async function registerOrderWebhooks(shop, accessToken, ourHost) {
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const callbackUrl = `https://${ourHost}/api/webhooks/orders`;
  const topics = ['ORDERS_PAID', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED'];
  const results = [];

  const call = async (query, variables) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
    return r.json();
  };

  // Fetch existing subscriptions so we don't create duplicates
  const existingData = await call(`
    {
      webhookSubscriptions(first: 100) {
        edges {
          node {
            id
            topic
            endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
          }
        }
      }
    }
  `);
  const existing = existingData.data?.webhookSubscriptions?.edges || [];

  for (const topic of topics) {
    const already = existing.some(e =>
      e.node.topic === topic && e.node.endpoint?.callbackUrl === callbackUrl
    );
    if (already) {
      results.push({ topic, status: 'already subscribed' });
      continue;
    }
    const created = await call(`
      mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }
    `, {
      topic,
      sub: { callbackUrl, format: 'JSON' },
    });
    const errs = created.data?.webhookSubscriptionCreate?.userErrors || [];
    if (errs.length) {
      results.push({ topic, status: 'error', errors: errs });
    } else {
      results.push({ topic, status: 'created', id: created.data?.webhookSubscriptionCreate?.webhookSubscription?.id });
    }
  }
  return results;
}

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

    // Register order webhooks using the fresh access token (works even before
    // the user has saved the new token to Vercel env vars).
    let webhookResults = [];
    try {
      webhookResults = await registerOrderWebhooks(shop, json.access_token, req.get('host'));
    } catch (e) {
      webhookResults = [{ topic: 'all', status: 'error', error: e.message }];
    }
    const webhookRows = webhookResults.map(r => {
      const colour = r.status === 'created' ? '#15803d' : r.status === 'already subscribed' ? '#6b7280' : '#b91c1c';
      const detail = r.errors ? ' — ' + JSON.stringify(r.errors) : r.error ? ' — ' + r.error : '';
      return `<li style="color:${colour}"><code>${r.topic}</code>: ${r.status}${detail}</li>`;
    }).join('');

    res.send(`<!doctype html>
      <html><head><meta charset="utf-8"><title>OAuth complete</title>
      <style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}
      .token{background:#fef3c7;border:2px solid #d97706;padding:20px;border-radius:8px;font-family:monospace;font-size:16px;word-break:break-all;user-select:all;margin:20px 0}
      .webhooks{background:#f3f4f6;padding:16px 20px;border-radius:8px;margin:20px 0}
      ol,ul{padding-left:20px} li{margin:8px 0}</style></head><body>
      <h1>Success! Your Admin API access token</h1>
      <div class="token">${json.access_token}</div>
      <h2>Webhook subscriptions</h2>
      <div class="webhooks"><ul>${webhookRows}</ul></div>
      <h2>Next steps</h2>
      <ol>
        <li>Click the yellow box above, copy the token.</li>
        <li>Vercel → Settings → Environment Variables → SHOPIFY_ACCESS_TOKEN → paste → save (Production scope!).</li>
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
      <p>
        <a href="/install" target="_top"
           style="display:inline-block;padding:12px 24px;background:#202223;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Run OAuth install (opens at top level)
        </a>
      </p>
      <p style="margin-top:14px;font-size:13px;color:#6b7280">If clicking the button inside Shopify admin doesn't work, open this URL in a new browser tab instead:<br>
        <code style="background:#f3f4f6;padding:4px 6px;border-radius:4px;user-select:all">https://workshop-status-app.vercel.app/install</code>
      </p>
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

// ─── Webhook: orders/paid + orders/fulfilled + orders/cancelled ───────────
// Auto-updates dtfcapacity.used based on DTF SKUs in the order.
// Uses an order-level metafield workshop_status.dtf_queued_cm as an
// idempotency marker — each order can only add once and only subtract once.
function verifyShopifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !req.rawBody || !SHOPIFY_API_SECRET) return false;
  const expected = crypto.createHmac('sha256', SHOPIFY_API_SECRET)
    .update(req.rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(hmac)
    );
  } catch {
    return false;
  }
}

function lineItemsToCm(lineItems = []) {
  let total = 0;
  for (const item of lineItems) {
    const sku = item.sku;
    const qty = Number(item.quantity) || 0;
    const cmPerUnit = DTF_CM[sku];
    if (cmPerUnit && qty > 0) {
      total += Math.round(cmPerUnit * qty);
    }
  }
  return total;
}

async function getOrderQueuedCm(orderGid) {
  const data = await shopifyGraphQL(`
    query OrderQueued($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom", key: "dtf_queued_cm") { value }
      }
    }
  `, { id: orderGid });
  const v = data.data?.order?.metafield?.value;
  return v ? Number(v) : 0;
}

async function setOrderQueuedCm(orderGid, cm) {
  const mutation = `
    mutation SetOrderQueued($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [{
      ownerId: orderGid,
      namespace: 'custom',
      key: 'dtf_queued_cm',
      type: 'number_integer',
      value: String(Math.round(cm)),
    }],
  };
  const data = await shopifyGraphQL(mutation, variables);
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error('metafieldsSet errors: ' + JSON.stringify(errors));
}

async function readCapacityUsed() {
  const data = await shopifyGraphQL(`
    {
      shop {
        used: metafield(namespace: "dtfcapacity", key: "used") { value }
      }
    }
  `);
  const v = data.data?.shop?.used?.value;
  return v ? Number(v) : 0;
}

async function writeCapacityUsed(newUsed) {
  const shopGid = await getShopGid();
  const mutation = `
    mutation SetUsed($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId: shopGid,
        namespace: 'dtfcapacity',
        key: 'used',
        type: 'number_integer',
        value: String(Math.max(0, Math.round(newUsed))),
      },
      {
        ownerId: shopGid,
        namespace: 'workshop_status',
        key: 'dtf_updated',
        type: 'date_time',
        value: new Date().toISOString(),
      },
    ],
  };
  const data = await shopifyGraphQL(mutation, variables);
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error('writeCapacityUsed errors: ' + JSON.stringify(errors));
}

app.post('/api/webhooks/orders', async (req, res) => {
  // Always 200 quickly so Shopify doesn't retry — handle errors silently.
  if (!verifyShopifyHmac(req)) {
    console.error('Webhook HMAC verification failed');
    return res.status(401).send('Invalid HMAC');
  }
  const topic = req.headers['x-shopify-topic']; // e.g. "orders/paid"
  const order = req.body;
  const orderId = order?.id;
  if (!orderId) return res.status(200).send('no order id');

  const orderGid = `gid://shopify/Order/${orderId}`;
  try {
    if (topic === 'orders/paid') {
      const cm = lineItemsToCm(order.line_items);
      if (cm <= 0) return res.status(200).send('no dtf');

      const alreadyQueued = await getOrderQueuedCm(orderGid);
      if (alreadyQueued > 0) {
        console.log(`Order ${orderId} already queued at ${alreadyQueued}cm — skipping`);
        return res.status(200).send('already queued');
      }

      const current = await readCapacityUsed();
      await writeCapacityUsed(current + cm);
      await setOrderQueuedCm(orderGid, cm);
      console.log(`Order ${orderId} paid → +${cm}cm (queue ${current}→${current + cm})`);

    } else if (topic === 'orders/fulfilled' || topic === 'orders/cancelled') {
      const queuedCm = await getOrderQueuedCm(orderGid);
      if (queuedCm <= 0) {
        console.log(`Order ${orderId} ${topic} but no queued cm — skipping`);
        return res.status(200).send('not queued');
      }
      const current = await readCapacityUsed();
      await writeCapacityUsed(Math.max(0, current - queuedCm));
      await setOrderQueuedCm(orderGid, 0);
      console.log(`Order ${orderId} ${topic} → -${queuedCm}cm (queue ${current}→${Math.max(0, current - queuedCm)})`);

    } else {
      console.log(`Webhook topic ${topic} not handled`);
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(200).send('handled with errors');
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Workshop Status app on port ${PORT}`);
  });
}

export default app;
