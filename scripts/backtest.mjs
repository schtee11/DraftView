#!/usr/bin/env node
// Back-test the room-status × draft-capital grading formula against ground
// truth: take the 2023 NFL rookie class (QB/RB/WR/TE), grade each pick using
// 2022 season stats (the rooms as they existed when those rookies were
// drafted), then correlate the grades with each rookie's actual 2023
// fantasy_points_ppr.
//
// Usage: node scripts/backtest.mjs
//
// Outputs per-grade mean PPR, Pearson + Spearman correlation between score
// and PPR, and a few hit/miss examples.

const ROOKIE_SEASON = 2023;
const PRIOR_SEASON  = 2022;

const DRAFT_PICKS_URL  = 'https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv';
const STATS_URL = (yr) => `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_reg_${yr}.csv`;

const NFLVERSE_TO_OURS = { LV: 'LVR', LA: 'LAR', NO: 'NOR' };

// ── thresholds (mirror build-analysis.mjs) ──────────────────────────────────
const T = {
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
const ROOM_FACTOR   = { open: 1.0, contested: 0.6, locked: 0.2 };

const log = (...a) => console.log(...a);
const num = (v) => (v == null || v === '' ? 0 : Number(v));

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
  return data.filter(r => r.length === header.length).map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.text();
}

function topByMetric(rows, key) {
  if (!rows.length) return null;
  return rows.reduce((best, r) => (num(r[key]) > num(best[key]) ? r : best));
}

function bucketQB(qbs) {
  const top = topByMetric(qbs, 'attempts');
  if (!top) return 'open';
  const dropbacks = num(top.attempts) + num(top.sacks_suffered);
  const epaPerDb = dropbacks > 0 ? num(top.passing_epa) / dropbacks : 0;
  return dropbacks >= T.QB_LOCKED_MIN_DROPBACKS && epaPerDb >= T.QB_LOCKED_EPA_PER_DB ? 'locked'
       : dropbacks >= T.QB_CONTESTED_MIN_DROPBACKS ? 'contested' : 'open';
}
function bucketRB(rbs) {
  if (!rbs.length) return 'open';
  const top = topByMetric(rbs, 'carries');
  const teamCarries = rbs.reduce((s, r) => s + num(r.carries), 0);
  if (!top || teamCarries === 0) return 'open';
  const games = num(top.games) || 17;
  const cpg = num(top.carries) / games;
  const cshare = num(top.carries) / teamCarries;
  return cpg >= T.RB_LOCKED_CARRIES_PER_GAME && cshare >= T.RB_LOCKED_CARRY_SHARE ? 'locked'
       : cpg >= T.RB_CONTESTED_CARRIES_PER_GAME || cshare >= T.RB_CONTESTED_CARRY_SHARE ? 'contested' : 'open';
}
function bucketWR(wrs) {
  const top = topByMetric(wrs, 'target_share');
  if (!top) return 'open';
  const ts = num(top.target_share);
  return ts >= T.WR_LOCKED_TARGET_SHARE ? 'locked'
       : ts >= T.WR_CONTESTED_TARGET_SHARE ? 'contested' : 'open';
}
function bucketTE(tes) {
  const top = topByMetric(tes, 'targets');
  if (!top) return 'open';
  const ts = num(top.target_share), t = num(top.targets);
  return ts >= T.TE_LOCKED_TARGET_SHARE && t >= T.TE_LOCKED_MIN_TARGETS ? 'locked'
       : t >= T.TE_CONTESTED_MIN_TARGETS ? 'contested' : 'open';
}
const BUCKETER = { QB: bucketQB, RB: bucketRB, WR: bucketWR, TE: bucketTE };

function gradeFor(score) {
  if (score >= 0.85) return 'A+';
  if (score >= 0.70) return 'A';
  if (score >= 0.55) return 'B';
  if (score >= 0.40) return 'C';
  return 'D';
}

