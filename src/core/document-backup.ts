import type { DocumentSnapshot } from './types';

/**
 * Restores a `.keyline.json` backup produced by the save-failure recovery action.
 *
 * A backup is a raw `DocumentSnapshot`, not the IndexedDB row, so it carries no
 * file name. The caller supplies one from the downloaded file name. The caller
 * must also assign a fresh document ID: restoring should never overwrite the
 * file the backup came from.
 */
export interface DocumentBackup {
  snapshot: DocumentSnapshot;
  name: string;
}

const SUPPORTED_VERSIONS = new Set([1, 2, 3, 4, 5, 6]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Snapshot collections are arrays of `[id, entity]` pairs at persistence boundaries. */
function isEntityPairArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length > 0 &&
        isRecord(entry[1]),
    )
  );
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Removes the download suffixes and gives the restored file a distinguishing name. */
export function backupDocumentName(fileName: string): string {
  const base = fileName
    .replace(/\.json$/i, '')
    .replace(/\.keyline$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = base || 'Recovered drawing';
  return /\(restored\)$/i.test(name) ? name : `${name} (restored)`;
}

export function parseDocumentBackup(text: string, fileName = 'backup.keyline.json'): DocumentBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON. Choose a .keyline.json backup.');
  }

  require(isRecord(value), 'That file is not a Keyline backup.');
  require(
    typeof value.version === 'number' && SUPPORTED_VERSIONS.has(value.version),
    'That backup uses an unsupported document version.',
  );
  require(typeof value.id === 'string' && value.id.length > 0, 'That backup is missing its document ID.');

  for (const key of ['networks', 'regions', 'variables', 'pages'] as const) {
    require(Array.isArray(value[key]), `That backup is missing its ${key} list.`);
  }
  for (const key of ['nodes', 'segments', 'paths'] as const) {
    require(isEntityPairArray(value[key]), `That backup has a malformed ${key} list.`);
  }
  for (const key of [
    'constraints',
    'parametricGroups',
    'exportVariables',
    'appearanceRules',
    'geometryComponents',
    'artboards',
    'layers',
    'objects',
    'appearances',
  ] as const) {
    if (value[key] !== undefined) {
      require(isEntityPairArray(value[key]), `That backup has a malformed ${key} list.`);
    }
  }

  return {
    snapshot: value as unknown as DocumentSnapshot,
    name: backupDocumentName(fileName),
  };
}
