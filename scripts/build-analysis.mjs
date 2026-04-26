#!/usr/bin/env node
// Build analysis.js by combining 2024 NFL season stats with the draft picks.
//
// Usage: node scripts/build-analysis.mjs
//
// Source: nflverse-data `stats_player_reg_{SEASON}.csv` (season-aggregated
// regular-season stats per player). We read it once, identify each team's
// top incumbent at QB/RB/WR/TE, bucket the room as Locked/Contested/Open,
// and combine with draft capital to grade each rookie pick.
//
// When the 2025 season's CSV lands, bump SEASON below.
//
// Requires Node 18+ (for global fetch). No npm deps.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SEASON = 2024;
const STATS_URL = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_reg_${SEASON}.csv`;

const THRESHOLDS = {
  // QB
  QB_LOCKED_EPA_PER_DB: 0.05,
  QB_LOCKED_MIN_DROPBACKS: 300,
  QB_CONTESTED_MIN_DROPBACKS: 100,
  // RB — locked needs both volume AND a concentrated workload (vs committee)
  RB_LOCKED_CARRIES_PER_GAME: 14,
  RB_LOCKED_CARRY_SHARE: 0.65,
  RB_CONTESTED_CARRIES_PER_GAME: 6,
  RB_CONTESTED_CARRY_SHARE: 0.40,
  // WR
  WR_LOCKED_TARGET_SHARE: 0.22,
  WR_CONTESTED_TARGET_SHARE: 0.12,
  // TE
  TE_LOCKED_TARGET_SHARE: 0.15,
  TE_LOCKED_MIN_TARGETS: 80,
  TE_CONTESTED_MIN_TARGETS: 40,
};

const DRAFT_CAPITAL = { 1: 1.00, 2: 0.75, 3: 0.55, 4: 0.35, 5: 0.20, 6: 0.10, 7: 0.10 };
// Per-position room factor. WR is softer when "locked" because NFL offenses
// run 3-WR base sets every play — a locked WR1 doesn't block a rookie from
// taking a WR2/WR3 seat. QB / RB / TE rooms have one job each, so locked
// really does mean blocked.
const ROOM_FACTOR = {
  QB: { open: 1.0, contested: 0.6, locked: 0.20 },
  RB: { open: 1.0, contested: 0.6, locked: 0.20 },
  WR: { open: 1.0, contested: 0.6, locked: 0.45 },
  TE: { open: 1.0, contested: 0.6, locked: 0.20 },
};

// nflverse uses some team codes that differ from ours.
const NFLVERSE_TO_OURS = { LV: 'LVR', LA: 'LAR', NO: 'NOR' };

const log = (...a) => console.log('[build]', ...a);

// Minimal RFC4180-ish CSV parser (handles quoted fields w/ commas + newlines).
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

const num = (v) => (v == null || v === '' ? 0 : Number(v));

function topByMetric(rows, metric) {
  if (!rows.length) return null;
  return rows.reduce((best, r) => (num(r[metric]) > num(best[metric]) ? r : best));
}

// ── Bucketing ───────────────────────────────────────────────────────────────
// Each bucketer returns the room's status plus an `incumbents` array of the
// top players at that position with their key stats. The starter field stays
// for back-compat with the back-test.

const fmt = (n, d = 3) => Number(n).toFixed(d).replace(/\.?0+$/, '');

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
  return {
    status,
    starter: top.player_display_name,
    epa_per_dropback: +epaPerDb.toFixed(3),
    dropbacks,
    incumbents,
  };
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
  // Locked requires both heavy volume AND a concentrated workload — a 220-carry
  // back on a team that also gives 180 carries to a backup is committee, not
  // bell-cow, and a rookie can break in.
  const status =
    cpg >= THRESHOLDS.RB_LOCKED_CARRIES_PER_GAME && carryShare >= THRESHOLDS.RB_LOCKED_CARRY_SHARE ? 'locked' :
    cpg >= THRESHOLDS.RB_CONTESTED_CARRIES_PER_GAME || carryShare >= THRESHOLDS.RB_CONTESTED_CARRY_SHARE ? 'contested' :
    'open';
  return {
    status,
    starter: top.player_display_name,
    carries_per_game: +cpg.toFixed(1),
    carry_share: +carryShare.toFixed(3),
    carries: num(top.carries),
    incumbents,
  };
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
  return {
    status,
    starter: top.player_display_name,
    target_share: +ts.toFixed(3),
    targets: num(top.targets),
    incumbents,
  };
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
  return {
    status,
    starter: top.player_display_name,
    target_share: +ts.toFixed(3),
    targets: t,
    incumbents,
  };
}

const BUCKETER = { QB: bucketQB, RB: bucketRB, WR: bucketWR, TE: bucketTE };

// ── Grading ─────────────────────────────────────────────────────────────────
function gradeFor(score) {
  if (score >= 0.85) return 'A+';
  if (score >= 0.70) return 'A';
  if (score >= 0.55) return 'B';
  if (score >= 0.40) return 'C';
  return 'D';
}

function rationaleFor(p, room) {
  if (room.status === 'locked') {
    return `Locked behind ${room.starter} — limited Year-1 path.`;
  }
  if (room.status === 'contested') {
    return `Contested room${room.starter ? ` (vs ${room.starter})` : ''} — competing for snaps.`;
  }
  return 'Open room — clearest path to immediate touches.';
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const dataModule = await readFile(resolve(ROOT, 'data.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', dataModule)(sandbox.window);
  const DRAFT = sandbox.window.DRAFT_DATA;
  const teams = DRAFT.teams;
  const picks = DRAFT.picks;

  log(`fetching ${STATS_URL}`);
  const csv = await fetchText(STATS_URL);
  const rows = parseCSV(csv);
  log(`  ${rows.length} player-season rows`);

  // Group by team + position group
  const byTeamPos = new Map();
  for (const r of rows) {
    const ourTeam = NFLVERSE_TO_OURS[r.recent_team] || r.recent_team;
    const pg = r.position_group;
    if (!['QB','RB','WR','TE'].includes(pg)) continue;
    const key = `${ourTeam}|${pg}`;
    if (!byTeamPos.has(key)) byTeamPos.set(key, []);
    byTeamPos.get(key).push(r);
  }

  // Compute rooms for every team in our data
  const rooms = {};
  for (const code of Object.keys(teams)) {
    if (code === 'NEP') continue;
    const room = {};
    for (const pos of ['QB','RB','WR','TE']) {
      const players = byTeamPos.get(`${code}|${pos}`) || [];
      room[pos] = BUCKETER[pos](players);
    }
    rooms[code] = room;
    log(`  ${code}: QB=${room.QB.status}/${room.QB.starter || '—'}  RB=${room.RB.status}/${room.RB.starter || '—'}  WR=${room.WR.status}/${room.WR.starter || '—'}  TE=${room.TE.status}/${room.TE.starter || '—'}`);
  }

  // Grade each pick
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
    season: SEASON,
    source: 'nflverse stats_player_reg',
    thresholds: THRESHOLDS,
    rooms,
    picks: graded,
  };

  const file = resolve(ROOT, 'analysis.js');
  await writeFile(file, `// Auto-generated by scripts/build-analysis.mjs — do not edit by hand.\nwindow.ANALYSIS_DATA = ${JSON.stringify(out, null, 2)};\n`);
  log(`wrote ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
