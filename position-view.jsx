// By Position view — four columns (QB, RB, WR, TE), each a list of picks.
// Round chip on the left uses the gradient palette.

const POSITIONS = [
  { code: 'QB', label: 'Quarterback' },
  { code: 'RB', label: 'Running Back' },
  { code: 'WR', label: 'Wide Receiver' },
  { code: 'TE', label: 'Tight End' },
];

const PositionView = ({ picks, palette, dark, density, hoverPick, setHoverPick, roundFilter }) => {
  const grouped = React.useMemo(() => {
    const m = { QB: [], RB: [], WR: [], TE: [] };
    picks.forEach(p => { if (m[p.pos]) m[p.pos].push(p); });
    Object.values(m).forEach(arr => arr.sort((a, b) => a.overall - b.overall));
    return m;
  }, [picks]);

  const padY = density === 'compact' ? 6 : 10;
  const padX = density === 'compact' ? 10 : 14;
  const fontSize = density === 'compact' ? 13 : 14;
  const chipW = density === 'compact' ? 56 : 64;

  return (
    <div className="pos-grid">
      {POSITIONS.map(({ code, label }) => {
        const list = grouped[code] || [];
        return (
          <section key={code} className="pos-col">
            <header className="pos-header">
              <div className="pos-label-wrap">
                <span className="pos-tag" data-pos={code}>{code}</span>
                <h2 className="pos-title">{label}</h2>
              </div>
              <span className="pos-count">{list.length}</span>
            </header>
            <div className="pos-list" style={{ fontSize }}>
              {list.length === 0 && (
                <div className="empty-row">No picks match.</div>
              )}
              {list.map((p, i) => {
                const swatch = window.roundSwatch(palette, p.round, dark);
                const isHover = hoverPick === p.pick + p.name;
                const dim = roundFilter !== 'all' && Number(roundFilter) !== p.round;
                return (
                  <div
                    key={p.pick + p.name}
                    className={`pick-row${isHover ? ' is-hover' : ''}${dim ? ' is-dim' : ''}`}
                    onMouseEnter={() => setHoverPick(p.pick + p.name)}
                    onMouseLeave={() => setHoverPick(null)}
                    style={{ padding: `${padY}px ${padX}px` }}
                  >
                    <div
                      className="round-chip"
                      style={{
                        background: swatch.bg,
                        color: swatch.fg,
                        width: chipW,
                      }}
                      title={`Round ${p.round}`}
                    >
                      {p.pick}
                    </div>
                    <div className="pick-name">{p.name}</div>
                    <div className="pick-team">
                      <TeamBadge code={p.team} size={density === 'compact' ? 22 : 26} ring={false} />
                      <span className="pick-team-code">{p.team}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
};

window.PositionView = PositionView;
