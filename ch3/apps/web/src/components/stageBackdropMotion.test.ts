import { describe, expect, it } from "vite-plus/test";

import { stepStageParticle, type StageParticle } from "./stageBackdropMotion";

const particleAt = (homeX: number, homeY: number): StageParticle => ({
  homeX,
  homeY,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
});

describe("stepStageParticle", () => {
  it("pushes a particle away from a pointer beside it", () => {
    const particle = particleAt(100, 40);
    stepStageParticle(particle, { x: 80, y: 40 });
    expect(particle.x).toBeGreaterThan(0);
  });

  it("leaves particles outside the repel radius alone", () => {
    const particle = particleAt(100, 40);
    stepStageParticle(particle, { x: 900, y: 40 });
    expect(particle.x).toBe(0);
    expect(particle.y).toBe(0);
  });

  it("settles back home once the pointer is gone, and reports when it has", () => {
    const particle = particleAt(100, 40);
    for (let frame = 0; frame < 20; frame++) stepStageParticle(particle, { x: 80, y: 40 });
    expect(particle.x).toBeGreaterThan(0);

    let moving = true;
    let frames = 0;
    while (moving && frames++ < 400) moving = stepStageParticle(particle, null);

    expect(moving).toBe(false);
    expect(Math.hypot(particle.x, particle.y)).toBeLessThan(0.2);
  });

  it("stays finite when the pointer sits exactly on a particle", () => {
    const particle = particleAt(100, 40);
    stepStageParticle(particle, { x: 100, y: 40 });
    expect(Number.isFinite(particle.x)).toBe(true);
    expect(Number.isFinite(particle.y)).toBe(true);
  });
});
