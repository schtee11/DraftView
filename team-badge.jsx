// Team badge — renders the official team logo via ESPN's CDN.
// Falls back to a colored abbreviation circle if the image fails to load
// (e.g. offline, ad-blocker, or unknown team code).
const TeamBadge = ({ code, size = 36, ring = false }) => {
  const team = (window.DRAFT_DATA?.teams || {})[code];
  const [errored, setErrored] = React.useState(false);

  if (!team) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'var(--surface-2)', color: 'var(--text-muted)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.32, fontWeight: 700, fontFamily: 'var(--font-mono)',
        border: '1px solid var(--border)',
      }}>{code}</div>
    );
  }

  if (errored) {
    const { primary, secondary, text } = team;
    const fontSize = code.length >= 3 ? size * 0.32 : size * 0.40;
    return (
      <div
        title={team.name}
        style={{
          width: size, height: size, borderRadius: '50%',
          background: primary, color: text,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize, fontWeight: 800, letterSpacing: '0.02em',
          fontFamily: 'var(--font-display)',
          boxShadow: ring ? `inset 0 0 0 2px ${secondary}, 0 1px 2px rgba(0,0,0,0.08)` : 'none',
          flexShrink: 0, userSelect: 'none',
        }}
      >{code}</div>
    );
  }

  const slug = team.espn || code.toLowerCase();
  return (
    <img
      src={`https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`}
      alt={team.name}
      title={team.name}
      width={size}
      height={size}
      onError={() => setErrored(true)}
      style={{
        width: size, height: size,
        objectFit: 'contain',
        flexShrink: 0,
        userSelect: 'none',
        display: 'inline-block',
      }}
    />
  );
};

window.TeamBadge = TeamBadge;
