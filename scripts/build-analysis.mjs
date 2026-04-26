#!/usr/bin/env node
// Build stats.js using ESPN 2025 season stats — pulled per-player from
// ESPN's public site.web.api endpoint, no third-party data source.
// Browser still fetches LIVE rosters from ESPN at page load; this script
// just bakes a stats lookup keyed by ESPN athlete ID.
//
// Usage:
//   node scripts/build-analysis.mjs           # normal build
//   node scripts/build-analysis.mjs --debug   # dump 1 sample player
//
// Network requirements: site.api.espn.com + site.web.api.espn.com.
// Runs ~5 seconds for the league with the parallelism below; bump
// CONCURRENCY down if ESPN starts rate-limiting.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SEASON = 2025;
const SEASON_TYPE = 2; // 1=pre, 2=regular, 3=post
const CONCURRENCY = 8;
const DEBUG = process.argv.includes('--debug');

const ROSTER_URL = (slug) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${slug}/roster`;
const STATS_URL = (espnId) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${espnId}/stats?season=${SEASON}&seasontype=${SEASON_TYPE}`;

const log = (...a) => console.log('[build]', ...a);

async function fetchJSON(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

// Run async tasks with a max-concurrency limit. Avoids overwhelming ESPN.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

// ESPN's stats response groups stats into categories. Flatten to a single
// { name: numericValue } map so callers can pick fields by name.
function flattenStats(json) {
  if (!json) return {};
  // Two shapes seen in the wild:
  //   { categories: [{ stats: [{ name, value, displayValue }] }] }
  //   { splits: { categories: [...] } }
  const cats =
    json.categories ||
    json?.splits?.categories ||
    json?.statistics?.splits?.categories ||
    [];
  const flat = {};
  for (const c of cats) {
    for (const s of (c.stats || [])) {
      const v = s.value ?? Number(s.displayValue);
      if (typeof v === 'number' && !Number.isNaN(v)) flat[s.name] = v;
    }
  }
  return flat;
}

// Extract the fields the bucketers care about. Defensive — if a field is
// missing (player didn't play / category absent), it stays 0.
function extractStats(flat, position) {
  return {
    position,
    games: flat.gamesPlayed || 0,
    // QB
    attempts:        flat.passingAttempts    || flat.completionsattempts || 0,
    completions:     flat.completions        || 0,
    passing_yards:   flat.passingYards       || 0,
    sacks_suffered:  flat.sacks              || flat.sackedYardsLost || 0,
    passer_rating:   flat.QBRating           || flat.passerRating || 0,
    // RB
    carries:         flat.rushingAttempts    || 0,
    rushing_yards:   flat.rushingYards       || 0,
    // WR / TE
    targets:         flat.receivingTargets   || 0,
    receptions:      flat.receptions         || 0,
    receiving_yards: flat.receivingYards     || 0,
  };
}

async function main() {
  const dataModule = await readFile(resolve(ROOT, 'data.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', dataModule)(sandbox.window);
  const teams = sandbox.window.DRAFT_DATA.teams;
  const codes = Object.keys(teams).filter(c => c !== 'NEP');

  log(`fetching rosters for ${codes.length} teams (parallel)…`);
  const rosters = await pool(codes, CONCURRENCY, async (code) => {
    const slug = teams[code].espn;
    const json = await fetchJSON(ROSTER_URL(slug));
    const players = (json?.athletes || [])
      .flatMap(g => g.items || [])
      .filter(p => ['QB','RB','WR','TE'].includes(p?.position?.abbreviation))
      .map(p => ({
        espn_id: String(p.id),
        name: p.fullName,
        position: p.position.abbreviation,
        team: code,
      }));
    return players;
  });
  const allPlayers = rosters.flat();
  log(`  ${allPlayers.length} skill players across the league`);

  log(`fetching ${SEASON} stats per player (concurrency=${CONCURRENCY})…`);
  const t0 = Date.now();
  let done = 0;
  let firstSample = null;
  let firstRawDump = false;
  const enriched = await pool(allPlayers, CONCURRENCY, async (p) => {
    let json = null;
    try {
      json = await fetchJSON(STATS_URL(p.espn_id));
    } catch (e) {
      // Non-fatal; missing stats just means the player won't surface as
      // an incumbent (volume thresholds in the bucketer filter them out).
      if (DEBUG) console.error(`  ! ${p.name} (${p.espn_id}): ${e.message}`);
    }
    // Print categories with their labels/names + a sample stat object so we
    // can see how ESPN keys the values (positional? by name? by abbreviation?).
    if (!firstRawDump && json) {
      firstRawDump = true;
      log(`=== ESPN response audit: ${p.name} (espn_id ${p.espn_id}) ===`);
      log(`top-level keys: ${Object.keys(json).join(', ')}`);
      const cats = json.categories || [];
      cats.forEach((cat, i) => {
        log(`categories[${i}] name=${cat.name || cat.displayName || '?'}`);
        const labels = cat.labels || cat.names || cat.abbreviations || cat.displayNames;
        if (labels) log(`  labels: ${JSON.stringify(labels).slice(0, 400)}`);
        (cat.statistics || []).forEach((ss, j) => {
          log(`  statistics[${j}] season=${JSON.stringify(ss.season || ss.team || {})}`);
          if (Array.isArray(ss.stats) && ss.stats.length) {
            log(`    stats[0]: ${JSON.stringify(ss.stats[0]).slice(0, 300)}`);
            log(`    stats[1]: ${JSON.stringify(ss.stats[1]).slice(0, 300)}`);
            log(`    stats[2]: ${JSON.stringify(ss.stats[2]).slice(0, 300)}`);
          }
        });
      });
      if (json.glossary) {
        log(`glossary[0..2]: ${JSON.stringify((json.glossary || []).slice(0, 3)).slice(0, 500)}`);
      }
      log('=== end audit ===');
    }
    const flat = flattenStats(json);
    const stats = extractStats(flat, p.position);
    done++;
    if (done % 50 === 0) log(`  …${done}/${allPlayers.length}`);
    if (DEBUG && !firstSample && Object.keys(flat).length > 5) {
      firstSample = { player: p, raw_keys: Object.keys(flat).slice(0, 30), parsed: stats };
    }
    return { ...p, ...stats };
  });
  log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (DEBUG && firstSample) {
    log('--- sample player ---');
    console.dir(firstSample, { depth: 4 });
    log('---------------------');
  }

  // Index by espn_id for the browser
  const byEspnId = {};
  for (const e of enriched) {
    byEspnId[e.espn_id] = {
      name: e.name,
      position: e.position,
      games: e.games,
      attempts: e.attempts,
      sacks_suffered: e.sacks_suffered,
      passer_rating: +Number(e.passer_rating).toFixed(1),
      carries: e.carries,
      targets: e.targets,
    };
  }
  log(`  ${Object.keys(byEspnId).length} entries written to stats.js`);

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    statsSeason: SEASON,
    source: `ESPN site.web.api ${SEASON} regular-season stats`,
    byEspnId,
  };

  const file = resolve(ROOT, 'stats.js');
  await writeFile(file, `// Auto-generated by scripts/build-analysis.mjs — do not edit by hand.\nwindow.STATS = ${JSON.stringify(out, null, 2)};\n`);
  log(`wrote ${file}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
