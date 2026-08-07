interface TheatreMaskIconProps {
  className?: string;
}

/**
 * A single theatre mask, for the composer's response-style chip.
 *
 * Lucide only ships the pair (`drama`), and the pair does not survive being
 * drawn at 12px: four of its eight paths are `.01`-length dots that fall under
 * one pixel. This draws one mask instead, and keeps every interior feature at
 * least two units wide so nothing collapses at chip size. Stroke geometry
 * matches lucide's own (24-unit box, 2-wide round-capped strokes) so it sits
 * beside the other icons without looking foreign.
 */
export function TheatreMaskIcon({ className }: TheatreMaskIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...(className ? { className } : {})}
    >
      {/* Mask outline: square shoulders, wide rounded chin. */}
      <path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v5a8 8 0 0 1-16 0z" />
      {/* Eyes, 2 units wide so they read as marks rather than dots. */}
      <path d="M8.5 9.5c.6-.7 1.4-.7 2 0" />
      <path d="M13.5 9.5c.6-.7 1.4-.7 2 0" />
      {/* Smile, the widest interior stroke and the feature that carries the
          shape at small sizes. */}
      <path d="M9 13.2c1.3 1.4 4.7 1.4 6 0" />
    </svg>
  );
}
