import { useEffect, useRef } from 'react';
import type { TextEditorPlacement } from '../core/text-edit';
import { textEditingKeyAction } from '../core/text-edit';

/**
 * The on-canvas text field (docs/EDITING-AUDIT.md §3.10): a real `<textarea>` placed over the
 * object by `textEditorPlacement`. Caret, selection, clipboard, IME and screen-reader access
 * are the browser's, not re-implementations of ours.
 */
export function TextEditor({
  placement,
  label,
  content,
  onChange,
  onCommit,
}: {
  placement: TextEditorPlacement;
  /** The object's name, so the field is identifiable to assistive tech. */
  label: string;
  content: string;
  onChange: (content: string) => void;
  onCommit: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    // Caret at the end, which is where someone who just created or double-clicked expects it.
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const commitOnce = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit();
  };

  return (
    <textarea
      ref={field}
      className="canvas-text-editor"
      aria-label={`Edit text: ${label}`}
      spellCheck={false}
      autoComplete="off"
      wrap="off"
      value={content}
      style={{
        position: 'absolute',
        transform: placement.transform,
        transformOrigin: '0 0',
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        font: placement.font,
        lineHeight: placement.lineHeight,
        textAlign: placement.textAlign,
        color: placement.color,
        caretColor: placement.caretColor,
        margin: 0,
        padding: 0,
        border: 0,
        outline: 0,
        background: 'transparent',
        overflow: 'hidden',
        resize: 'none',
        whiteSpace: 'pre',
      }}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (textEditingKeyAction(event) !== 'commit') return;
        // Escape and ⌘/Ctrl+Enter belong to the field. Tab is deliberately left alone: it
        // commits, then the browser moves focus on, so the field is not a keyboard trap.
        if (event.key !== 'Tab') event.preventDefault();
        commitOnce();
      }}
      onBlur={commitOnce}
    />
  );
}
