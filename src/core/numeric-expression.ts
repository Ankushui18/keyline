export interface NumericExpressionResult {
  value: number;
  relative: boolean;
}

/**
 * Parses the compact equations used by precision fields.
 *
 * A leading operator applies to the current value (`+15`, `-8`, `*2`, `/4`,
 * `^2`). Prefix an expression with `=` to force an absolute negative value,
 * and use `x` anywhere to reference the current value (`x/2+6`).
 */
export function evaluateNumericExpression(input: string, currentValue: number): NumericExpressionResult | null {
  let source = input.trim().toLowerCase().replaceAll('×', '*').replaceAll('÷', '/');
  if (!source) return null;
  let forceAbsolute = false;
  if (source.startsWith('=')) {
    forceAbsolute = true;
    source = source.slice(1).trim();
  }
  if (!source) return null;
  const relative = !forceAbsolute && /^[+\-*/^]/.test(source);
  if (relative) source = `x${source}`;

  const parser = new NumericExpressionParser(source, currentValue);
  const value = parser.parse();
  return value === null || !Number.isFinite(value) ? null : { value, relative };
}

class NumericExpressionParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly currentValue: number,
  ) {}

  parse(): number | null {
    const value = this.parseExpression();
    this.skipWhitespace();
    return value === null || this.index !== this.source.length ? null : value;
  }

  private parseExpression(): number | null {
    let value = this.parseTerm();
    if (value === null) return null;
    while (true) {
      this.skipWhitespace();
      const operator = this.peek();
      if (operator !== '+' && operator !== '-') return value;
      this.index += 1;
      const right = this.parseTerm();
      if (right === null) return null;
      value = operator === '+' ? value + right : value - right;
    }
  }

  private parseTerm(): number | null {
    let value = this.parsePower();
    if (value === null) return null;
    while (true) {
      this.skipWhitespace();
      const operator = this.peek();
      if (operator !== '*' && operator !== '/') return value;
      this.index += 1;
      const right = this.parsePower();
      if (right === null || (operator === '/' && Math.abs(right) < Number.EPSILON)) return null;
      value = operator === '*' ? value * right : value / right;
    }
  }

  private parsePower(): number | null {
    const base = this.parseUnary();
    if (base === null) return null;
    this.skipWhitespace();
    if (this.peek() !== '^') return base;
    this.index += 1;
    const exponent = this.parsePower();
    return exponent === null ? null : base ** exponent;
  }

  private parseUnary(): number | null {
    this.skipWhitespace();
    const operator = this.peek();
    if (operator === '+' || operator === '-') {
      this.index += 1;
      const value = this.parseUnary();
      return value === null ? null : operator === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number | null {
    this.skipWhitespace();
    if (this.peek() === '(') {
      this.index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (value === null || this.peek() !== ')') return null;
      this.index += 1;
      return value;
    }
    if (this.peek() === 'x') {
      this.index += 1;
      return this.currentValue;
    }
    const remainder = this.source.slice(this.index);
    const match = remainder.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?/i);
    if (!match) return null;
    this.index += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) this.index += 1;
  }

  private peek(): string {
    return this.source[this.index] ?? '';
  }
}
