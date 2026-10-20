import { describe, expect, it } from 'vitest';
import { contrastTextColor } from './contrast-color';

describe('collaborator avatar contrast', () => {
  it('uses light text on dark colors', () => {
    expect(contrastTextColor('#000000')).toBe('#ffffff');
    expect(contrastTextColor('#0868b6')).toBe('#ffffff');
  });
  it('uses dark text on bright collaborator colors', () => {
    for (const color of ['#ffffff', '#68a0ff', '#9b7cff', '#56c9a5', '#f0a85b', '#ef7181']) {
      expect(contrastTextColor(color)).toBe('#000000');
    }
  });
  it('handles invalid preferences safely', () => {
    expect(contrastTextColor('invalid')).toBe('#ffffff');
  });
});
