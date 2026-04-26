#!/usr/bin/env node
// Build analysis.js by combining ESPN's live current rosters with nflverse
// season stats. ESPN tells us who's on each team RIGHT NOW (post-FA, post-
// trade); nflverse gives us last season's EPA, target share, and snap data.
// We bridge ESPN player IDs to nflverse gsis_ids via the nflverse rosters
// file (which carries both).
//
// Usage: node scripts/build-analysis.mjs
//
// Network requirements:
//   - github.com (nflverse releases)
//   - site.api.espn.com (current rosters)
// If ESPN is unreachable, the script bails out — without live rosters we'd
// just be republishing last season's stale data, which is the bug we're
// fixing.
//
// Bump SEASON when the next stats_player_reg_*.csv release lands on nflverse.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const STATS_SEASON   = 2024;
const ROSTER_SEASON  = 2025; // for the espn_id ↔ gsis_id bridge
const STATS_URL  = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_reg_${STATS_SEASON}.csv`;
const ROSTER_URL = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${ROSTER_SEASON}.csv`;
const ESPN_ROSTER = (slug) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${slug}/roster`;

const THRESHOLDS = {
  QB_LOCKED_EPA_PER_DB: 0.05,
  QB_LOCKED_MIN_DROPBACKS: 300,
  QB_CONTESTED_MIN_DROPBACKS: 100,
  RB_LOCKED_CARRIES_PER_GAME: 14,
  RB_LOCKED_CARRY_SHARE: 0.65,
  RB_CONTESTED_CARRIES_PER_GAME: 6,
  RB_CONTESTED_CARRY_SHARE: 0.40,
  WR_LOCKED_TARGET_SHARE: 0.22,
  WR_CONTESTED_TARGET_SHARE: 0.12,
  TE_LOCKED_TARGET_SHARE: 0.15,
  TE_LOCKED_MIN_TARGETS: 80,
  TE_CONTESTED_MIN_TARGETS: 40,
};

const DRAFT_CAPITAL = { 1: 1.00, 2: 0.75, 3: 0.55, 4: 0.35, 5: 0.20, 6: 0.10, 7: 0.10 };
const ROOM_FACTOR = {
  QB: { open: 1.0, contested: 0.6, locked: 0.20 },
  RB: { open: 1.0, contested: 0.6, locked: 0.20 },
  WR: { open: 1.0, contested: 0.6, locked: 0.45 },
  TE: { open: 1.0, contested: 0.6, locked: 0.20 },
};

const log = (...a) => console.log('[build]', ...a);
const num = (v) => (v == null || v === '' ? 0 : Number(v));
const fmt = (n, d = 3) => Number(n).toFixed(d).replace(/\.?0+$/, '');

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data
    .filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}
async function fetchJSON(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

function topBy(rows, key) {
  if (!rows.length) return null;
  return rows.reduce((best, r) => (num(r[key]) > num(best[key]) ? r : best));
}

// ── Bucketing ────────────────────────────────────────────────────────────
// Each bucketer returns the room's status plus an `incumbents` array of the
// top players at that position with their key stats.

function bucketQB(qbs) {
  const sorted = [...qbs].sort((a, b) => num(b.attempts) - num(a.attempts));
  const incumbents = sorted.filter(r => num(r.attempts) >= 50).slice(0, 3).map(r => {
    const db = num(r.attempts) + num(r.sacks_suffered);
    const epaDb = db ? num(r.passing_epa) / db : 0;
    return {
      name: r.player_display_name,
      games: num(r.games),
      primary_label: 'EPA/db',
      primary_value: fmt(epaDb, 3),
      secondary_label: 'dropbacks',
      secondary_value: String(db),
    };
  });
  const top = sorted[0];
  if (!top) return { status: 'open', starter: null, incumbents: [] };
  const dropbacks = num(top.attempts) + num(top.sacks_suffered);
  const epaPerDb = dropbacks > 0 ? num(top.passing_epa) / dropbacks : 0;
  const status =
    dropbacks >= THRESHOLDS.QB_LOCKED_MIN_DROPBACKS && epaPerDb >= THRESHOLDS.QB_LOCKED_EPA_PER_DB ? 'locked' :
    dropbacks >= THRESHOLDS.QB_CONTESTED_MIN_DROPBACKS ? 'contested' : 'open';
  return { status, starter: top.player_display_name, incumbents };
}

function bucketRB(rbs) {
  if (!rbs.length) return { status: 'open', starter: null, incumbents: [] };
  const teamCarries = rbs.reduce((s, r) => s + num(r.carries), 0);
  const sorted = [...rbs].sort((a, b) => num(b.carries) - num(a.carries));
  const incumbents = sorted.filter(r => num(r.carries) >= 30).slice(0, 3).map(r => {
    const games = num(r.games) || 17;
    const cpg = num(r.carries) / games;
    const share = teamCarries ? num(r.carries) / teamCarries : 0;
    return {
      name: r.player_display_name,
      games,
      primary_label: 'car/g',
      primary_value: fmt(cpg, 1),
      secondary_label: 'share',
      secondary_value: `${Math.round(share * 100)}%`,
    };
  });
  const top = sorted[0];
  if (!top || teamCarries === 0) return { status: 'open', starter: null, incumbents };
  const games = num(top.games) || 17;
  const cpg = num(top.carries) / games;
  const carryShare = num(top.carries) / teamCarries;
  const status =
    cpg >= THRESHOLDS.RB_LOCKED_CARRIES_PER_GAME && carryShare >= THRESHOLDS.RB_LOCKED_CARRY_SHARE ? 'locked' :
    cpg >= THRESHOLDS.RB_CONTESTED_CARRIES_PER_GAME || carryShare >= THRESHOLDS.RB_CONTESTED_CARRY_SHARE ? 'contested' :
    'open';
  return { status, starter: top.player_display_name, incumbents };
}

function bucketWR(wrs) {
  const sorted = [...wrs].sort((a, b) => num(b.target_share) - num(a.target_share));
  const incumbents = sorted.filter(r => num(r.targets) >= 40).slice(0, 3).map(r => ({
    name: r.player_display_name,
    games: num(r.games),
    primary_label: 'tgt%',
    primary_value: `${Math.round(num(r.target_share) * 100)}%`,
    secondary_label: 'targets',
    secondary_value: String(num(r.targets)),
  }));
  const top = sorted[0];
  if (!top) return { status: 'open', starter: null, incumbents: [] };
  const ts = num(top.target_share);
  const status =
    ts >= THRESHOLDS.WR_LOCKED_TARGET_SHARE ? 'locked' :
    ts >= THRESHOLDS.WR_CONTESTED_TARGET_SHARE ? 'contested' : 'open';
  return { status, starter: top.player_display_name, incumbents };
}

function bucketTE(tes) {
  const sorted = [...tes].sort((a, b) => num(b.targets) - num(a.targets));
  const incumbents = sorted.filter(r => num(r.targets) >= 25).slice(0, 2).map(r => ({
    name: r.player_display_name,
    games: num(r.games),
    primary_label: 'tgt%',
    primary_value: `${Math.round(num(r.target_share) * 100)}%`,
    secondary_label: 'targets',
    secondary_value: String(num(r.targets)),
  }));
  const top = sorted[0];
  if (!top) return { status: 'open', starter: null, incumbents: [] };
  const ts = num(top.target_share);
  const t = num(top.targets);
  const status =
    ts >= THRESHOLDS.TE_LOCKED_TARGET_SHARE && t >= THRESHOLDS.TE_LOCKED_MIN_TARGETS ? 'locked' :
    t >= THRESHOLDS.TE_CONTESTED_MIN_TARGETS ? 'contested' : 'open';
  return { status, starter: top.player_display_name, incumbents };
}

const BUCKETER = { QB: bucketQB, RB: bucketRB, WR: bucketWR, TE: bucketTE };

function gradeFor(score) {
  if (score >= 0.85) return 'A+';
  if (score >= 0.70) return 'A';
  if (score >= 0.55) return 'B';
  if (score >= 0.40) return 'C';
  return 'D';
}
function rationaleFor(p, room) {
  if (room.status === 'locked') return `Locked behind ${room.starter} — limited Year-1 path.`;
  if (room.status === 'contested') return `Contested room${room.starter ? ` (vs ${room.starter})` : ''} — competing for snaps.`;
  return 'Open room — clearest path to immediate touches.';
}

// Build a stats-shaped row for a current-roster player without prior season
// stats (e.g. 2026 rookies, recent FA signings with thin history). Volume
// thresholds in the bucketers will exclude zero-production rows from the
// incumbents list while still allowing them to participate in the
// who-is-on-the-team picture.
function syntheticRow(name, position) {
  return {
    player_display_name: name,
    player_id: '',
    position,
    position_group: position,
    attempts: 0, sacks_suffered: 0, passing_epa: 0,
    carries: 0, games: 0,
    targets: 0, target_share: 0,
    receptions: 0, receiving_epa: 0,
  };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const dataModule = await readFile(resolve(ROOT, 'data.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', dataModule)(sandbox.window);
  const DRAFT = sandbox.window.DRAFT_DATA;
  const teams = DRAFT.teams;
  const picks = DRAFT.picks;

  log(`fetching nflverse stats (${STATS_SEASON})…`);
  const statsRows = parseCSV(await fetchText(STATS_URL));
  log(`  ${statsRows.length} player-season rows`);

  log(`fetching nflverse rosters (${ROSTER_SEASON}) for espn_id ↔ gsis_id bridge…`);
  const rosterRows = parseCSV(await fetchText(ROSTER_URL));
  const espnToGsis = {};
  for (const r of rosterRows) {
    if (r.espn_id && r.gsis_id && !espnToGsis[r.espn_id]) {
      espnToGsis[r.espn_id] = r.gsis_id;
    }
  }
  log(`  ${Object.keys(espnToGsis).length} espn→gsis mappings`);

  // index stats by gsis_id
  const statsByGsis = {};
  for (const r of statsRows) {
    if (r.player_id) statsByGsis[r.player_id] = r;
  }

  // Fetch ESPN current roster per team. If ESPN is unreachable, bail loud:
  // a script that "succeeds" with stale rosters is the bug we are fixing.
  log('fetching live rosters from ESPN…');
  const teamCodes = Object.keys(teams).filter(k => k !== 'NEP');
  const currentRosters = {};
  for (const code of teamCodes) {
    const slug = teams[code].espn;
    let roster;
    try {
      roster = await fetchJSON(ESPN_ROSTER(slug));
    } catch (e) {
      throw new Error(
        `ESPN roster fetch failed for ${code} (${slug}): ${e.message}\n` +
        `  This script needs site.api.espn.com to be reachable. If you're in a\n` +
        `  sandbox that blocks ESPN, run on your local machine instead.`
      );
    }
    const players = (roster.athletes || []).flatMap(g => g.items || []);
    const skill = players
      .filter(p => ['QB','RB','WR','TE'].includes(p?.position?.abbreviation))
      .map(p => ({
        espn_id: String(p.id),
        full_name: p.fullName,
        first_name: p.firstName,
        last_name: p.lastName,
        position: p.position.abbreviation,
        age: p.age ? Number(p.age) : null,
        jersey: p.jersey,
      }));
    currentRosters[code] = skill;
    log(`  ${code}: ${skill.length} skill players (QB/RB/WR/TE)`);
  }

  // For each team-position, build the room from the current roster only.
  // Match each current player to their last-season stats via espn_id → gsis_id;
  // players without prior stats get a zero-volume synthetic row so we know
  // they exist on the roster but the bucketer won't treat them as incumbents.
  const rooms = {};
  for (const code of teamCodes) {
    const room = {};
    for (const pos of ['QB','RB','WR','TE']) {
      const positionRoster = currentRosters[code].filter(p => p.position === pos);
      const statsForRoom = positionRoster.map(p => {
        const gsis = espnToGsis[p.espn_id];
        return (gsis && statsByGsis[gsis]) || syntheticRow(p.full_name, pos);
      });
      room[pos] = BUCKETER[pos](statsForRoom);
    }
    rooms[code] = room;
    log(`  ${code}: QB=${room.QB.status}/${room.QB.starter || '—'}  RB=${room.RB.status}/${room.RB.starter || '—'}  WR=${room.WR.status}/${room.WR.starter || '—'}  TE=${room.TE.status}/${room.TE.starter || '—'}`);
  }

  // Grade each pick (kept for back-test compatibility; UI doesn't show it)
  const graded = picks.map(p => {
    const teamCode = p.team === 'NEP' ? 'NE' : p.team;
    const room = rooms[teamCode]?.[p.pos] || { status: 'open' };
    const draftCapital = DRAFT_CAPITAL[p.round] ?? 0.10;
    const roomFactor = ROOM_FACTOR[p.pos]?.[room.status] ?? 1.0;
    const score = +(draftCapital * roomFactor).toFixed(3);
    return {
      key: `${p.pick}-${p.name}-${p.team}`,
      pick: p.pick, round: p.round, overall: p.overall,
      name: p.name, school: p.school, team: p.team, pos: p.pos,
      roomStatus: room.status,
      starter: room.starter || null,
      draftCapital, roomFactor, score,
      grade: gradeFor(score),
      rationale: rationaleFor(p, room),
    };
  });

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    statsSeason: STATS_SEASON,
    rosterSeason: ROSTER_SEASON,
    season: STATS_SEASON, // back-compat
    source: `ESPN current rosters + nflverse stats_player_reg_${STATS_SEASON}`,
    thresholds: THRESHOLDS,
    rooms,
    picks: graded,
  };

  const file = resolve(ROOT, 'analysis.js');
  await writeFile(file, `// Auto-generated by scripts/build-analysis.mjs — do not edit by hand.\nwindow.ANALYSIS_DATA = ${JSON.stringify(out, null, 2)};\n`);
  log(`wrote ${file}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
