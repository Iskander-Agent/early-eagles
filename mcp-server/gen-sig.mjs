/**
 * gen-sig.mjs — generate an Eagle MCP auth signature for the current 10-min bucket.
 *
 * Usage:
 *   EAGLE_PRIVATE_KEY=<64-char hex> node gen-sig.mjs
 *
 * Output (stdout):
 *   { "address": "SP...", "sig": "<130-char hex>", "valid_until": "<ISO>" }
 *
 * The sig is valid for the current 10-minute bucket + the previous one (~20 min total).
 * Re-run before starting a Claude Code session if your last sig is older than 20 min.
 */

import { sha256 } from '@noble/hashes/sha256';
import {
  createStacksPrivateKey,
  signMessageHashRsv,
  getAddressFromPrivateKey,
  TransactionVersion,
} from '@stacks/transactions';

const raw = process.env.EAGLE_PRIVATE_KEY;
if (!raw) {
  console.error('Error: set EAGLE_PRIVATE_KEY env var (64-char hex private key)');
  process.exit(1);
}

const privateKey = createStacksPrivateKey(raw);
const address    = getAddressFromPrivateKey(raw, TransactionVersion.Mainnet);

const bucket   = Math.floor(Date.now() / 600_000);
const nonce    = `EaglesNest:${address}:${bucket}`;
const hashHex  = Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex');
const { data: sig } = signMessageHashRsv({ messageHash: hashHex, privateKey });

const validUntil = new Date((bucket + 1) * 600_000).toISOString();

console.log(JSON.stringify({ address, sig, valid_until: validUntil }, null, 2));
