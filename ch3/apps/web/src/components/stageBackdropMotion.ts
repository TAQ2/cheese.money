import { useCallback, useEffect, useRef } from "react";

/**
 * Pointer play for the stage-channel header art.
 *
 * Everything the CSS needs travels as custom properties on the host — the
 * pointer position for the spotlight, and a normalized offset for the parallax —
 * so those two effects cost nothing but a property write per frame. Only the
 * glyph particles need real physics, and that loop runs exclusively while the
 * pointer is over the header: it stops asking for frames once the pointer
 * leaves and the particles have settled, so an idle header repaints nothing.
 */

const REPEL_RADIUS = 120;
const REPEL_PUSH = 34;
const SPRING = 0.12;
const FRICTION = 0.82;
const REST_EPSILON = 0.12;
const IDLE_FRAMES = 8;

export type StageParticle = {
  readonly homeX: number;
  readonly homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export type StagePointer = { readonly x: number; readonly y: number };

/**
 * Advances one particle by a frame. The pointer pushes with an inverse-square
 * falloff that dies at `REPEL_RADIUS`, and a spring pulls the particle home.
 * Returns whether the particle is still in motion, which is how the loop knows
 * it may stop.
 */
export function stepStageParticle(particle: StageParticle, pointer: StagePointer | null) {
  let pushX = 0;
  let pushY = 0;

  if (pointer) {
    const dx = particle.homeX + particle.x - pointer.x;
    const dy = particle.homeY + particle.y - pointer.y;
    const distance = Math.hypot(dx, dy) || REST_EPSILON;
    if (distance < REPEL_RADIUS) {
      const falloff = (REPEL_PUSH * (1 - distance / REPEL_RADIUS) ** 2) / distance;
      pushX = dx * falloff;
      pushY = dy * falloff;
    }
  }

  particle.vx = (particle.vx + pushX - particle.x * SPRING) * FRICTION;
  particle.vy = (particle.vy + pushY - particle.y * SPRING) * FRICTION;
  particle.x += particle.vx;
  particle.y += particle.vy;

  return (
    Math.abs(particle.vx) + Math.abs(particle.vy) + Math.abs(particle.x) + Math.abs(particle.y) >
    REST_EPSILON
  );
}

export function useStageBackdropMotion<T extends HTMLElement>() {
  const hostRef = useRef<T | null>(null);
  const pointerRef = useRef<StagePointer | null>(null);
  const frameRef = useRef(0);
  const idleRef = useRef(0);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const runFrame = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;

    const nodes = host.querySelectorAll<HTMLElement>("[data-stage-particle]");
    let moving = false;

    for (const node of nodes) {
      const particle = (node.stageParticle ??= {
        homeX: node.offsetLeft,
        homeY: node.offsetTop,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      });
      if (stepStageParticle(particle, pointerRef.current)) moving = true;
      node.style.transform = `translate3d(${particle.x.toFixed(2)}px,${particle.y.toFixed(2)}px,0)`;
    }

    if (!pointerRef.current && !moving && ++idleRef.current > IDLE_FRAMES) {
      frameRef.current = 0;
      return;
    }
    if (moving) idleRef.current = 0;
    frameRef.current = requestAnimationFrame(runFrame);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      const host = hostRef.current;
      if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const bounds = host.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      pointerRef.current = { x, y };

      host.style.setProperty("--stage-pointer-x", `${x}px`);
      host.style.setProperty("--stage-pointer-y", `${y}px`);
      host.style.setProperty("--stage-parallax-x", `${x / bounds.width - 0.5}`);
      host.style.setProperty("--stage-parallax-y", `${y / bounds.height - 0.5}`);

      if (!frameRef.current) frameRef.current = requestAnimationFrame(runFrame);
    },
    [runFrame],
  );

  const onPointerLeave = useCallback(() => {
    pointerRef.current = null;
    hostRef.current?.style.setProperty("--stage-parallax-x", "0");
    hostRef.current?.style.setProperty("--stage-parallax-y", "0");
  }, []);

  return { hostRef, onPointerMove, onPointerLeave };
}

declare global {
  interface HTMLElement {
    stageParticle?: StageParticle;
  }
}
