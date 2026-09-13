import { useAtomValue } from "@effect/atom-react";
import { useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

/**
 * Which header artwork a window wears.
 *
 * Named for the art rather than for a build stage, because it no longer maps
 * one-to-one onto one: the blueprint is what every window shows unless it is a
 * nightly, so calling it "dev" would have it reading as a mislabelled window on
 * every shipped build.
 */
export type SidebarStageBackdropVariant = "nightly" | "blueprint";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

// A wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene.
const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";

/**
 * The artwork for a stage, or `null` when the user has turned artwork off.
 *
 * Every stage gets art. It began as a way to tell a Dev or Nightly window from
 * the real app at a glance, which left the app people actually use as the one
 * with a blank header — the plainest window being the one you look at all day.
 * Nightly keeps its own sky; everything else, shipped builds included, wears
 * the blueprint. Dev and Nightly windows are still identifiable without it:
 * both carry their stage in the window title, and the pill mode names them
 * outright.
 */
export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  return stageLabel.trim().toLowerCase() === "nightly" ? "nightly" : "blueprint";
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), enabled);
}

/**
 * Artwork that exists to say "this is NOT the app you installed".
 *
 * The header art is now on everywhere, which is what makes this a separate
 * question. The send button and the sidebar toggle change COLOUR when a window
 * is marked — the most-used control in the app stops being `bg-primary` — and
 * that is a price worth paying to tell a dev window apart, but not one to
 * charge every shipped install for. Those two surfaces stay on Dev and Nightly
 * only; the header is the part that greets everyone.
 */
export function resolveStageIdentificationVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  return normalized === "dev" ? "blueprint" : null;
}

export function useStageIdentificationVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveStageIdentificationVariant(useEnvironmentStageLabel(), enabled);
}

/**
 * Glyphs that drift in the art and scatter away from the pointer. Positions are
 * fixed so the layout never depends on random values, and the sparse right-hand
 * half keeps them clear of the wordmark.
 */
const STAGE_PARTICLES: ReadonlyArray<{
  glyph: string;
  x: number;
  y: number;
  size: number;
  opacity: number;
}> = [
  { glyph: "+", x: 18, y: 22, size: 11, opacity: 0.4 },
  { glyph: "×", x: 44, y: 58, size: 9, opacity: 0.32 },
  { glyph: "⟡", x: 70, y: 16, size: 10, opacity: 0.46 },
  { glyph: "·", x: 96, y: 46, size: 13, opacity: 0.36 },
  { glyph: "◇", x: 124, y: 66, size: 9, opacity: 0.3 },
  { glyph: "+", x: 152, y: 26, size: 10, opacity: 0.42 },
  { glyph: "⌁", x: 180, y: 54, size: 11, opacity: 0.34 },
  { glyph: "×", x: 208, y: 14, size: 9, opacity: 0.44 },
  { glyph: "∘", x: 238, y: 62, size: 12, opacity: 0.3 },
  { glyph: "+", x: 268, y: 34, size: 10, opacity: 0.38 },
  { glyph: "⋯", x: 300, y: 52, size: 11, opacity: 0.32 },
  { glyph: "⟡", x: 332, y: 20, size: 9, opacity: 0.4 },
];

