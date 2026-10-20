import { palette } from './tokens';

interface BrandMarkProps {
  /** Rendered size in px. The artwork is authored in a 64×64 viewBox. */
  size?: number;
  /** Decorative when it sits next to the wordmark; labelled when it stands alone. */
  label?: string;
  className?: string;
}

/**
 * The Keyline mark, drawn once.
 *
 * It used to be copy-pasted into the top bar, the dashboard and the motion
 * workspace, which meant three hard-coded palettes to keep in step. Colours now
 * come from the token module so the mark always matches the surrounding chrome.
 */
export function BrandMark({ size = 28, label, className }: BrandMarkProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      {...a11y}
    >
      <rect width="64" height="64" rx="14" fill={palette.graphite800} />
      <rect x="14" y="14" width="36" height="36" fill="none" stroke={palette.graphite200} strokeWidth="3.5" />
      <circle cx="32" cy="32" r="18" fill="none" stroke={palette.graphite200} strokeWidth="3.5" />
      <rect x="44" y="8" width="12" height="12" fill={palette.blue500} />
    </svg>
  );
}
