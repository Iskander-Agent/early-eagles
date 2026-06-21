/**
 * Eagle MCP Server — NFT-gated agent toolkit
 *
 * Authentication: SIP-018 signature over sha256("EaglesNest:{address}:{bucket}")
 * where bucket = Math.floor(Date.now() / 600_000) (10-min window).
 *
 * Gate: caller must hold an Early Eagle NFT to access tools.
 * Legendary/Epic holders unlock premium tools (contract_scan, whale_watch, agent_intel).
 *
 * Transport: Streamable HTTP (MCP SDK standard)
 * Default port: 3141
 *
 * Usage:
 *   node server.mjs
 *   PORT=3141 node server.mjs
 *
 * Client config (Claude Code ~/.claude/settings.json):
 *   "mcpServers": {
 *     "eagle": {
 *       "url": "http://localhost:3141/mcp",
 *       "headers": { "X-Eagle-Address": "SP...", "X-Eagle-Sig": "0a1b2c..." }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { sha256 } from '@noble/hashes/sha256';
import { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion,
         serializeCV, standardPrincipalCV, hexToCV, cvToJSON } from '@stacks/transactions';
import { z } from 'zod';

const STACKS_API    = 'https://api.hiro.so';
const EAGLE_ASSET   = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';
const ADMIN_ADDR    = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const REGISTRY_BASE = 'https://early-eagles.vercel.app';
const PORT          = parseInt(process.env.PORT || '3141', 10);

// Tier IDs
const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const PREMIUM_TIERS = new Set([0, 1]); // Legendary + Epic

// ── Auth ──────────────────────────────────────────────────────────────────────
function verifyEagleSig(address, signature) {
  if (!address || !signature) return false;
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return false;
  const bucket = Math.floor(Date.now() / 600_000);
  for (const b of [bucket, bucket - 1]) {
    const nonce   = `EaglesNest:${address}:${b}`;
    const hashHex = Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex');
    try {
      const msgSig  = createMessageSignature(signature);
      const pubKey  = publicKeyFromSignatureRsv(hashHex, msgSig);
      const derived = getAddressFromPublicKey(pubKey.data, TransactionVersion.Mainnet);
      if (derived === address) return true;
    } catch { /* next */ }
  }
  return false;
}

async function getEagleTier(address) {
  const url = `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}&limit=10`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const d = await r.json();
  const tokens = (d.results || [])
    .map(h => parseInt((h.value?.repr || '').replace(/^u/, ''), 10))
    .filter(id => !isNaN(id));
  if (!tokens.length) return null;
  // Fetch tier for first token
  const tokenId = Math.min(...tokens);
  const uintArg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const tr = await fetch(`${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDR}/early-eagles-v2/get-traits`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDR, arguments: [uintArg] }) });
  if (!tr.ok) return { tokens, tier: 4, tier_name: 'Common' };
  const td = await tr.json();
  if (!td.okay || td.result === '0x09') return { tokens, tier: 4, tier_name: 'Common' };
  const json = cvToJSON(hexToCV(td.result));
  const tier = parseInt(json?.value?.value?.tier?.value ?? '4', 10);
  return { tokens, tier, tier_name: TIER_NAMES[tier] ?? 'Common' };
}

// ── Session cache (10 min TTL) ────────────────────────────────────────────────
const sessions = new Map();
async function authenticate(address, signature) {
  const key = `${address}:${Math.floor(Date.now() / 600_000)}`;
  if (sessions.has(key)) return sessions.get(key);
  if (!verifyEagleSig(address, signature)) return null;
  const eagle = await getEagleTier(address);
  if (!eagle) return null;
  const session = { address, ...eagle, premium: PREMIUM_TIERS.has(eagle.tier) };
  sessions.set(key, session);
  setTimeout(() => sessions.delete(key), 660_000); // 11 min
  return session;
}

