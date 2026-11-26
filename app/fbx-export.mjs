import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { resolveNativeTool } from './native-tools.mjs';

const run = promisify(execFile);
const signature = Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary');

export async function withFbxExport(source, save) {
  const helper = resolveNativeTool('opensix-fbx');
  const folder = await mkdtemp(join(tmpdir(), 'opensix-fbx-'));
  const input = join(folder, 'model.glb');
  const output = join(folder, 'model.fbx');
  try {
    source.verify();
    await pipeline(source.read(), createWriteStream(input, { flags: 'wx' }));
    if ((await stat(input)).size !== source.length) throw new Error('The preview ended before the FBX exporter could read it.');
    source.verify();

    try {
      await run(helper, [input, output], {
        cwd: folder, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('The FBX exporter is missing. Rebuild or reinstall OpenSix.');
      throw new Error('FBX conversion failed. ' + (error.stderr?.trim() || error.message));
    }

    const handle = await open(output, 'r');
    let original;
    try {
      original = await handle.stat();
      const header = Buffer.alloc(signature.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.equals(signature)) throw new Error('The exporter did not produce a binary FBX file.');
    } finally {
      await handle.close();
    }

    return await save({
      name: 'model.fbx', length: original.size, sources: [...source.sources, output],
      verify: async () => {
        const current = await stat(output);
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ino !== original.ino) {
          throw new Error('The FBX changed during export.');
        }
      },
      read: () => createReadStream(output),
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
