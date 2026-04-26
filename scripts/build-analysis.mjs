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

// ESPN's response shape:
//   { categories: [
//       { name: 'passing'|'rushing'|'receiving'|...,
//         labels: ['GP','ATT','RTG',...],
//         statistics: [
//           { season: { year: 2024 }, stats: ['17','584','99.5',...] },
//           { season: { year: 2025 }, stats: [...] }
//         ]
//       }
//     ]
//   }
// Stats are POSITIONAL strings parallel to labels. Pick the season we want,
// flatten to { 'category.LABEL': numericValue }, then extract by label.
function flattenStats(json, season) {
  if (!json) return {};
  const flat = {};
  for (const cat of (json.categories || [])) {
    const labels = cat.labels || [];
    const rec = (cat.statistics || []).find(s => Number(s?.season?.year) === season);
    if (!rec || !Array.isArray(rec.stats)) continue;
    rec.stats.forEach((val, i) => {
      const label = labels[i];
      if (!label) return;
      const num = parseFloat(val);
      flat[`${cat.name}.${label}`] = Number.isFinite(num) ? num : 0;
    });
  }
  return flat;
}

// Pick out the fields the bucketers care about. GP comes from whichever
// category the player actually contributed to.
function extractStats(flat, position) {
  const games =
    flat['passing.GP']   ||
    flat['rushing.GP']   ||
    flat['receiving.GP'] || 0;
  return {
    position,
    games,
    attempts:        flat['passing.ATT']     || 0,
    completions:     flat['passing.CMP']     || 0,
    passing_yards:   flat['passing.YDS']     || 0,
    sacks_suffered:  flat['passing.SACK']    || 0,
    passer_rating:   flat['passing.RTG']     || 0,
    carries:         flat['rushing.CAR']     || 0,
    rushing_yards:   flat['rushing.YDS']     || 0,
    targets:         flat['receiving.TGTS']  || 0,
    receptions:      flat['receiving.REC']   || 0,
    receiving_yards: flat['receiving.YDS']   || 0,
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
    const flat = flattenStats(json, SEASON);
    const stats = extractStats(flat, p.position);
    if (!firstRawDump && Object.keys(flat).length) {
      firstRawDump = true;
      log(`first parsed: ${p.name} (${p.position}) → ${JSON.stringify(stats)}`);
    }
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
