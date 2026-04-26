// Original team badge — abbreviation set on a shield in team colors.
// NOT the real NFL logos; an original mark that uses public team colors as a tribute identifier.
const TeamBadge = ({ code, size = 36, ring = true }) => {
  const team = (window.DRAFT_DATA?.teams || {})[code];
  if (!team) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'var(--surface-2)', color: 'var(--text-muted)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.32, fontWeight: 700, fontFamily: 'var(--font-mono)',
        border: '1px solid var(--border)'
      }}>{code}</div>
    );
  }
  const { primary, secondary, text } = team;
  const fontSize = code.length >= 3 ? size * 0.32 : size * 0.40;
  return (
    <div
      title={team.name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: primary,
        color: text,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize,
        fontWeight: 800,
        letterSpacing: '0.02em',
        fontFamily: 'var(--font-display)',
        boxShadow: ring ? `inset 0 0 0 2px ${secondary}, 0 1px 2px rgba(0,0,0,0.08)` : 'none',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {code}
    </div>
  );
};

window.TeamBadge = TeamBadge;
