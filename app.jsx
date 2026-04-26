// Main app — orchestrates view switching, search, filters, and tweaks.

const { useState, useMemo, useEffect } = React;

const TWEAK_DEFAULTS = {
  palette: 'forest',
  dark: false,
  density: 'comfortable',
};

const ROUNDS = [1, 2, 3, 4, 5, 6, 7];

function openTweaks() {
  window.postMessage({ type: '__activate_edit_mode' }, '*');
}

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState('position'); // 'position' | 'team' | 'analysis'
  const [search, setSearch] = useState('');
  const [roundFilter, setRoundFilter] = useState('all'); // 'all' | 1..7
  const [teamFilter, setTeamFilter] = useState('all');
  const [selectedTeam, setSelectedTeam] = useState('CIN');
  const [hoverPick, setHoverPick] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-dark', tweaks.dark ? 'true' : 'false');
  }, [tweaks.dark]);

  const allPicks = window.DRAFT_DATA.picks;

  // Filtered picks
  const filteredPicks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allPicks.filter(p => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (teamFilter !== 'all' && p.team !== teamFilter && !(teamFilter === 'NE' && p.team === 'NEP')) return false;
      // round filter applies as DIM (still shown) in position view; HIDE in team view
      if (view === 'team' && roundFilter !== 'all' && Number(roundFilter) !== p.round) return false;
      return true;
    });
  }, [allPicks, search, teamFilter, roundFilter, view]);

  const roundCounts = useMemo(() => {
    const c = {};
    ROUNDS.forEach(r => c[r] = 0);
    allPicks.forEach(p => { c[p.round] = (c[p.round] || 0) + 1; });
    return c;
  }, [allPicks]);

  const teams = window.DRAFT_DATA.teams;
  const teamCodes = Object.keys(teams).filter(k => k !== 'NEP').sort();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div>
            <div className="brand-eyebrow">2026 NFL Draft · Fantasy</div>
            <h1 className="brand-title">The <em>Skill-Position</em> Board</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="view-toggle" role="tablist">
            <button
              className={view === 'position' ? 'is-active' : ''}
              onClick={() => setView('position')}
              role="tab" aria-selected={view === 'position'}
            >
              By Position
            </button>
            <button
              className={view === 'team' ? 'is-active' : ''}
              onClick={() => setView('team')}
              role="tab" aria-selected={view === 'team'}
            >
              By Team
            </button>
            <button
              className={view === 'analysis' ? 'is-active' : ''}
              onClick={() => setView('analysis')}
              role="tab" aria-selected={view === 'analysis'}
            >
              Analysis
            </button>
          </div>
          <button
            type="button"
            className="tweaks-trigger"
            onClick={openTweaks}
            aria-label="Open tweaks panel"
          >
            ⚙ Tweaks
          </button>
        </div>
      </header>

      <div className="filters">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search by player name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {view !== 'analysis' && (
          <div className="round-filter">
            <span className="round-filter-label">Round</span>
            <button
              className={`round-pill all${roundFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setRoundFilter('all')}
            >
              <span className="swatch"></span>All
            </button>
            {ROUNDS.map(r => {
              const sw = window.roundSwatch(tweaks.palette, r, tweaks.dark);
              return (
                <button
                  key={r}
                  className={`round-pill${roundFilter === r ? ' is-active' : ''}`}
                  onClick={() => setRoundFilter(r)}
                >
                  <span className="swatch" style={{ background: sw.bg }}></span>
                  R{r}
                </button>
              );
            })}
          </div>
        )}

        {view === 'position' && (
          <div className="team-select">
            <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
              <option value="all">All teams</option>
              {teamCodes.map(c => (
                <option key={c} value={c}>{c} — {teams[c].short}</option>
              ))}
            </select>
          </div>
        )}

        {view !== 'analysis' && (
          <div className="results-count">
            {filteredPicks.length} / {allPicks.length} picks
          </div>
        )}
      </div>

      {view === 'position' && (
        <>
          <div className="round-legend">
            {ROUNDS.map(r => {
              const sw = window.roundSwatch(tweaks.palette, r, tweaks.dark);
              const dim = roundFilter !== 'all' && Number(roundFilter) !== r;
              return (
                <div
                  key={r}
                  className={`round-legend-item${dim ? ' is-dim' : ''}`}
                  style={{ background: sw.bg, color: sw.fg }}
                  onClick={() => setRoundFilter(roundFilter === r ? 'all' : r)}
                >
                  <span>Round {r}</span>
                  <span className="round-legend-count">{roundCounts[r] || 0}</span>
                </div>
              );
            })}
          </div>

          <PositionView
            picks={filteredPicks}
            palette={tweaks.palette}
            dark={tweaks.dark}
            density={tweaks.density}
            hoverPick={hoverPick}
            setHoverPick={setHoverPick}
            roundFilter={roundFilter}
          />
        </>
      )}

      {view === 'team' && (
        <TeamView
          picks={filteredPicks}
          palette={tweaks.palette}
          dark={tweaks.dark}
          density={tweaks.density}
          selectedTeam={selectedTeam}
          setSelectedTeam={setSelectedTeam}
          hoverPick={hoverPick}
          setHoverPick={setHoverPick}
        />
      )}

      {view === 'analysis' && (
        <AnalysisView
          search={search}
          palette={tweaks.palette}
          dark={tweaks.dark}
          density={tweaks.density}
          hoverPick={hoverPick}
          setHoverPick={setHoverPick}
        />
      )}

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Appearance">
          <window.TweakToggle
            label="Dark mode"
            value={tweaks.dark}
            onChange={v => setTweak('dark', v)}
          />
          <window.TweakRadio
            label="Density"
            value={tweaks.density}
            onChange={v => setTweak('density', v)}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfy' },
            ]}
          />
        </window.TweakSection>
        <window.TweakSection label="Round palette">
          <window.TweakSelect
            label="Hue"
            value={tweaks.palette}
            onChange={v => setTweak('palette', v)}
            options={Object.keys(window.PALETTES).map(k => ({
              value: k,
              label: window.PALETTES[k].label,
            }))}
          />
          <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
            {ROUNDS.map(r => {
              const sw = window.roundSwatch(tweaks.palette, r, tweaks.dark);
              return (
                <div key={r} style={{
                  flex: 1, height: 22, borderRadius: 4,
                  background: sw.bg, color: sw.fg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                }}>{r}</div>
              );
            })}
          </div>
        </window.TweakSection>
      </window.TweaksPanel>
    </div>
  );
}

window.App = App;
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