/** Stage-channel header art; palettes mirror the per-channel app icons in `assets/`. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
      <div className="stage-spotlight" />
      <div className="stage-particles">
        {STAGE_PARTICLES.map((particle) => (
          <span
            key={`${particle.glyph}-${particle.x}`}
            data-stage-particle
            style={{
              left: particle.x,
              top: particle.y,
              fontSize: particle.size,
              opacity: particle.opacity,
            }}
          >
            {particle.glyph}
          </span>
        ))}
      </div>
    </div>
  );
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt /> : <DevBlueprintArt />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt compact /> : <DevBlueprintArt compact />;
}

const NIGHTLY_STARS: ReadonlyArray<{
  cx: number;
  cy: number;
  r: number;
  opacity: number;
}> = [
  { cx: 14, cy: 10, r: 0.6, opacity: 0.85 },
  { cx: 38, cy: 22, r: 0.4, opacity: 0.55 },
  { cx: 58, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 84, cy: 16, r: 0.4, opacity: 0.5 },
  { cx: 104, cy: 7, r: 0.6, opacity: 0.8 },
  { cx: 126, cy: 20, r: 0.4, opacity: 0.55 },
  { cx: 148, cy: 11, r: 0.5, opacity: 0.7 },
  { cx: 170, cy: 24, r: 0.4, opacity: 0.5 },
  { cx: 192, cy: 9, r: 0.6, opacity: 0.8 },
  { cx: 214, cy: 18, r: 0.4, opacity: 0.55 },
  { cx: 236, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 258, cy: 20, r: 0.45, opacity: 0.6 },
  { cx: 278, cy: 11, r: 0.55, opacity: 0.75 },
  { cx: 26, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 118, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 202, cy: 32, r: 0.4, opacity: 0.5 },
  { cx: 268, cy: 34, r: 0.4, opacity: 0.45 },
];

const NIGHTLY_SPARKLES: ReadonlyArray<{ x: number; y: number }> = [
  { x: 70, y: 28 },
  { x: 160, y: 36 },
  { x: 246, y: 26 },
];

function NightlySkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-night-sky`;
  const glowId = `${idPrefix}-stage-night-glow`;
  const cloudId = `${idPrefix}-stage-night-cloud`;
  const softId = `${idPrefix}-stage-night-soft`;
  const starsId = `${idPrefix}-stage-night-stars`;
  const glowsId = `${idPrefix}-stage-night-glows`;
  const skyBreatheId = `${idPrefix}-stage-night-sky-breathe`;

  return (
    <svg
      className="stage-night h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={skyId}
          x1="24"
          y1="0"
          x2="264"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="#07152F" />
          <stop offset="0.5" stopColor="#151443" />
          <stop offset="1" stopColor="#32155B" />
        </linearGradient>
        {/* The breathing counterpart of the sky; see the blueprint art. */}
        <linearGradient
          id={skyBreatheId}
          x1="264"
          y1="0"
          x2="24"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="#32155B" />
          <stop offset="0.5" stopColor="#07152F" />
          <stop offset="1" stopColor="#151443" />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 18) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5165D8" stopOpacity="0.4" />
          <stop offset="0.5" stopColor="#283075" stopOpacity="0.16" />
          <stop offset="1" stopColor="#111635" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={cloudId} x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4EA4FF" stopOpacity="0.5" />
          <stop offset="0.52" stopColor="#696FEA" stopOpacity="0.62" />
          <stop offset="1" stopColor="#A85BEA" stopOpacity="0.5" />
        </linearGradient>
        <filter id={softId} x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <pattern id={starsId} width="288" height="96" patternUnits="userSpaceOnUse">
          <g fill="#E4EAFF">
            {NIGHTLY_STARS.map((star) => (
              <circle
                key={`${star.cx}-${star.cy}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fillOpacity={star.opacity}
              />
            ))}
          </g>
          <g stroke="#C8D7FF" strokeLinecap="round" strokeOpacity="0.7" strokeWidth="0.6">
            {NIGHTLY_SPARKLES.map((sparkle) => (
              <g key={`${sparkle.x}-${sparkle.y}`}>
                <path d={`M${sparkle.x - 1.5} ${sparkle.y}H${sparkle.x + 1.5}`} />
                <path d={`M${sparkle.x} ${sparkle.y - 1.5}V${sparkle.y + 1.5}`} />
              </g>
            ))}
          </g>
        </pattern>
        <pattern id={glowsId} width="640" height="96" patternUnits="userSpaceOnUse">
          <rect width="640" height="96" fill={`url(#${glowId})`} />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect className="stage-breathe" width="100%" height="96" fill={`url(#${skyBreatheId})`} />
      <rect
        className="stage-glow-layer"
        x="-640"
        width="200%"
        height="96"
        fill={`url(#${glowsId})`}
      />
      <g className="stage-grid-layer">
        <rect width="100%" height="96" fill={`url(#${starsId})`} />
      </g>

      <g filter={`url(#${softId})`}>
        <path
          d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z"
          fill={`url(#${cloudId})`}
        />
      </g>
      <g filter={`url(#${softId})`}>
        <path
          d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z"
          fill={`url(#${cloudId})`}
          fillOpacity="0.8"
        />
      </g>
    </svg>
  );
}

/**
 * Drafting paper: grid, rulers and dimension annotations.
 *
 * Purple rather than blueprint blue — the motif is what the name refers to,
 * and the ink is CH3's. Every hue here sits in a 248-279deg band centred on
 * `--ch3-brand` (262deg), and each colour kept the saturation and lightness
 * of the blue it replaced, so nothing about contrast against the white
 * wordmark and the traffic lights changed. The paper gradient reads its three
 * stops from `--stage-bp-*` in `index.css`, which is where the light and dark
 * ramps live; the glows and the ink are here, next to the stops they belong
 * to.
 */
function DevBlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const indigoGlowId = `${idPrefix}-stage-bp-glow-indigo`;
  const orchidGlowId = `${idPrefix}-stage-bp-glow-orchid`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;
  const paperBreatheId = `${idPrefix}-stage-bp-paper-breathe`;

  return (
    <svg
      className="stage-blueprint h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-bp-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-bp-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-bp-top)" }} />
        </linearGradient>
        {/* Same three tokens, raked the other way; cross-fading the two is what
            makes the paper look like it is slowly breathing. */}
        <linearGradient
          id={paperBreatheId}
          x1="220"
          y1="0"
          x2="60"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-bp-top)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-bp-bottom)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-bp-mid)" }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#DFD4FF" stopOpacity="0.4" />
          <stop offset="0.52" stopColor="#9665FF" stopOpacity="0.16" />
          <stop offset="1" stopColor="#8727F1" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={indigoGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#D8D2FF" stopOpacity="0.34" />
          <stop offset="0.5" stopColor="#6D48F5" stopOpacity="0.18" />
          <stop offset="1" stopColor="#7D27F1" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={orchidGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F2D8FF" stopOpacity="0.3" />
          <stop offset="0.52" stopColor="#C97CFF" stopOpacity="0.14" />
          <stop offset="1" stopColor="#8F31DF" stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M8 0H0V8" stroke="#F1EAFF" strokeOpacity="0.14" strokeWidth="0.5" />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" stroke="#F1EAFF" strokeOpacity="0.26" strokeWidth="0.6" />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            stroke="#E6DDFF"
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${indigoGlowId})`} />
          <rect width="768" height="96" fill={`url(#${orchidGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g stroke="#E6DDFF" strokeLinecap="round" strokeOpacity="0.6" strokeWidth="0.7">
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g stroke="#E6DDFF" strokeLinecap="round" strokeOpacity="0.55" strokeWidth="0.6">
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g stroke="#E6DDFF" strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect className="stage-breathe" width="100%" height="96" fill={`url(#${paperBreatheId})`} />
      {/* Drawn one pattern tile wide on each side so the drift can translate a
          whole tile and land back where it started — a loop with no seam. */}
      <rect
        className="stage-glow-layer"
        x="-768"
        width="200%"
        height="96"
        fill={`url(#${glowsId})`}
      />
      <g className="stage-grid-layer">
        <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
        <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
        <rect width="100%" height="6" fill={`url(#${rulerId})`} />
        <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
      </g>
    </svg>
  );
}
