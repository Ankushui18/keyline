import type { ObjectTransform, Point } from './types';

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Returns T × R × S. Rotation is stored in degrees. */
export function objectTransformMatrix(transform: ObjectTransform): Matrix2D {
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    a: cosine * transform.scaleX,
    b: sine * transform.scaleX,
    c: -sine * transform.scaleY,
    d: cosine * transform.scaleY,
    e: transform.x,
    f: transform.y,
  };
}

/** Composes matrices so the returned matrix applies right first, then left. */
export function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function mirrorMatrix(axis: 'x' | 'y', origin: Point): Matrix2D {
  return reflectionMatrix(axis === 'x' ? 0 : Math.PI / 2, origin);
}

/** Reflection across an arbitrary line through origin at angle radians. */
export function reflectionMatrix(angle: number, origin: Point): Matrix2D {
  const cosine = Math.cos(2 * angle);
  const sine = Math.sin(2 * angle);
  const a = cosine;
  const b = sine;
  const c = sine;
  const d = -cosine;
  return {
    a,
    b,
    c,
    d,
    e: origin.x - a * origin.x - c * origin.y,
    f: origin.y - b * origin.x - d * origin.y,
  };
}

export function rotationMatrix(angle: number, center: Point): Matrix2D {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: center.x - cosine * center.x + sine * center.y,
    f: center.y - sine * center.x - cosine * center.y,
  };
}

export function transformPoint(point: Point, matrix: Matrix2D): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function inverseMatrix(matrix: Matrix2D): Matrix2D | undefined {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-12) return undefined;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function matrixScale(matrix: Matrix2D): { x: number; y: number } {
  return { x: Math.hypot(matrix.a, matrix.b), y: Math.hypot(matrix.c, matrix.d) };
}

export function isIdentityMatrix(matrix: Matrix2D, tolerance = 1e-12): boolean {
  return Math.abs(matrix.a - 1) <= tolerance && Math.abs(matrix.b) <= tolerance &&
    Math.abs(matrix.c) <= tolerance && Math.abs(matrix.d - 1) <= tolerance &&
    Math.abs(matrix.e) <= tolerance && Math.abs(matrix.f) <= tolerance;
}
