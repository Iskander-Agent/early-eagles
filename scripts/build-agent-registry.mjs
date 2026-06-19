#!/usr/bin/env node
/**
 * Build public/api/agent-registry.json
 * Maps every minted Eagle token → holder address + tier + AIBTC agent ID (if registered).
 * Run directly or from the curator skill (every 48h).
 *
 * Usage: node scripts/build-agent-registry.mjs
 */

import { hexToCV, cvToJSON } from '@stacks/transactions';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const REPO    = join(__dir, '..');
const OUT     = join(REPO, 'public', 'api', 'agent-registry.json');

const STACKS_API    = 'https://api.hiro.so';
const ADMIN_ADDR    = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT  = 'early-eagles-v2';
const EAGLE_ASSET   = `${ADMIN_ADDR}.${NFT_CONTRACT}::early-eagles`;
const ID_REGISTRY   = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';
const TIER_NAMES    = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
      if (r.ok) return r;
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      return r;
    } catch { if (i < retries - 1) await sleep(1000 * (i + 1)); }
  }
  return null;
}

async function getOwner(tokenId) {
  const uintArg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetchWithRetry(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDR}/${NFT_CONTRACT}/get-owner`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: ADMIN_ADDR, arguments: [uintArg] }) }
  );
  if (!r) return null;
  const data = await r.json();
  if (!data.okay || !data.result || data.result === '0x09') return null;
  try {
    const json = cvToJSON(hexToCV(data.result));
    // Response is (ok (optional principal))
    const principal = json?.value?.value?.value;
    return typeof principal === 'string' ? principal : null;
  } catch { return null; }
}

async function getAllHoldings(totalMinted = 31) {
  const holdings = [];
  for (let tokenId = 0; tokenId < totalMinted; tokenId++) {
    await sleep(60);
    const stx_address = await getOwner(tokenId);
    if (stx_address) holdings.push({ token_id: tokenId, stx_address });
    else console.error(`  token ${tokenId}: no owner (unminted or burned)`);
  }
  return holdings;
}

async function getTraits(tokenId) {
  const uintArg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetchWithRetry(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDR}/${NFT_CONTRACT}/get-traits`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: ADMIN_ADDR, arguments: [uintArg] }) }
  );
  if (!r) return { tier_rank: 4, tier: 'Common' };
  const data = await r.json();
  if (!data.okay || data.result === '0x09') return { tier_rank: 4, tier: 'Common' };
  try {
    const json = cvToJSON(hexToCV(data.result));
    const v    = json?.value?.value;
    if (!v) return { tier_rank: 4, tier: 'Common' };
    const rank = parseInt(v.tier?.value ?? '4', 10);
    return { tier_rank: rank, tier: TIER_NAMES[rank] ?? 'Common' };
  } catch { return { tier_rank: 4, tier: 'Common' }; }
}

async function getAibtcAgentId(address) {
  try {
    const url = `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(ID_REGISTRY)}&limit=1`;
    const r = await fetchWithRetry(url);
    if (!r) return null;
    const d = await r.json();
    const h = (d.results || [])[0];
    if (!h) return null;
    const id = parseInt((h.value?.repr || '').replace(/^u/, ''), 10);
    return isNaN(id) ? null : id;
  } catch { return null; }
}

async function getAibtcLevel(address) {
  try {
    const r = await fetchWithRetry(`https://aibtc.com/api/agents/${address}`);
    if (!r || !r.ok) return { level: null, level_name: null };
    const d = await r.json();
    const level_name = d?.levelName || d?.trust?.levelName || null;
    const level      = d?.level     ?? d?.trust?.level     ?? null;
    return { level, level_name };
  } catch { return { level: null, level_name: null }; }
}

async function main() {
  console.error('Fetching all Eagle holdings…');
  const holdings = await getAllHoldings();
  console.error(`Found ${holdings.length} holdings.`);

  const entries = [];
  for (const h of holdings) {
    await sleep(80); // stay under Hiro rate limit
    const [traits, aibtc_agent_id, aibtcLevel] = await Promise.all([
      getTraits(h.token_id),
      getAibtcAgentId(h.stx_address),
      getAibtcLevel(h.stx_address),
    ]);
    entries.push({
      token_id:        h.token_id,
      stx_address:     h.stx_address,
      aibtc_agent_id,
      aibtc_level:     aibtcLevel.level,
      aibtc_level_name: aibtcLevel.level_name,
      tier:            traits.tier,
      tier_rank:       traits.tier_rank,
    });
    console.error(`  token ${h.token_id}: ${h.stx_address.slice(0, 12)}… tier=${traits.tier} aibtc=${aibtc_agent_id ?? 'none'} level=${aibtcLevel.level_name ?? 'none'}`);
  }

  // Sort by token_id ascending
  entries.sort((a, b) => a.token_id - b.token_id);

  const output = {
    generated_at: new Date().toISOString(),
    contract:     `${ADMIN_ADDR}.${NFT_CONTRACT}`,
    total:        entries.length,
    entries,
  };

  mkdirSync(join(REPO, 'public', 'api'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
  console.error(`Written → ${OUT}`);
  console.log(JSON.stringify({ ok: true, total: entries.length, path: OUT }));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
