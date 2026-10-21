import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import { DEFAULT_TEXT } from './text';
import { abortTextSession, applyTextDraft, beginTextSession, commitTextSession } from './text-session';
import { prepareTextObject } from '../tools/text-tool';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { DEFAULT_DRAWING_STYLE } from './drawing-style';

function documentWithText(content = 'Hello') {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = prepareTextObject(document, { x: 20, y: 30 }, { text: { ...DEFAULT_TEXT, content } });
  manager.beginTransaction('Add text');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId };
}

describe('a text editing session', () => {
  it('starts from the object’s content and refuses anything that is not text', () => {
    const { manager, objectId } = documentWithText('Start');
    expect(beginTextSession(manager, objectId)).toEqual({ objectId, draft: 'Start' });
    abortTextSession(manager);

    const shapeDocument = VectorDocument.createEmpty();
    const shapeManager = new OperationManager(shapeDocument);
    const shape = preparePrimitiveObject(
      shapeDocument, 'rectangle', { x: 0, y: 0 }, { x: 10, y: 10 }, { style: DEFAULT_DRAWING_STYLE },
    )!;
    shapeManager.beginTransaction('shape');
    shape.operations.forEach((operation) => shapeManager.execute(operation));
    shapeManager.commitTransaction();
    expect(beginTextSession(shapeManager, shape.objectId)).toBeUndefined();
  });

  it('writes each change to the document, so bounds and panels follow while typing', () => {
    const { document, manager, objectId } = documentWithText('a');
    let session = beginTextSession(manager, objectId)!;
    session = applyTextDraft(manager, session, 'ab');
    expect(document.getObject(objectId)?.text?.content).toBe('ab');
    session = applyTextDraft(manager, session, 'ab\ncd');
    expect(document.getObject(objectId)?.text?.content).toBe('ab\ncd');
    commitTextSession(manager, session);
    expect(document.getObject(objectId)?.text?.content).toBe('ab\ncd');
  });

  it('is one undo step for the whole session, not one per keystroke', () => {
    const { document, manager, objectId } = documentWithText('Hello');
    let session = beginTextSession(manager, objectId)!;
    for (const draft of ['Hello ', 'Hello w', 'Hello wo', 'Hello world']) session = applyTextDraft(manager, session, draft);
    commitTextSession(manager, session);
    expect(document.getObject(objectId)?.text?.content).toBe('Hello world');
    manager.undo();
    expect(document.getObject(objectId)?.text?.content).toBe('Hello');
    manager.redo();
    expect(document.getObject(objectId)?.text?.content).toBe('Hello world');
  });

  it('reports an unchanged session honestly, and still closes cleanly', () => {
    const { manager, objectId } = documentWithText('Same');
    const session = beginTextSession(manager, objectId)!;
    const result = commitTextSession(manager, applyTextDraft(manager, session, 'Same'));
    expect(result.changed).toBe(false);
    expect(result.text?.content).toBe('Same');
    expect(result.label).toBe('Edit text: Same');
  });

  it('labels the history entry with the text', () => {
    const { manager, objectId } = documentWithText('Old');
    let session = beginTextSession(manager, objectId)!;
    session = applyTextDraft(manager, session, 'New label\nsecond line');
    expect(commitTextSession(manager, session).label).toBe('Edit text: New label');
  });

  it('rolls the whole session back when it is aborted', () => {
    const { document, manager, objectId } = documentWithText('Before');
    let session = beginTextSession(manager, objectId)!;
    session = applyTextDraft(manager, session, 'Before and after');
    abortTextSession(manager);
    expect(document.getObject(objectId)?.text?.content).toBe('Before');
    expect(manager.canUndo).toBe(true);
  });

  it('keeps the style while replacing the content', () => {
    const { document, manager, objectId } = documentWithText('x');
    const style = document.getObject(objectId)!.text!;
    let session = beginTextSession(manager, objectId)!;
    session = applyTextDraft(manager, session, 'y');
    commitTextSession(manager, session);
    expect(document.getObject(objectId)?.text).toEqual({ ...style, content: 'y' });
  });
});
