import { existsSync, writeFileSync } from 'node:fs';
import type { SourceAdapter } from '../../src/core/adapter.ts';
import { fakeAdapter } from './fake-adapter.ts';

/** fakeAdapter whose first parser creation (per AH_TEST_CRASH_MARKER file) crashes the worker thread. */
const crashing: SourceAdapter = {
  ...fakeAdapter,
  createParser(file) {
    const marker = process.env.AH_TEST_CRASH_MARKER;
    if (marker && !existsSync(marker)) {
      writeFileSync(marker, '1');
      setImmediate(() => {
        throw new Error('simulated worker crash');
      });
    }
    return fakeAdapter.createParser(file);
  },
};

export const adapters = [crashing];
