import { describe, expect, it } from 'vitest';
import { prepareCreateIconArtboard } from './artboard-operations';
import { analyzeConsistency } from './consistency';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import { drawnObjectCount, realArtboards } from './real-content';
import { planQuickEdit } from './quick-edit';
import { buildAnimatedSvg, clampMotionSettings, DEFAULT_MOTION_SETTINGS, motionTotalMs, motionTracks } from '../export/motion-export';

describe('placeholder handling', () => {
  it('does not count empty starter frames or empty placeholder objects', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = prepareCreateIconArtboard(document, 24, 24);
    manager.beginTransaction('frame');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(drawnObjectCount(document)).toBe(0);
    const report = analyzeConsistency(document);
    expect(report.objectCount).toBe(0);
    expect(realArtboards(document).length).toBeGreaterThan(0);
  });
});

describe('quick edit', () => {
  const target = { id: 'a', strokeWidth: 2, strokeCap: 'butt' as const, strokeJoin: 'miter' as const };
  it('applies exact widths', () => {
    const plan = planQuickEdit('line 1.5', [target]);
    expect(plan.ok && plan.steps[0].updates.strokeWidth).toBe(1.5);
  });
  it('makes lines thinner without getting stuck', () => {
    const plan = planQuickEdit('thinner', [target]);
    expect(plan.ok && plan.steps[0].updates.strokeWidth).toBeLessThan(2);
  });
  it('refuses phrases it cannot read', () => {
    expect(planQuickEdit('make it pop', [target]).ok).toBe(false);
  });
  it('asks for a selection', () => {
    expect(planQuickEdit('thinner', []).ok).toBe(false);
  });
  it('removes fill and rounds ends', () => {
    const plan = planQuickEdit('no fill and round ends', [target]);
    expect(plan.ok && plan.steps[0].updates).toMatchObject({ fillRemoved: true, strokeCap: 'round' });
  });
});

describe('motion export', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" fill="none"/><path d="M0 0L1 0L1 1Z"/></svg>';
  it('adds classes and a style block to every path', () => {
    const out = buildAnimatedSvg(svg, DEFAULT_MOTION_SETTINGS);
    expect(out).toContain('<style>');
    expect(out.match(/class="kl kl-line"/g)).toHaveLength(1);
    expect(out.match(/class="kl kl-fill"/g)).toHaveLength(1);
    expect(out).toContain('prefers-reduced-motion');
  });
  it('returns the original when there is nothing to animate', () => {
    expect(buildAnimatedSvg('<svg></svg>', DEFAULT_MOTION_SETTINGS)).toBe('<svg></svg>');
  });
  it('clamps settings and computes totals', () => {
    expect(clampMotionSettings({ ...DEFAULT_MOTION_SETTINGS, durationMs: -5 }).durationMs).toBe(100);
    expect(motionTotalMs(3, { ...DEFAULT_MOTION_SETTINGS, delayMs: 0, staggerMs: 100, durationMs: 500 })).toBe(700);
    expect(motionTracks(10, DEFAULT_MOTION_SETTINGS)).toHaveLength(6);
  });
});
