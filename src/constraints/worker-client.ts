import type { VectorDocument } from '../core/document';
import type { ConstraintSolveResult, EntityId } from '../core/types';
import {
  deserializeSolverOutput,
  serializeSolverInput,
  type SerializedSolverOutput,
} from './serialization';

type WorkerResponse =
  | { id: number; ok: true; result: SerializedSolverOutput | string }
  | { id: number; ok: false; error: string };

export class WasmConstraintWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: SerializedSolverOutput | string) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    this.worker = new Worker(new URL('./solver-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Constraint worker failed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  async solve(document: VectorDocument, pinnedNodeIds: Iterable<EntityId> = []): Promise<ConstraintSolveResult> {
    const result = await this.request('solve', serializeSolverInput(document, pinnedNodeIds));
    if (typeof result === 'string') throw new Error('Unexpected solver version response.');
    return deserializeSolverOutput(result, document);
  }

  async version(): Promise<string> {
    const result = await this.request('version');
    if (typeof result !== 'string') throw new Error('Unexpected solver response.');
    return result;
  }

  terminate(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error('Constraint worker terminated.'));
    this.pending.clear();
  }

  private request(
    type: 'solve' | 'version',
    input?: ReturnType<typeof serializeSolverInput>,
  ): Promise<SerializedSolverOutput | string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (type === 'solve') this.worker.postMessage({ id, type, input });
      else this.worker.postMessage({ id, type });
    });
  }
}
