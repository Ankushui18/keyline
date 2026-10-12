import { describe, expect, it } from 'vitest';
import { evaluateNumericExpression } from './numeric-expression';

describe('evaluateNumericExpression', () => {
  it('parses absolute values and arithmetic', () => {
    expect(evaluateNumericExpression('48', 10)?.value).toBe(48);
    expect(evaluateNumericExpression('(5 * 3) - 10 / 2', 0)?.value).toBe(10);
    expect(evaluateNumericExpression('2^3^2', 0)?.value).toBe(512);
  });

  it('applies leading operators to the current value', () => {
    expect(evaluateNumericExpression('+15', 40)).toEqual({ value: 55, relative: true });
    expect(evaluateNumericExpression('-20', 40)).toEqual({ value: 20, relative: true });
    expect(evaluateNumericExpression('*2', 12)).toEqual({ value: 24, relative: true });
    expect(evaluateNumericExpression('/4', 20)).toEqual({ value: 5, relative: true });
  });

  it('supports x as the current value and explicit absolute negatives', () => {
    expect(evaluateNumericExpression('x/2+6', 20)).toEqual({ value: 16, relative: false });
    expect(evaluateNumericExpression('=-15', 40)).toEqual({ value: -15, relative: false });
  });

  it('rejects malformed, unsafe, and non-finite expressions', () => {
    expect(evaluateNumericExpression('1/0', 10)).toBeNull();
    expect(evaluateNumericExpression('Math.random()', 10)).toBeNull();
    expect(evaluateNumericExpression('2 +', 10)).toBeNull();
    expect(evaluateNumericExpression('', 10)).toBeNull();
  });
});
