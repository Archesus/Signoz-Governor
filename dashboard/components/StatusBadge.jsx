const STATE_STYLES = {
    healthy: { dot: 'bg-[hsl(var(--healthy))]', label: 'Running smoothly', pulse: true },
    monitoring: { dot: 'bg-[hsl(var(--healthy))]', label: 'Running smoothly', pulse: true },
    warning: { dot: 'bg-[hsl(var(--warning))]', label: 'Needs attention', pulse: true },
    tripped: { dot: 'bg-[hsl(var(--tripped))]', label: 'Paused', pulse: false },
  };
  
  export function StatusBadge({ state }) {
    const style = STATE_STYLES[state] || STATE_STYLES.healthy;
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--card-border))] px-3 py-1 text-sm">
        <span className="relative flex h-2 w-2">
          {style.pulse && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${style.dot}`}
            />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
        </span>
        {style.label}
      </span>
    );
  }