import type { OperationManager } from './operations';
import type { EntityId, TextContent } from './types';
import { commitTextDraft, textDraftChanged, textEditingLabel } from './text-edit';

/**
 * A text-editing session (docs/EDITING-AUDIT.md §3.10).
 *
 * One session is one open transaction: every change writes through the existing
 * `UPDATE_OBJECT`, so the document, selection frame, panels and export stay live, and the
 * whole session collapses into a single history entry when it commits.
 *
 * This module is deliberately free of React and DOM state so the transaction semantics —
 * which are the promise made to the user — can be tested directly.
 */

export interface TextSession {
  objectId: EntityId;
  draft: string;
}

/** Opens a session. Returns `undefined` when the object is not text (nothing to edit). */
export function beginTextSession(manager: OperationManager, objectId: EntityId): TextSession | undefined {
  const object = manager.document.getObject(objectId);
  if (!object?.text) return undefined;
  manager.beginTransaction(textEditingLabel(object.text.content));
  return { objectId, draft: object.text.content };
}

/**
 * Records a change. Returns the session to keep, which may be the same object when the draft
 * is what the document already holds — a caret moving is not an edit.
 */
export function applyTextDraft(
  manager: OperationManager,
  session: TextSession,
  content: string,
): TextSession {
  const object = manager.document.getObject(session.objectId);
  if (!object?.text) return session;
  const next = textDraftChanged(object.text, content) ? commitTextDraft(object.text, content) : object.text;
  if (next !== object.text) {
    manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: session.objectId, updates: { text: next } } });
  }
  return { objectId: session.objectId, draft: content };
}

export interface TextCommitResult {
  /** The history label the session wrote, for the receipt. */
  label: string;
  changed: boolean;
  /** The content as stored. */
  text?: TextContent;
}

/** Writes the final value (if any) and commits the transaction. */
export function commitTextSession(manager: OperationManager, session: TextSession): TextCommitResult {
  const object = manager.document.getObject(session.objectId);
  const changed = Boolean(object?.text && textDraftChanged(object.text, session.draft));
  if (object?.text && changed) {
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: session.objectId, updates: { text: commitTextDraft(object.text, session.draft) } },
    });
  }
  manager.commitTransaction();
  return {
    label: textEditingLabel(session.draft),
    changed,
    text: manager.document.getObject(session.objectId)?.text,
  };
}

/** Rolls the session back, used when editing cannot continue (a rejected operation, unmount). */
export function abortTextSession(manager: OperationManager): void {
  manager.rollbackTransaction();
}
