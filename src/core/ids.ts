import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

/** Returns a stable, lexicographically sortable entity identifier. */
export const createEntityId = (): string => nextUlid();
