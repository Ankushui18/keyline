/** WCAG contrast for initials on arbitrary collaborator-supplied avatar colors. */
export function contrastTextColor(hex: string): '#ffffff' | '#000000' {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '#ffffff';
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return 1.05 / (luminance + 0.05) >= 4.5 ? '#ffffff' : '#000000';
}
