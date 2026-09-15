#!/usr/bin/env node
/**
 * stonkfun-pair-watcher.mjs
 *
 * Polls StonkFun's public API for new launch pairs (GET /api/public/v1/pairs)
 * and sends a Telegram message for every pair that wasn't seen before.
 *
 * Setup
 * -----
 * 1. Create a Telegram bot:
 *      - Message @BotFather on Telegram, run /newbot, follow the prompts.
 *      - Copy the token it gives you.
 * 2. Get your chat id:
 *      - Message your new bot anything (e.g. "hi").
 *      - Visit https://api.telegram.org/bot<TOKEN>/getUpdates in a browser.
 *      - Find "chat":{"id": ...} in the JSON — that's your CHAT_ID.
 *        (For a group, add the bot to the group first, then do the same.)
 * 3. Set the two env vars below (or edit the constants directly).
 * 4. Run:
 *      node stonkfun-pair-watcher.mjs
 *    It keeps running, polling every POLL_INTERVAL_MS, until you stop it (Ctrl+C).
 *
 * State
 * -----
 * Known pairs are cached in ./stonkfun-seen-pairs.json so that restarting
 * the script doesn't re-announce everything that already existed.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---- Config -----------------------------------------------------------

const API_BASE = 'https://www.stonkfun.xyz/api/public/v1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000); // 1 min default
const ONLY_LAUNCHABLE = process.env.ONLY_LAUNCHABLE !== 'false'; // default true
const RUN_ONCE = process.env.RUN_ONCE === 'true'; // true = check once and exit (for cron/GitHub Actions)
const PORT = process.env.PORT || 8000; // health-check server, required by platforms like Koyeb

let lastCheckAt = null;
let lastNewPairCount = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'stonkfun-seen-pairs.json');

// ---- Helpers ------------------------------------------------------------

function loadSeen() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return null; // null = "no state file yet", handled specially on first run
  }
}

function saveSeen(seenSet) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seenSet], null, 2));
}

async function fetchPairs() {
  const url = new URL(`${API_BASE}/pairs`);
  if (ONLY_LAUNCHABLE) url.searchParams.set('launchable', 'true');

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${body?.error?.code || res.status}: ${body?.error?.message || 'request failed'}`);
  }

  const rateRemaining = res.headers.get('x-ratelimit-remaining');
  const rateLimit = res.headers.get('x-ratelimit-limit');
  const rateReset = res.headers.get('x-ratelimit-reset');
  if (rateRemaining !== null && Number(rateRemaining) < 5) {
    console.warn(`[warn] Rate limit nearly exhausted: ${rateRemaining}/${rateLimit} remaining, resets at ${rateReset}`);
  }

  return body.data.pairs;
}

async function sendTelegramMessage(text) {
  if (TELEGRAM_CHAT_IDS.includes('YOUR_CHAT_ID_HERE') || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.warn('[warn] Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.');
    console.log('[would send]', text);
    return;
  }

  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chatId) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[error] Telegram send failed for chat ${chatId}:`, res.status, body);
    }
  }));
}

function formatPairMessage(pair) {
  const lines = [
    `🆕 *New StonkFun pair available*`,
    `*${pair.symbol ?? pair.name ?? 'Unknown'}*${pair.name && pair.symbol ? ` — ${pair.name}` : ''}`,
    `Mint: \`${pair.mint}\``,
  ];
  if (pair.category) lines.push(`Category: ${pair.category}`);
  if (typeof pair.launchable === 'boolean') lines.push(`Launchable: ${pair.launchable}`);
  if ('launchLabReady' in pair) lines.push(`LaunchLab ready: ${pair.launchLabReady}`);
  return lines.join('\n');
}

// ---- Main loop ------------------------------------------------------------

let lastTotalCount = null;

async function tick(seen, isFirstRun) {
  let pairs;
  try {
    pairs = await fetchPairs();
  } catch (err) {
    console.error('[error] fetching pairs:', err.message);
    return;
  }

  const newPairs = pairs.filter((p) => !seen.has(p.mint));
  lastCheckAt = new Date();
  lastNewPairCount = newPairs.length;

  if (isFirstRun) {
    // Don't spam Telegram with every pair that already existed on first run —
    // just record them as seen and confirm the baseline.
    for (const p of pairs) seen.add(p.mint);
    saveSeen(seen);
    lastTotalCount = pairs.length;
    console.log(`[init] Baseline recorded: ${pairs.length} existing pairs. Watching for new ones...`);
    return;
  }

  const countChanged = lastTotalCount !== null && pairs.length !== lastTotalCount;
  if (countChanged) {
    console.log(`[${lastCheckAt.toISOString()}] TOTAL COUNT CHANGED: ${lastTotalCount} -> ${pairs.length}`);
    if (newPairs.length === 0) {
      console.warn(
        `[warn] Count changed but no new mint was detected — this suggests a detection bug ` +
        `(e.g. inconsistent mint formatting between polls) rather than an upstream delay. ` +
        `Worth checking the raw API response manually.`
      );
    }
  }
  lastTotalCount = pairs.length;

  if (newPairs.length === 0) {
    console.log(`[${lastCheckAt.toISOString()}] No new pairs (${pairs.length} total).`);
    return;
  }

  console.log(`[${lastCheckAt.toISOString()}] ${newPairs.length} new pair(s) found!`);
  for (const pair of newPairs) {
    console.log(' ->', pair.symbol || pair.name, pair.mint);
    await sendTelegramMessage(formatPairMessage(pair));
    seen.add(pair.mint);
  }
  saveSeen(seen);
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      lastCheckAt,
      lastNewPairCount,
    }));
  });
  server.listen(PORT, () => {
    console.log(`Health check server listening on :${PORT} (ping this to keep the instance awake)`);
  });
}

async function main() {
  console.log('StonkFun pair watcher starting...');
  console.log(`Polling ${API_BASE}/pairs every ${POLL_INTERVAL_MS / 1000}s`);

  if (!RUN_ONCE) startHealthServer();

  let seen = loadSeen();
  const isFirstRun = seen === null;
  if (isFirstRun) seen = new Set();

  await sendTelegramMessage('👋 StonkFun pair watcher just started up and is now watching for new pairs.');

  await tick(seen, isFirstRun);

  if (RUN_ONCE) {
    console.log('[done] RUN_ONCE set — exiting after single check.');
    return;
  }

  setInterval(() => tick(seen, false), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
