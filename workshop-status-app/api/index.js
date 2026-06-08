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

// DTF roll is 56 cm wide. Individual transfer SKUs get tiled onto it; the
// roll length consumed per unit is (length / units-per-row).
// Each entry: width is the side placed across the 56 cm roll, length is the
// side along the roll's length. Orientation chosen to minimise per-unit cost.
const ROLL_WIDTH_CM = 56;

const DTF_TILED = {
  '5x5-DTF':       { width: 5,    length: 5   },
  '7x7-DTF':       { width: 7,    length: 7   },
  '10x10-DTF':     { width: 10,   length: 10  },
  '12.5x12.5-DTF': { width: 12.5, length: 12.5 },
  '15x15-DTF':     { width: 15,   length: 15  },
  '17x17-DTF':     { width: 17,   length: 17  },
  '25x25-DTF':     { width: 25,   length: 25  },
  '25x55-DTF':     { width: 55,   length: 25  },  // 55 fits in 56, 25 along length
  '28x28-DTF':     { width: 28,   length: 28  },
  'A4-DTF':        { width: 21,   length: 30  },  // 2 fit across (21+21<56), 30 long
  'A3-DTF':        { width: 42,   length: 30  },  // 1 fits across, 30 long (rotated)
};

// Gang sheet SKUs are full-width: each unit consumes its full length of roll.
const DTF_GANG_CM = {
  'DTF_GANG_100': 100,
  'DTF_GANG_125': 125,
  'DTF_GANG_150': 150,
  'DTF_GANG_175': 175,
  'DTF_GANG_200': 200,
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
  const topics = ['ORDERS_PAID', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED', 'ORDERS_UPDATED'];
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
          machine_a_online: metafield(namespace: "dtfcapacity", key: "machine_a_online") { value }
          machine_b_online: metafield(namespace: "dtfcapacity", key: "machine_b_online") { value }
          machine_a_queue: metafield(namespace: "dtfcapacity", key: "machine_a_queue") { value }
          machine_b_queue: metafield(namespace: "dtfcapacity", key: "machine_b_queue") { value }
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
        type: 'number_decimal',
        value: String(Number(total.toFixed(2))),
      });
    }
    if (Number.isFinite(used)) {
      if (used < 0 || used > 100000) {
        return res.status(400).json({ error: 'Invalid used (must be 0–100000)' });
      }
      const safeUsed = Math.max(0, Number(used.toFixed(2)));
      metafields.push({
        ownerId: shopGid,
        namespace: 'dtfcapacity',
        key: 'used',
        type: 'number_decimal',
        value: String(safeUsed),
      });
      // Auto-update DTF status pill to match the new queue
      metafields.push({
        ownerId: shopGid,
        namespace: 'workshop_status',
        key: 'dtf',
        type: 'single_line_text_field',
        value: queueToStatus(safeUsed),
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

// ─── API: toggle Machine A / B online state ───────────────────────────────
app.post('/api/machine', requireAuth, async (req, res) => {
  try {
    const { machine, online } = req.body || {};
    if (machine !== 'A' && machine !== 'B') {
      return res.status(400).json({ error: 'machine must be "A" or "B"' });
    }
    if (typeof online !== 'boolean') {
      return res.status(400).json({ error: 'online must be a boolean' });
    }
    const shopGid = await getShopGid();
    const key = machine === 'A' ? 'machine_a_online' : 'machine_b_online';
    const mutation = `
      mutation SetOnline($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;
    const variables = {
      metafields: [{
        ownerId: shopGid,
        namespace: 'dtfcapacity',
        key,
        type: 'boolean',
        value: online ? 'true' : 'false',
      }],
    };
    const data = await shopifyGraphQL(mutation, variables);
    const errors = data.data?.metafieldsSet?.userErrors || [];
    if (errors.length) return res.status(400).json({ error: 'Shopify rejected', details: errors });
    res.json({ ok: true, machine, online });
  } catch (e) {
    console.error('POST /api/machine error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: customer-facing order tracker ───────────────────────────────────
// GET /api/track?order=1234 → returns { found, name, machine, setupAt, fulfillmentStatus, displayFinancialStatus }
// No auth — designed for the storefront tracker form. Only exposes setup info.
app.get('/api/track', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  try {
    let raw = (req.query.order || '').toString().trim();
    if (!raw) return res.status(400).json({ error: 'Provide ?order=N' });
    // Normalise: strip leading '#' if present. Allow letters + digits
    // (Shopify order prefixes like DTFN25398) plus dashes/underscores.
    const cleaned = raw.replace(/^#/, '').trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(cleaned)) {
      return res.status(400).json({ error: 'Invalid order number format' });
    }
    const query = `
      query LookupOrder($q: String!) {
        orders(first: 1, query: $q) {
          edges {
            node {
              id
              name
              displayFulfillmentStatus
              displayFinancialStatus
              machine: metafield(namespace: "custom", key: "machine") { value }
              setupAt: metafield(namespace: "custom", key: "setup_at") { value }
            }
          }
        }
      }
    `;
    // Try the order name verbatim (e.g. DTFN25398). If no match, retry with
    // a '#' prefix (the default Shopify name format like #1234).
    let data = await shopifyGraphQL(query, { q: `name:${cleaned}` });
    if (!(data.data?.orders?.edges || []).length) {
      data = await shopifyGraphQL(query, { q: `name:#${cleaned}` });
    }
    const edge = data.data?.orders?.edges?.[0];
    if (!edge) return res.json({ found: false });
    const node = edge.node;
    res.json({
      found: true,
      name: node.name,
      machine: node.machine?.value || null,
      setupAt: node.setupAt?.value || null,
      fulfillmentStatus: node.displayFulfillmentStatus,
      financialStatus: node.displayFinancialStatus,
    });
  } catch (e) {
    console.error('GET /api/track error:', e);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ─── Helper: recalculate machine_a/b queues from order metafields ─────────
// Sums dtf_queued_cm (in metres) for unfulfilled orders grouped by custom.machine.
async function recalculateMachineQueues() {
  const query = `
    {
      orders(first: 250, query: "fulfillment_status:unfulfilled") {
        edges {
          node {
            id
            machine: metafield(namespace: "custom", key: "machine") { value }
            queued: metafield(namespace: "custom", key: "custom_dtf_queued_cm") { value }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  const edges = data.data?.orders?.edges || [];
  const totals = { A: 0, B: 0 };
  for (const e of edges) {
    const m = (e.node.machine?.value || '').toUpperCase();
    const meters = Number(e.node.queued?.value) || 0;
    if (m === 'A') totals.A += meters;
    else if (m === 'B') totals.B += meters;
  }
  const shopGid = await getShopGid();
  const mutation = `
    mutation SetMachineQueues($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      { ownerId: shopGid, namespace: 'dtfcapacity', key: 'machine_a_queue', type: 'number_decimal', value: String(Number(totals.A.toFixed(2))) },
      { ownerId: shopGid, namespace: 'dtfcapacity', key: 'machine_b_queue', type: 'number_decimal', value: String(Number(totals.B.toFixed(2))) },
    ],
  };
  await shopifyGraphQL(mutation, variables);
  return totals;
}

// ─── Helper: stamp custom.setup_at when machine assigned but setup_at empty ─
// ─── Helper: post a comment to the order's Timeline ───────────────────────
// Tries Shopify Admin GraphQL's commentEventCreate mutation. If that's
// not available, falls back to appending to the order's Notes field.
async function postTimelineComment(orderGid, body) {
  const result = await shopifyGraphQL(`
    mutation PostComment($subjectId: ID!, $body: String!) {
      commentEventCreate(input: { subjectId: $subjectId, body: $body }) {
        commentEvent { id }
        userErrors { field message }
      }
    }
  `, { subjectId: orderGid, body });

  // Surface top-level GraphQL errors (e.g. mutation doesn't exist on this API version)
  if (result.errors?.length) {
    console.error('commentEventCreate GraphQL errors:', JSON.stringify(result.errors));
    // Fall back to Notes append so the comment isn't lost
    return appendOrderNoteFallback(orderGid, body);
  }
  const errs = result.data?.commentEventCreate?.userErrors || [];
  if (errs.length) {
    console.error('commentEventCreate userErrors:', JSON.stringify(errs));
    return appendOrderNoteFallback(orderGid, body);
  }
  console.log('Timeline comment posted on', orderGid);
}

// Fallback: append to Order.note field if commentEventCreate isn't available.
async function appendOrderNoteFallback(orderGid, line) {
  const data = await shopifyGraphQL(`
    query GetNote($id: ID!) { order(id: $id) { note } }
  `, { id: orderGid });
  const current = (data.data?.order?.note || '').trim();
  const newNote = current ? current + '\n' + line : line;
  const result = await shopifyGraphQL(`
    mutation UpdateNote($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }
  `, { input: { id: orderGid, note: newNote } });
  const errs = result.data?.orderUpdate?.userErrors || [];
  if (errs.length) console.error('appendOrderNoteFallback errors:', JSON.stringify(errs));
  else console.log('Note fallback used on', orderGid);
}

async function maybeStampSetupAt(orderGid) {
  const data = await shopifyGraphQL(`
    query Check($id: ID!) {
      order(id: $id) {
        machine: metafield(namespace: "custom", key: "machine") { value }
        setupAt: metafield(namespace: "custom", key: "setup_at") { value }
      }
    }
  `, { id: orderGid });
  const machine = (data.data?.order?.machine?.value || '').toUpperCase();
  const setupAt = data.data?.order?.setupAt?.value;
  if ((machine === 'A' || machine === 'B') && !setupAt) {
    const nowIso = new Date().toISOString();
    const mutation = `
      mutation Stamp($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;
    await shopifyGraphQL(mutation, {
      metafields: [{
        ownerId: orderGid,
        namespace: 'custom',
        key: 'setup_at',
        type: 'date_time',
        value: nowIso,
      }],
    });
    // Post a comment to the order's Timeline (admin only).
    const stamp = new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    try {
      await postTimelineComment(orderGid, `Setup on Machine ${machine} at ${stamp}`);
    } catch (e) {
      console.error('postTimelineComment failed for', orderGid, e.message);
    }
  }
}

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

// Per-unit roll length (cm) for a tiled SKU on the 56 cm roll.
// Fair share = length / (units that fit across the roll width).
function tiledCmPerUnit(sku) {
  const dims = DTF_TILED[sku];
  if (!dims) return 0;
  const perRow = Math.max(1, Math.floor(ROLL_WIDTH_CM / dims.width));
  return dims.length / perRow;
}

// Returns the total metres of DTF roll consumed by these line items.
// - Gang sheets (DTF_GANG_*): full length per unit.
// - Tiled SKUs (DTF_TILED): fair-share length per unit on the 56 cm roll.
// IMPORTANT: dtfcapacity.total and dtfcapacity.used metafields are in METRES,
// so this must return metres for the webhook adds/subtracts to be correct.
function lineItemsToMeters(lineItems = []) {
  let totalCm = 0;
  for (const item of lineItems) {
    const sku = item.sku;
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    if (DTF_GANG_CM[sku]) {
      totalCm += DTF_GANG_CM[sku] * qty;
    } else if (DTF_TILED[sku]) {
      totalCm += tiledCmPerUnit(sku) * qty;
    }
  }
  return Math.round(totalCm) / 100;
}

// NOTE: the metafield is named `dtf_queued_cm` for back-compat with the
// existing Order metafield definition (custom.dtf_queued_cm), but the value
// is actually stored in METRES to match the dtfcapacity.used unit.
async function getOrderQueuedMeters(orderGid) {
  const data = await shopifyGraphQL(`
    query OrderQueued($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom", key: "custom_dtf_queued_cm") { value }
      }
    }
  `, { id: orderGid });
  const v = data.data?.order?.metafield?.value;
  return v ? Number(v) : 0;
}

async function setOrderQueuedMeters(orderGid, meters) {
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
      key: 'custom_dtf_queued_cm',
      type: 'number_decimal',
      value: String(Number(meters.toFixed(2))),
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

// Map queue meterage (cm) to a DTF status key.
// Thresholds:
//   < 100 cm        → not_busy
//   100 – 199 cm    → moderate
//   200 – 299 cm    → busy
//   300 cm or more  → full_capacity
function queueToStatus(cm) {
  if (cm >= 300) return 'full_capacity';
  if (cm >= 200) return 'busy';
  if (cm >= 100) return 'moderate';
  return 'not_busy';
}

async function writeCapacityUsed(newUsed) {
  const shopGid = await getShopGid();
  const safeUsed = Math.max(0, Number(Number(newUsed).toFixed(2)));
  const status = queueToStatus(safeUsed);
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
        type: 'number_decimal',
        value: String(safeUsed),
      },
      {
        ownerId: shopGid,
        namespace: 'workshop_status',
        key: 'dtf',
        type: 'single_line_text_field',
        value: status,
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
      const meters = lineItemsToMeters(order.line_items);
      if (meters <= 0) return res.status(200).send('no dtf');

      const alreadyQueued = await getOrderQueuedMeters(orderGid);
      if (alreadyQueued > 0) {
        console.log(`Order ${orderId} already queued at ${alreadyQueued}m — skipping`);
        return res.status(200).send('already queued');
      }

      const current = await readCapacityUsed();
      await writeCapacityUsed(current + meters);
      await setOrderQueuedMeters(orderGid, meters);
      await recalculateMachineQueues();
    } else if (topic === 'orders/fulfilled' || topic === 'orders/cancelled') {
      const queuedMeters = await getOrderQueuedMeters(orderGid);
      if (queuedMeters <= 0) {
        console.log(`Order ${orderId} ${topic} but no queued meters — skipping`);
        await recalculateMachineQueues();
        return res.status(200).send('not queued');
      }
      const current = await readCapacityUsed();
      await writeCapacityUsed(Math.max(0, current - queuedMeters));
      await setOrderQueuedMeters(orderGid, 0);
      await recalculateMachineQueues();
      console.log(`Order ${orderId} ${topic} → -${queuedMeters}m (queue ${current}→${Math.max(0, current - queuedMeters)})`);

    } else if (topic === 'orders/updated') {
      await maybeStampSetupAt(orderGid);
      await recalculateMachineQueues();
      console.log(`Order ${orderId} updated → recalculated machine queues`);

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
