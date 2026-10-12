import type { Point } from '../core/types';

export interface ViewportState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export class Viewport {
  offsetX = 0;
  offsetY = 0;
  scale = 1;

  get state(): ViewportState {
    return { offsetX: this.offsetX, offsetY: this.offsetY, scale: this.scale };
  }

  screenToWorld(point: Point): Point {
    return {
      x: (point.x - this.offsetX) / this.scale,
      y: (point.y - this.offsetY) / this.scale,
    };
  }

  worldToScreen(point: Point): Point {
    return {
      x: point.x * this.scale + this.offsetX,
      y: point.y * this.scale + this.offsetY,
    };
  }

  panBy(deltaX: number, deltaY: number): void {
    this.offsetX += deltaX;
    this.offsetY += deltaY;
  }

  zoomAt(screenPoint: Point, factor: number): void {
    const before = this.screenToWorld(screenPoint);
    this.scale = clamp(this.scale * factor, 0.08, 200);
    this.offsetX = screenPoint.x - before.x * this.scale;
    this.offsetY = screenPoint.y - before.y * this.scale;
  }

  centerOn(width: number, height: number): void {
    this.offsetX = width / 2;
    this.offsetY = height / 2;
  }

  fitBounds(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    width: number,
    height: number,
    padding = 72,
  ): void {
    const contentWidth = Math.max(1e-6, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1e-6, bounds.maxY - bounds.minY);
    const availableWidth = Math.max(1, width - padding * 2);
    const availableHeight = Math.max(1, height - padding * 2);
    // Avoid extreme zoom for point-like selections while retaining the global
    // 20,000% precision ceiling for explicit wheel zoom.
    // Small icon artboards are shown at a deliberate 20× working scale, matching
    // the supplied 24 px editing composition while wheel zoom still reaches 200×.
    this.scale = clamp(Math.min(availableWidth / contentWidth, availableHeight / contentHeight), 0.08, 20);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const isIconScale = contentWidth <= 64 && contentHeight <= 64;
    // The compact Keyline editing composition places icon artboards one screen
    // pixel right of the main-canvas center and seven pixels below it.
    const horizontalBias = isIconScale ? 1 : 0;
    const verticalBias = isIconScale ? 7 : 0;
    this.offsetX = width / 2 + horizontalBias - centerX * this.scale;
    this.offsetY = height / 2 + verticalBias - centerY * this.scale;
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
