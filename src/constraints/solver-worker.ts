/// <reference lib="webworker" />
import initSolver, { solve_json, solver_version } from '../../solver/pkg/vector_solver.js';
import type { SerializedSolverInput, SerializedSolverOutput } from './serialization';

type WorkerRequest =
  | { id: number; type: 'solve'; input: SerializedSolverInput }
  | { id: number; type: 'version' };

type WorkerResponse =
  | { id: number; ok: true; result: SerializedSolverOutput | string }
  | { id: number; ok: false; error: string };

const ready = initSolver();

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    await ready;
    if (request.type === 'version') {
      post({ id: request.id, ok: true, result: solver_version() });
      return;
    }
    const result = JSON.parse(solve_json(JSON.stringify(request.input))) as SerializedSolverOutput;
    post({ id: request.id, ok: true, result });
  } catch (error) {
    post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}
