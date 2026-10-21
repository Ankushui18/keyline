import type { TextContent } from './types';
import type { ViewportState } from '../canvas/viewport';
import type { ObjectTransform } from './types';
import { palette } from '../design-system/tokens';
import { fillColor } from './fills';
import { layoutText, TEXT_FONT_STACKS, textLines } from './text';
import type { AppearanceFill } from './types';

/**
 * On-canvas text editing (docs/EDITING-AUDIT.md §3.10).
 *
 * The editing surface is a real `<textarea>` overlaid on the object, so caret, selection,
 * clipboard, IME and accessibility come from the browser. Everything this module returns is
 * therefore *placement and policy*, not text mutation — which is exactly the part that can be
 * tested without a browser.
 */

export interface TextEditorPlacement {
  /** CSS `transform`, in screen space: viewport ∘ object transform. */
  transform: string;
  left: number;
  top: number;
  width: number;
  height: number;
  font: string;
  lineHeight: string;
  textAlign: TextContent['align'];
  color: string;
  caretColor: string;
}

/**
 * Where the editing field goes, in screen pixels. The field's own coordinate system is the
 * object's local space (its top-left is the text box origin), so the object transform and the
 * viewport collapse into a single matrix and the browser does the rest.
 */
export function textEditorPlacement(options: {
  viewport: ViewportState;
  transform: ObjectTransform;
  text: TextContent;
  fills: readonly AppearanceFill[];
}): TextEditorPlacement {
  const { viewport, transform, text, fills } = options;
  const layout = layoutText(text);
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  // Object local → document (objectTransformMatrix), then document → screen (viewport).
  const a = cosine * transform.scaleX;
  const b = sine * transform.scaleX;
  const c = -sine * transform.scaleY;
  const d = cosine * transform.scaleY;
  const e = transform.x;
  const f = transform.y;
  const matrix = [
    a * viewport.scale, b * viewport.scale,
    c * viewport.scale, d * viewport.scale,
    e * viewport.scale + viewport.offsetX,
    f * viewport.scale + viewport.offsetY,
  ].map((value) => Number(value.toFixed(4)));
  const visible = fills.find((fill) => fill.visible && fill.opacity > 0);
  const color = visible ? fillColor(visible) : palette.black;
  return {
    transform: `matrix(${matrix.join(', ')})`,
    // The matrix already carries the position; these keep the field's own box anchored.
    left: 0,
    top: 0,
    width: Math.max(1, Number(layout.width.toFixed(3))),
    height: Math.max(1, Number(layout.height.toFixed(3))),
    font: `${text.weight} ${text.size}px ${TEXT_FONT_STACKS[text.family]}`,
    lineHeight: `${Number((text.size * text.lineHeight).toFixed(3))}px`,
    textAlign: text.align,
    color,
    caretColor: color,
  };
}

export type TextEditKeyAction = 'commit' | 'pass';

/**
 * Which keys end the editing session. Enter inserts a line, Tab commits and moves focus on
 * (so the field is not a keyboard trap), Escape commits, and ⌘/Ctrl+Enter commits — the
 * choices written down in §3.10.
 */
export function textEditingKeyAction(input: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): TextEditKeyAction {
  if (input.key === 'Escape') return 'commit';
  if (input.key === 'Tab' && !input.shiftKey) return 'commit';
  if (input.key === 'Enter' && (input.metaKey || input.ctrlKey)) return 'commit';
  return 'pass';
}

/**
 * The content a session commits. Trailing whitespace is kept: text is content, and silently
 * rewriting what someone typed is exactly the class of surprise this project refuses.
 */
export function commitTextDraft(text: TextContent, draft: string): TextContent {
  return draft === text.content ? text : { ...text, content: draft };
}

export function textDraftChanged(text: TextContent, draft: string): boolean {
  return draft !== text.content;
}

/** A short, honest label for the history entry. */
export function textEditingLabel(draft: string): string {
  const first = textLines(draft).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return 'Edit text';
  const clipped = first.length > 24 ? `${first.slice(0, 23)}…` : first;
  return `Edit text: ${clipped}`;
}