// ── correlation helpers ────────────────────────────────────────────────────
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  // average rank for ties
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) r[idx[k][1]] = avg;
    i = j;
  }
  return r;
}
function spearman(xs, ys) { return pearson(ranks(xs), ranks(ys)); }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`fetching draft_picks…`);
  const dpRaw = parseCSV(await fetchText(DRAFT_PICKS_URL));
  const rookies = dpRaw.filter(r =>
    Number(r.season) === ROOKIE_SEASON &&
    ['QB','RB','WR','TE'].includes(r.position));
  log(`  ${rookies.length} ${ROOKIE_SEASON} fantasy-position rookies`);

  log(`fetching ${PRIOR_SEASON} stats (for rooms)…`);
  const priorRows = parseCSV(await fetchText(STATS_URL(PRIOR_SEASON)));
  const byTeamPos = new Map();
  for (const r of priorRows) {
    const team = NFLVERSE_TO_OURS[r.recent_team] || r.recent_team;
    const pg = r.position_group;
    if (!['QB','RB','WR','TE'].includes(pg)) continue;
    const k = `${team}|${pg}`;
    if (!byTeamPos.has(k)) byTeamPos.set(k, []);
    byTeamPos.get(k).push(r);
  }

  log(`fetching ${ROOKIE_SEASON} stats (for outcomes)…`);
  const rookieRows = parseCSV(await fetchText(STATS_URL(ROOKIE_SEASON)));
  const ppr = new Map();
  for (const r of rookieRows) {
    if (!r.player_id) continue;
    ppr.set(r.player_id, num(r.fantasy_points_ppr));
  }

  // grade each rookie + look up their 2023 PPR
  const graded = [];
  let unmatched = 0;
  for (const r of rookies) {
    const team = NFLVERSE_TO_OURS[r.team] || r.team;
    const pos = r.position;
    const players = byTeamPos.get(`${team}|${pos}`) || [];
    const status = BUCKETER[pos](players);
    const round = Number(r.round);
    const dc = DRAFT_CAPITAL[round] ?? 0.10;
    const rf = ROOM_FACTOR[status] ?? 1.0;
    const score = +(dc * rf).toFixed(3);
    const grade = gradeFor(score);
    const points = ppr.has(r.gsis_id) ? ppr.get(r.gsis_id) : null;
    if (points == null) unmatched++;
    graded.push({
      name: r.pfr_player_name,
      team, pos, round: Number(r.round), pick: Number(r.pick),
      college: r.college,
      status, score, grade,
      ppr: points,
    });
  }
  log(`  matched ${graded.length - unmatched} / ${graded.length} to ${ROOKIE_SEASON} stats (${unmatched} had no recorded production)\n`);

  const matched = graded.filter(g => g.ppr != null);

  // per-grade summary
  const order = ['A+','A','B','C','D'];
  log('grade   n     mean PPR   median PPR    examples');
  log('─────  ────  ─────────  ──────────    ──────────');
  for (const g of order) {
    const rows = matched.filter(m => m.grade === g);
    const pprs = rows.map(r => r.ppr);
    const mean = pprs.length ? pprs.reduce((s, v) => s + v, 0) / pprs.length : 0;
    const med = median(pprs);
    const top3 = [...rows].sort((a, b) => b.ppr - a.ppr).slice(0, 3)
      .map(r => `${r.name} (${r.ppr.toFixed(0)})`).join(', ');
    log(`${g.padEnd(5)}  ${String(rows.length).padStart(3)}   ${mean.toFixed(1).padStart(7)}    ${med.toFixed(1).padStart(7)}     ${top3}`);
  }

  // correlations
  const xs = matched.map(m => m.score);
  const ys = matched.map(m => m.ppr);
  const p = pearson(xs, ys);
  const s = spearman(xs, ys);
  log(`\nPearson  score vs PPR:  ${p.toFixed(3)}`);
  log(`Spearman score vs PPR:  ${s.toFixed(3)}`);

  // hit-rate sanity check: is mean PPR monotonic across grades?
  const means = order.map(g => {
    const rows = matched.filter(m => m.grade === g);
    return rows.length ? rows.reduce((s, v) => s + v.ppr, 0) / rows.length : null;
  });
  log(`\nGrade means in order:  ${means.map(m => m == null ? '—' : m.toFixed(1)).join(' → ')}`);

  // misses
  log('\nBiggest misses (high grade, low PPR):');
  matched.filter(m => ['A+','A'].includes(m.grade))
    .sort((a, b) => a.ppr - b.ppr).slice(0, 5)
    .forEach(m => log(`  ${m.grade} ${m.pos} ${m.name} (${m.team}, R${m.round}) — ${m.ppr.toFixed(0)} PPR`));
  log('\nBiggest overperformers (low grade, high PPR):');
  matched.filter(m => ['C','D'].includes(m.grade))
    .sort((a, b) => b.ppr - a.ppr).slice(0, 5)
    .forEach(m => log(`  ${m.grade} ${m.pos} ${m.name} (${m.team}, R${m.round}) — ${m.ppr.toFixed(0)} PPR`));
}

main().catch(e => { console.error(e); process.exit(1); });