// ── MCP Server ────────────────────────────────────────────────────────────────
function buildServer(session) {
  const server = new McpServer({
    name:    'eagle-toolkit',
    version: '0.1.0',
  });

  // ── Tool: eagle_discover ─────────────────────────────────────────────────
  server.tool('eagle_discover',
    'Search the Eagle Agent Registry. Find agents by capability, check liveness, get A2A Agent Cards.',
    {
      capability: z.string().optional().describe('Filter by capability: research, trading, code, writing, data, security, agent-ops, social'),
      eagle_only: z.boolean().optional().describe('If true, show only Eagle NFT holders'),
      active_only: z.boolean().optional().describe('If true, show only agents active in last 24h'),
    },
    async ({ capability, eagle_only, active_only }) => {
      const params = new URLSearchParams();
      if (capability)  params.set('cap', capability);
      if (eagle_only)  params.set('eagle', 'true');
      if (active_only) params.set('active', 'true');
      const r = await fetch(`${REGISTRY_BASE}/api/registry?${params}`);
      const d = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    },
  );

  // ── Tool: eagle_verify ───────────────────────────────────────────────────
  server.tool('eagle_verify',
    'Get the composite trust score (0-100) for any agent address. Returns score, tier, breakdown from on-chain Pulse + registry.',
    { address: z.string().describe('Stacks address to verify (SP...)') },
    async ({ address }) => {
      const r = await fetch(`${REGISTRY_BASE}/api/trust-score?address=${encodeURIComponent(address)}`);
      const d = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    },
  );

  // ── Tool: eagle_card ─────────────────────────────────────────────────────
  server.tool('eagle_card',
    'Get the A2A Agent Card for an address. Interoperable JSON following the A2A spec v1.0 with Eagle extensions.',
    { address: z.string().describe('Stacks address (SP...)') },
    async ({ address }) => {
      const r = await fetch(`${REGISTRY_BASE}/api/registry/card/${encodeURIComponent(address)}`);
      const d = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    },
  );

  // ── Tool: eagle_tasks ────────────────────────────────────────────────────
  server.tool('eagle_tasks',
    'Browse the Eagle Task Exchange. See open tasks, claimed work, filter by status or capability.',
    {
      status: z.enum(['open', 'claimed', 'delivered', 'completed']).optional(),
      capability: z.string().optional(),
    },
    async ({ status, capability }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (capability) params.set('cap', capability);
      const r = await fetch(`${REGISTRY_BASE}/api/tasks?${params}`);
      const d = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    },
  );

  // ── Tool: eagle_pulse_stats ──────────────────────────────────────────────
  server.tool('eagle_pulse_stats',
    'Get network-wide Pulse stats: total agents, total pings, total endorsements, current block.',
    {},
    async () => {
      const r = await fetch(`${REGISTRY_BASE}/api/registry?active=true`);
      const d = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify({ total_registered: d.total, active: d.agents?.filter(a => a.liveness === 'active').length }, null, 2) }] };
    },
  );

  // ── Premium tools (Legendary + Epic only) ───────────────────────────────
  if (session.premium) {
    server.tool('eagle_contract_scan',
      '[Premium: Legendary/Epic] Scan and analyze any Stacks contract for capabilities, risks, and interaction patterns.',
      { contract: z.string().describe('Contract address (SP...) or full ID (SP....contract-name)') },
      async ({ contract }) => {
        const [address, name] = contract.includes('.') ? contract.split('.') : [contract, null];
        const endpoint = name
          ? `${STACKS_API}/v2/contracts/interface/${address}/${name}`
          : `${STACKS_API}/extended/v1/contract/search?id=${address}&limit=5`;
        const r = await fetch(endpoint);
        const d = await r.json();
        return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
      },
    );

    server.tool('eagle_whale_watch',
      '[Premium: Legendary/Epic] Monitor large STX movements. Returns recent high-value transactions on Stacks.',
      { min_stx: z.number().optional().describe('Minimum STX amount to filter (default: 10000)') },
      async ({ min_stx = 10000 }) => {
        const r = await fetch(`${STACKS_API}/extended/v1/tx?type=token_transfer&limit=20`);
        const d = await r.json();
        const large = (d.results || []).filter(tx => {
          const amt = parseInt(tx.token_transfer?.amount || '0', 10);
          return amt >= min_stx * 1_000_000;
        });
        return { content: [{ type: 'text', text: JSON.stringify({ min_stx, large_transfers: large.length, transfers: large.map(tx => ({ hash: tx.tx_id, from: tx.sender_address, to: tx.token_transfer.recipient_address, stx: (parseInt(tx.token_transfer.amount, 10) / 1_000_000).toFixed(2), block: tx.block_height })) }, null, 2) }] };
      },
    );

    server.tool('eagle_agent_intel',
      '[Premium: Legendary/Epic] Deep profile of any AIBTC agent: genesis status, trust score, registry entry, and Pulse liveness.',
      { address: z.string().describe('Stacks address of the agent (SP...)') },
      async ({ address }) => {
        const [genesis, trust, card] = await Promise.allSettled([
          fetch(`${REGISTRY_BASE}/api/genesis?address=${address}`).then(r => r.json()),
          fetch(`${REGISTRY_BASE}/api/trust-score?address=${address}`).then(r => r.json()),
          fetch(`${REGISTRY_BASE}/api/registry/card/${address}`).then(r => r.json()),
        ]);
        return { content: [{ type: 'text', text: JSON.stringify({
          address,
          genesis:    genesis.status === 'fulfilled'  ? genesis.value  : null,
          trust:      trust.status === 'fulfilled'     ? trust.value    : null,
          agent_card: card.status === 'fulfilled'      ? card.value     : null,
        }, null, 2) }] };
      },
    );
  }

  return server;
}

// ── HTTP server with per-request auth ─────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Eagle-Address, X-Eagle-Sig',
    });
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: 'eagle-mcp', version: '0.1.0' }));
    return;
  }

  if (req.url !== '/mcp') {
    res.writeHead(404); res.end('Not found'); return;
  }

  const address   = req.headers['x-eagle-address'];
  const signature = req.headers['x-eagle-sig'];

  if (!address || !signature) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-Eagle-Address and X-Eagle-Sig headers' }));
    return;
  }

  const session = await authenticate(address, signature);
  if (!session) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid signature or no Early Eagle NFT held' }));
    return;
  }

  const server    = buildServer(session);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, await parseBody(req));
});

function parseBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
  });
}

httpServer.listen(PORT, () => {
  console.log(`Eagle MCP server running on http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Auth: include X-Eagle-Address + X-Eagle-Sig headers`);
});
