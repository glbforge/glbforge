/**
 * The GLBForge cube: the same geometry as `site/favicon.svg`, drawn from the
 * studio's palette tokens. Flat colour blocks only — interior detail does not
 * survive the sizes this renders at.
 */
export function Mark({ size = '1em' }: { size?: number | string }) {
  return (
    <svg className="mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <polygon points="32,5 55,18.5 32,32 9,18.5" fill="var(--accent-2)" />
      <polygon points="55,18.5 55,45.5 32,59 32,32" fill="var(--accent)" />
      <polygon points="9,18.5 32,32 32,59 9,45.5" fill="var(--accent-shade)" />
    </svg>
  );
}
