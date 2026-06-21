#!/usr/bin/env node
/**
 * Build public/api/pulse-leaderboard.json
 * Queries eagle-pulse-v1 get-agent-profile for each holder in agent-registry.json.
 * Sorts by ping-count desc; unregistered agents appear at bottom with ping_count 0.
 *
 * Usage: node scripts/build-pulse-leaderboard.mjs
 */

import { hexToCV, cvToJSON, principalCV, serializeCV } from '@stacks/transactions';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const REPO   = join(__dir, '..');
const OUT    = join(REPO, 'public', 'api', 'pulse-leaderboard.json');
const REG    = join(REPO, 'public', 'api', 'agent-registry.json');

const STACKS_API       = 'https://api.hiro.so';
const CONTRACT_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const CONTRACT_NAME    = 'eagle-pulse-v1';

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

async function callReadOnly(fn, args = []) {
  const r = await fetchWithRetry(
    `${STACKS_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/${fn}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: CONTRACT_ADDRESS, arguments: args }),
    },
    5
  );
  if (!r) return null;
  const d = await r.json();
  if (!d.okay) return null;
  return cvToJSON(hexToCV(d.result));
}

async function getPulseStats() {
  const cv = await callReadOnly('get-pulse-stats');
  if (!cv) throw new Error('get-pulse-stats failed after retries');
  const v = cv.value.value;
  return {
    current_block:      parseInt(v['current-block'].value, 10),
    total_agents:       parseInt(v['total-agents'].value, 10),
    total_pings:        parseInt(v['total-pings'].value, 10),
    total_endorsements: parseInt(v['total-endorsements'].value, 10),
  };
}

async function getAgentProfile(stxAddress) {
  const argHex = '0x' + serializeCV(principalCV(stxAddress));
  const cv = await callReadOnly('get-agent-profile', [argHex]);
  if (!cv) return null;
  // (ok (optional tuple))
  const inner = cv.value;
  if (!inner || (inner.type.startsWith('(optional') && inner.value === null)) return null;
  const v = inner.value?.value ?? inner.value;
  if (!v) return null;
  return {
    ping_count:     parseInt(v['ping-count'].value, 10),
    last_ping:      parseInt(v['last-ping'].value, 10),
    registered_at:  parseInt(v['registered-at'].value, 10),
    status:         v['status'].value,
    tier_onchain:   parseInt(v['tier'].value, 10),
    token_id_pulse: parseInt(v['token-id'].value, 10),
  };
}

async function main() {
  const registry = JSON.parse(readFileSync(REG, 'utf8'));
  console.error(`Registry: ${registry.total} entries`);

  console.error('Fetching pulse stats…');
  const stats = await getPulseStats();
  console.error(`Stats: ${JSON.stringify(stats)}`);

  const entries = [];
  for (const entry of registry.entries) {
    await sleep(100); // stay under Hiro rate limit
    const profile = await getAgentProfile(entry.stx_address);
    const registered = profile !== null;
    entries.push({
      stx_address:   entry.stx_address,
      token_id:      entry.token_id,
      tier:          entry.tier,
      tier_rank:     entry.tier_rank,
      aibtc_agent_id: entry.aibtc_agent_id,
      registered,
      ping_count:    registered ? profile.ping_count   : 0,
      last_ping:     registered ? profile.last_ping     : null,
      registered_at: registered ? profile.registered_at : null,
      status:        registered ? profile.status        : null,
    });
    console.error(`  ${entry.stx_address.slice(0, 10)}… registered=${registered} pings=${registered ? profile.ping_count : 0}`);
  }

  // Sort: registered first by ping_count desc, then unregistered by tier_rank asc
  entries.sort((a, b) => {
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    if (a.ping_count !== b.ping_count) return b.ping_count - a.ping_count;
    return a.tier_rank - b.tier_rank;
  });

  const leaderboard = entries.map((e, i) => ({ rank: i + 1, ...e }));

  const output = {
    generated_at: new Date().toISOString(),
    contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
    stats,
    leaderboard,
  };

  mkdirSync(join(REPO, 'public', 'api'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
  console.error(`Written → ${OUT}`);
  console.log(JSON.stringify({ ok: true, total: leaderboard.length, registered: stats.total_agents, path: OUT }));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
