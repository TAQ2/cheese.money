/**
 * Baseline comparison.
 *
 * Real pixel comparison, not a byte heuristic: PNG encoders are free to emit
 * different bytes for identical images, so a size/byte delta cannot tell "the
 * button moved" from "zlib picked another block split". `pngjs` is already a
 * dependency of this package (the mobile screenshot harness uses it), so the
 * honest comparison costs nothing extra.
 *
 * Precision limits, stated up front:
 * - Anti-aliasing and subpixel text shift a few channels between runs; a pixel
 *   only counts as changed once a channel moves more than `channelTolerance`.
 * - A run fails on the *ratio* of changed pixels, so a caret blink or a
 *   one-minute-older relative timestamp does not fail a view while a moved
 *   panel does. Tune with --tolerance.
 * - Different machines render fonts differently. Baselines are per-machine (see
 *   README) — never compare across hosts.
 */
import { PNG } from "pngjs";

export type ComparisonStatus = "created" | "updated" | "match" | "changed" | "resized";

export interface ComparisonResult {
  readonly status: ComparisonStatus;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly ratio: number;
  readonly baselineSize?: { readonly width: number; readonly height: number };
  readonly currentSize?: { readonly width: number; readonly height: number };
}

export interface PixelComparison {
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly ratio: number;
  readonly sameSize: boolean;
  readonly baselineSize: { readonly width: number; readonly height: number };
  readonly currentSize: { readonly width: number; readonly height: number };
  /** Grayscale baseline with changed pixels painted magenta; null when sizes differ. */
  readonly diffImage: Buffer | null;
}

export const DEFAULT_CHANNEL_TOLERANCE = 24;
export const DEFAULT_RATIO_TOLERANCE = 0.005;

export function comparePngBuffers(
  baseline: Buffer,
  current: Buffer,
  options?: { readonly channelTolerance?: number },
): PixelComparison {
  const channelTolerance = options?.channelTolerance ?? DEFAULT_CHANNEL_TOLERANCE;
  const before = PNG.sync.read(baseline);
  const after = PNG.sync.read(current);
  const baselineSize = { width: before.width, height: before.height };
  const currentSize = { width: after.width, height: after.height };
  if (before.width !== after.width || before.height !== after.height) {
    return {
      changedPixels: Math.max(before.width * before.height, after.width * after.height),
      totalPixels: Math.max(before.width * before.height, after.width * after.height),
      ratio: 1,
      sameSize: false,
      baselineSize,
      currentSize,
      diffImage: null,
    };
  }

  const totalPixels = before.width * before.height;
  const diff = new PNG({ width: before.width, height: before.height });
  let changedPixels = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    const deltaR = Math.abs((before.data[index] ?? 0) - (after.data[index] ?? 0));
    const deltaG = Math.abs((before.data[index + 1] ?? 0) - (after.data[index + 1] ?? 0));
    const deltaB = Math.abs((before.data[index + 2] ?? 0) - (after.data[index + 2] ?? 0));
    const deltaA = Math.abs((before.data[index + 3] ?? 0) - (after.data[index + 3] ?? 0));
    const changed = Math.max(deltaR, deltaG, deltaB, deltaA) > channelTolerance;
    if (changed) {
      changedPixels += 1;
      diff.data[index] = 255;
      diff.data[index + 1] = 0;
      diff.data[index + 2] = 255;
      diff.data[index + 3] = 255;
      continue;
    }
    // Washed-out grayscale of the baseline, so the magenta reads at a glance.
    const gray =
      255 -
      (255 -
        ((before.data[index] ?? 0) * 0.299 +
          (before.data[index + 1] ?? 0) * 0.587 +
          (before.data[index + 2] ?? 0) * 0.114)) *
        0.25;
    diff.data[index] = gray;
    diff.data[index + 1] = gray;
    diff.data[index + 2] = gray;
    diff.data[index + 3] = 255;
  }

  return {
    changedPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    sameSize: true,
    baselineSize,
    currentSize,
    diffImage: PNG.sync.write(diff),
  };
}
