// Icons for support blockers and enforcers, after desktop's (menu_support_blocker.svg,
// menu_support_enforcer.svg): an overhang with supports under it, held up or kept away. Drawn as
// lucide's are (24 × 24, round strokes in the text colour).
// SPDX-License-Identifier: AGPL-3.0-or-later

type Props = { size?: number; className?: string };

const frame = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    {children}
  </svg>
);

/** An overhang: a wall with a ledge sticking out to the left. */
const LEDGE = 'M3 3h18v18h-4V7H3Z';

/** An overhang held up by supports. */
export function SupportEnforcerIcon({ size = 24, className }: Props) {
  return frame(
    size,
    className,
    <>
      <path d={LEDGE} />
      <path d="M6 7v14M11 7v14" />
    </>,
  );
}

/** An overhang with no supports under it. */
export function SupportBlockerIcon({ size = 24, className }: Props) {
  return frame(
    size,
    className,
    <>
      <path d={LEDGE} />
      <path d="m5.5 11 8 8M13.5 11l-8 8" />
    </>,
  );
}
