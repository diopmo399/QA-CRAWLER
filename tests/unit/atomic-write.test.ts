import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic, type AtomicWriteFs } from '../../src/memory/atomic-write.js';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** Un système de fichiers en mémoire dont le renommage échoue les `failures` premières fois. */
function fakeFs(
  failures: number,
  code = 'EPERM',
): AtomicWriteFs & { files: Map<string, string>; renames: number } {
  const files = new Map<string, string>();
  const fs = {
    files,
    renames: 0,
    writeFile: (file: string, content: string) => {
      files.set(file, content);
      return Promise.resolve();
    },
    rename: (from: string, to: string) => {
      fs.renames += 1;
      if (fs.renames <= failures) return Promise.reject(errno(code));
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      return Promise.resolve();
    },
    rm: (file: string) => {
      files.delete(file);
      return Promise.resolve();
    },
  };
  return fs;
}

describe('writeFileAtomic', () => {
  it('writes through a temporary file, nothing left behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-atomic-'));
    const file = path.join(dir, 'flow-graph.json');
    await writeFileAtomic(file, '{"a":1}');
    await writeFileAtomic(file, '{"a":2}');
    expect(await readFile(file, 'utf8')).toBe('{"a":2}');
    expect(await readdir(dir)).toEqual(['flow-graph.json']);
  });

  it('target held open by another program (Windows EPERM): retries, then succeeds', async () => {
    const fs = fakeFs(2);
    await writeFileAtomic('/r/flow-graph.json', 'v2', fs);
    expect(fs.renames).toBe(3);
    expect([...fs.files]).toEqual([['/r/flow-graph.json', 'v2']]);
  });

  it('still locked after the retries: writes the target directly instead of failing', async () => {
    const fs = fakeFs(Infinity, 'EBUSY');
    await writeFileAtomic('/r/flow-graph.json', 'v3', fs);
    expect([...fs.files]).toEqual([['/r/flow-graph.json', 'v3']]);
  });

  it('any other error is raised and the temporary file removed', async () => {
    const fs = fakeFs(1, 'ENOSPC');
    await expect(writeFileAtomic('/r/x.json', 'v', fs)).rejects.toThrow('ENOSPC');
    expect(fs.files.size).toBe(0);
  });
});
