/**
 * Colour math for the design-system tooling.
 *
 * `deltaE2000` is only used to *report* how far a proposed token substitution
 * would move a colour. The migration itself never accepts a substitution above
 * `MAX_ACCEPTED_DELTA_E`, so a rewritten file always looks the same as before.
 */

export function normalizeHex(raw) {
  let hex = raw.toLowerCase();
  if (hex.length === 4) hex = `#${[...hex.slice(1)].map((c) => c + c).join('')}`;
  if (hex.length === 5) hex = `#${[...hex.slice(1)].map((c) => c + c).join('')}`.slice(0, 7);
  if (hex.length === 9) hex = hex.slice(0, 7);
  return hex;
}

export function isHexColor(raw) {
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw);
}

export function isRgbColor(raw) {
  return /^rgba?\(/i.test(raw);
}

function hexToRgb(hex) {
  const h = normalizeHex(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function rgbToLab([r, g, b]) {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175) / 1;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const toDeg = (rad) => (rad * 180) / Math.PI;
const toRad = (deg) => (deg * Math.PI) / 180;

/** CIEDE2000 difference between two hex colours. < 1 is imperceptible. */
export function deltaE2000(hexA, hexB) {
  const [L1, a1, b1] = rgbToLab(hexToRgb(hexA));
  const [L2, a2, b2] = rgbToLab(hexToRgb(hexB));
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (toDeg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = C2p === 0 ? 0 : (toDeg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRad(dhp) / 2);
  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  }
  const T = 1
    - 0.17 * Math.cos(toRad(hbarp - 30))
    + 0.24 * Math.cos(toRad(2 * hbarp))
    + 0.32 * Math.cos(toRad(3 * hbarp + 6))
    - 0.2 * Math.cos(toRad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(toRad(2 * dTheta)) * RC;
  return Math.sqrt(
    (dLp / SL) ** 2
      + (dCp / SC) ** 2
      + (dHp / SH) ** 2
      + RT * (dCp / SC) * (dHp / SH),
  );
}

/** WCAG relative luminance for a hex colour. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(hexA, hexB) {
  const a = luminance(hexA);
  const b = luminance(hexB);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}
