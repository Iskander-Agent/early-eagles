/**
 * generate-shuffle.mjs
 * Generates the deterministic (tier, colorId) assignment for all 210 Early Eagles.
 * 
 * Rules:
 * - Slot 0: Frosty Narwhal (Legendary Azure, cid=0) — reserved, airdropped at deploy
 * - Slot 1: Tiny Marten   (Legendary Gold,  cid=10) — reserved, airdropped at deploy
 * - Slots 2-209: shuffled with remaining 208 assignments
 * 
 * Distribution:
 * - Legendary (10): each a unique 1-of-1 color
 * - Epic (30): from Epic color pool
 * - Rare (40): from Rare color pool  
 * - Uncommon (70): from Uncommon color pool
 * - Common (60): from Common color pool
 *
 * Colors are distributed evenly within each tier — no big concentrations.
 * Seed is derived from SHA-256 of "early-eagles-2026" for reproducibility + transparency.
 */

import { createHash, createHmac } from 'crypto';
import { writeFileSync } from 'fs';

// ── Color definitions ────────────────────────────────────────────────────────
// cid -> name mapping (from locked design)
const COLOR_NAMES = {
  0:'Azure',1:'Amethyst',2:'Fuchsia',3:'Crimson',4:'Amber',
  5:'Jade',6:'Forest',7:'Teal',8:'Prism',9:'Cobalt',
  10:'Gold',11:'Pearl',12:'Sepia',13:'Shadow',14:'Negative',
  15:'Thermal',16:'X-Ray',17:'Aurora',18:'Psychedelic',
  19:'Chartreuse',20:'Violet'
};

// Legendary: 10 unique 1-of-1 colors, one per eagle
const LEG_COLORS = [0,10,16,17,18,15,14,12,13,11]; // Azure,Gold,X-Ray,Aurora,Psychedelic,Thermal,Negative,Sepia,Shadow,Pearl

// Color pools per tier (Legendary handled separately as 1-of-1)
const EPIC_POOL    = [0,1,3,4,11,6,7,8,19,13];   // 10 colors, 3 each = 30
const RARE_POOL    = [0,1,3,4,11,6,7,8,19,13];   // 10 colors, 4 each = 40
const UNCOMMON_POOL= [0,1,2,3,4,5,6,7,8,9,19,20]; // 12 colors, ~5-6 each = 70
const COMMON_POOL  = [0,1,2,3,4,5,6,7,8,9,19,20]; // 12 colors, 5 each = 60

const TIERS = { LEGENDARY:0, EPIC:1, RARE:2, UNCOMMON:3, COMMON:4 };

// ── Deterministic shuffle (Fisher-Yates with seeded RNG) ────────────────────
class SeededRNG {
  constructor(seed) {
    this.state = createHash('sha256').update(seed).digest();
    this.pos = 0;
  }
  next() {
    if (this.pos + 4 > this.state.length) {
      this.state = createHash('sha256').update(this.state).digest();
      this.pos = 0;
    }
    const val = this.state.readUInt32BE(this.pos);
    this.pos += 4;
    return val;
  }
  nextFloat() { return this.next() / 0xFFFFFFFF; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.nextFloat() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ── Build assignment list ────────────────────────────────────────────────────
const rng = new SeededRNG('early-eagles-2026');

// Build 208 remaining assignments (after 2 reserved deploy mints)
// Legendaries remaining: 8 (Gold and Azure already used for slots 0 and 1)
const remainingLegColors = LEG_COLORS.filter(c => c !== 0 && c !== 10); // 8 remaining

// Build arrays with even distribution
function buildPool(pool, count) {
  const result = [];
  const perColor = Math.floor(count / pool.length);
  const extras = count % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const qty = perColor + (i < extras ? 1 : 0);
    for (let j = 0; j < qty; j++) result.push(pool[i]);
  }
  return result;
}

const epicColors    = buildPool(EPIC_POOL, 30);      // 30
const rareColors    = buildPool(RARE_POOL, 40);      // 40
const uncommonColors= buildPool(UNCOMMON_POOL, 70);  // 70
const commonColors  = buildPool(COMMON_POOL, 60);    // 60

// Verify: 8 + 30 + 40 + 70 + 60 = 208
const total208 = remainingLegColors.length + epicColors.length + rareColors.length + uncommonColors.length + commonColors.length;
console.log(`208 check: ${total208} (should be 208)`);

// Build assignment objects
const assignments208 = [
  ...remainingLegColors.map(cid => ({ tier: TIERS.LEGENDARY, cid })),
  ...epicColors.map(cid => ({ tier: TIERS.EPIC, cid })),
  ...rareColors.map(cid => ({ tier: TIERS.RARE, cid })),
  ...uncommonColors.map(cid => ({ tier: TIERS.UNCOMMON, cid })),
  ...commonColors.map(cid => ({ tier: TIERS.COMMON, cid })),
];

// Shuffle
rng.shuffle(assignments208);

// Full 210 with reserved slots prepended
const all210 = [
  { slot: 0, tier: TIERS.LEGENDARY, cid: 0,  name: 'Frosty Narwhal', reserved: true },  // Azure
  { slot: 1, tier: TIERS.LEGENDARY, cid: 10, name: 'Tiny Marten',    reserved: true },  // Gold
  ...assignments208.map((a, i) => ({ slot: i + 2, ...a, reserved: false })),
];

// ── Stats ────────────────────────────────────────────────────────────────────
const tierCounts = [0,0,0,0,0];
const colorCounts = {};
for (const a of all210) {
  tierCounts[a.tier]++;
  colorCounts[a.cid] = (colorCounts[a.cid] || 0) + 1;
}
console.log('\nTier distribution:');
['Legendary','Epic','Rare','Uncommon','Common'].forEach((t,i) => 
  console.log(`  ${t}: ${tierCounts[i]}`));

console.log('\nColor distribution (top 10):');
Object.entries(colorCounts)
  .sort((a,b) => b[1]-a[1])
  .slice(0,10)
  .forEach(([cid,cnt]) => console.log(`  ${COLOR_NAMES[cid]} (${cid}): ${cnt}`));

// Verify all Legendary colors are unique
const legSlots = all210.filter(a => a.tier === 0);
const legColorSet = new Set(legSlots.map(a => a.cid));
console.log(`\nLegendary unique colors: ${legColorSet.size} / ${legSlots.length} (should be 10/10)`);

// ── Commitment hash ──────────────────────────────────────────────────────────
const commitData = JSON.stringify(all210.map(a => `${a.tier},${a.cid}`));
const commitHash = createHash('sha256').update(commitData).digest('hex');
console.log('\nCommitment hash:', commitHash);
console.log('(Publish this hash before launch for verifiability)');

// ── Save ─────────────────────────────────────────────────────────────────────
writeFileSync(
  '/home/ghislo/workspace/nft/early-eagles/shuffle.json',
  JSON.stringify({ commitHash, seed: 'early-eagles-2026', assignments: all210 }, null, 2)
);
console.log('\n✅ shuffle.json written');
