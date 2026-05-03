#!/usr/bin/env node
/**
 * scan.js — Ross Cameron / Warrior Trading HOD Momentum Scanner
 *
 * Hits TradingView's screener API, applies Ross's exact criteria,
 * filters out OTC, then updates rules.json watchlist in-place.
 *
 * Usage:
 *   node scripts/scan.js              # scan + update rules.json
 *   node scripts/scan.js --dry-run   # scan only, print results, don't write
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', 'rules.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Ross Cameron scanner criteria ─────────────────────────────────────────────
const SCAN_BODY = {
  filter: [
    { left: 'close',                      operation: 'greater', right: 1    },  // min $1
    { left: 'close',                      operation: 'less',    right: 20   },  // max $20
    { left: 'change',                     operation: 'greater', right: 10   },  // up 10%+ today
    { left: 'relative_volume_10d_calc',   operation: 'greater', right: 5    },  // 5x+ rel vol
    { left: 'float_shares_outstanding',   operation: 'less',    right: 20e6 },  // float < 20M
  ],
  options: { lang: 'en' },
  columns: [
    'name',
    'close',
    'change',
    'relative_volume_10d_calc',
    'float_shares_outstanding',
    'volume',
    'exchange',
    'description',
  ],
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  range: [0, 25],
};

// Exchanges Ross trades — no OTC / pink sheets
const ALLOWED_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'NYSE MKT']);

// ── Fetch from TradingView screener ───────────────────────────────────────────
function fetchScanner() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(SCAN_BODY);
    const req = https.request(
      {
        hostname: 'scanner.tradingview.com',
        path: '/america/scan',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse failed: ${raw.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Running HOD Momentum Scanner (Ross Cameron criteria)...\n');

  const raw = await fetchScanner();
  const rows = raw.data ?? [];

  // Map to readable objects
  const stocks = rows.map(r => {
    const [name, close, change, relVol, floatShares, volume, exchange, description] = r.d;
    return { symbol: r.s, name, close, change, relVol, floatShares, volume, exchange, description };
  });

  // Filter out OTC / pink sheets
  const filtered = stocks.filter(s => {
    const exch = (s.exchange ?? s.symbol.split(':')[0] ?? '').toUpperCase();
    return ALLOWED_EXCHANGES.has(exch);
  });

  console.log(`📊 Scanner returned ${raw.totalCount} total | ${filtered.length} passed exchange filter\n`);

  if (filtered.length === 0) {
    console.log('⚠️  No stocks passed all filters right now. Rules.json watchlist unchanged.');
    console.log('    (Market may be pre-open or closed — try again after 9:30am EST)\n');
    return;
  }

  // Print results table
  console.log('Symbol'.padEnd(16) + 'Price'.padStart(8) + 'Chg%'.padStart(8) + 'RelVol'.padStart(10) + 'Float'.padStart(12) + '  Description');
  console.log('─'.repeat(80));
  filtered.forEach(s => {
    const floatM = s.floatShares ? (s.floatShares / 1e6).toFixed(1) + 'M' : 'n/a';
    const rv = s.relVol ? s.relVol.toFixed(1) + 'x' : 'n/a';
    console.log(
      s.symbol.padEnd(16) +
      `$${s.close.toFixed(2)}`.padStart(8) +
      `+${s.change.toFixed(1)}%`.padStart(8) +
      rv.padStart(10) +
      floatM.padStart(12) +
      `  ${s.description ?? ''}`
    );
  });

  // Extract clean ticker symbols (strip exchange prefix for rules.json watchlist)
  const tickers = filtered.map(s => s.name ?? s.symbol.split(':')[1] ?? s.symbol);

  if (DRY_RUN) {
    console.log(`\n✅ Dry run — would update rules.json watchlist to: ${JSON.stringify(tickers)}`);
    return;
  }

  // Update rules.json watchlist in-place
  const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const prev = rules.watchlist;
  rules.watchlist = tickers;
  rules._scan_timestamp = new Date().toISOString();
  rules._scan_total_found = raw.totalCount;

  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2));

  console.log(`\n✅ rules.json watchlist updated:`);
  console.log(`   Before: ${JSON.stringify(prev)}`);
  console.log(`   After:  ${JSON.stringify(tickers)}`);
  console.log(`\n▶ Run morning_brief to get your session bias.\n`);
}

main().catch(err => {
  console.error('❌ Scanner error:', err.message);
  process.exit(1);
});
