// By Team view — strip of 32 team tiles across the top, click to filter.
// Selected team's fantasy picks (QB/RB/WR/TE only) shown below.

const TeamView = ({ picks, palette, dark, density, selectedTeam, setSelectedTeam, hoverPick, setHoverPick }) => {
  const teams = window.DRAFT_DATA.teams;

  // Normalize NEP -> NE for display, but keep both keys lookup-able
  const teamCodes = Object.keys(teams)
    .filter(k => k !== 'NEP') // dedupe
    .sort();

  // Group picks by team (treat NEP as NE)
  const byTeam = React.useMemo(() => {
    const m = {};
    picks.forEach(p => {
      const code = p.team === 'NEP' ? 'NE' : p.team;
      if (!m[code]) m[code] = [];
      m[code].push(p);
    });
    Object.values(m).forEach(arr => arr.sort((a, b) => a.overall - b.overall));
    return m;
  }, [picks]);

  const selected = selectedTeam || teamCodes[0];
  const selectedTeamData = teams[selected];
  const selectedPicks = byTeam[selected] || [];

  // Position breakdown for selected team
  const breakdown = { QB: 0, RB: 0, WR: 0, TE: 0 };
  selectedPicks.forEach(p => { breakdown[p.pos] = (breakdown[p.pos] || 0) + 1; });

  return (
    <div className="team-view">
      <div className="team-strip">
        {teamCodes.map(code => {
          const t = teams[code];
          const count = (byTeam[code] || []).length;
          const isActive = code === selected;
          return (
            <button
              key={code}
              className={`team-tile${isActive ? ' is-active' : ''}`}
              onClick={() => setSelectedTeam(code)}
              title={t.name}
            >
              <TeamBadge code={code} size={isActive ? 44 : 36} />
              <span className="team-tile-code" style={{ color: isActive ? t.primary : 'var(--text-muted)' }}>
                {code}
              </span>
              {count > 0 && (
                <span className="team-tile-dot" style={{ background: t.secondary }}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="team-detail" style={{ borderTopColor: selectedTeamData.primary }}>
        <div className="team-detail-header">
          <div className="team-detail-id">
            <TeamBadge code={selected} size={64} />
            <div>
              <div className="team-detail-city">{selectedTeamData.city}</div>
              <h2 className="team-detail-name">{selectedTeamData.short}</h2>
            </div>
          </div>
          <div className="team-detail-stats">
            <div className="stat">
              <span className="stat-label">Fantasy picks</span>
              <span className="stat-value">{selectedPicks.length}</span>
            </div>
            {['QB','RB','WR','TE'].map(pos => (
              <div key={pos} className="stat">
                <span className="stat-label">{pos}</span>
                <span className="stat-value" style={{ opacity: breakdown[pos] ? 1 : 0.25 }}>
                  {breakdown[pos]}
                </span>
              </div>
            ))}
          </div>
        </div>

        {selectedPicks.length === 0 ? (
          <div className="team-empty">
            <div className="team-empty-icon">—</div>
            <div className="team-empty-text">No fantasy-relevant picks for {selectedTeamData.short}.</div>
            <div className="team-empty-sub">QB · RB · WR · TE</div>
          </div>
        ) : (
          <div className="team-pick-list">
            {selectedPicks.map(p => {
              const swatch = window.roundSwatch(palette, p.round, dark);
              const isHover = hoverPick === p.pick + p.name;
              return (
                <div
                  key={p.pick + p.name}
                  className={`team-pick-row${isHover ? ' is-hover' : ''}`}
                  onMouseEnter={() => setHoverPick(p.pick + p.name)}
                  onMouseLeave={() => setHoverPick(null)}
                >
                  <div className="team-pick-num" style={{ background: swatch.bg, color: swatch.fg }}>
                    <span className="rd">RD {p.round}</span>
                    <span className="ov">{p.overall}</span>
                  </div>
                  <div className="team-pick-pos" data-pos={p.pos}>{p.pos}</div>
                  <div className="team-pick-name">{p.name}</div>
                  <div className="team-pick-pick">Pick {p.pick}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

window.TeamView = TeamView;
