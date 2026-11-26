import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedMedia } from '../sources/types';

const run = promisify(execFile);
const waiters: Array<() => void> = [];
let active = 0;

export async function captureFirstVisibleFrame(mpv: string, media: ResolvedMedia): Promise<string | null> {
  if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  else active += 1;

  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), 'nebula-cover-'));
    const headers = Object.entries(media.headers).map(([name, value]) => `${name}: ${value}`).join(',');
    await run(mpv, [
      '--no-config', '--load-scripts=no', '--ytdl=no', '--no-resume-playback', '--no-terminal',
      '--no-audio', '--no-sub', '--untimed', '--end=60', '--frames=1',
      '--vf=lavfi=[scale=480:-2,format=yuv420p,blackframe=amount=0:threshold=24,metadata=mode=select:key=lavfi.blackframe.pblack:value=99:function=less]',
      '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=80',
      ...(headers ? [`--http-header-fields=${headers}`] : []), '--', media.url,
    ], { cwd: folder, timeout: 25000, windowsHide: true });
    const frame = await readFile(join(folder, '00000001.jpg'));
    return `data:image/jpeg;base64,${frame.toString('base64')}`;
  } catch {
    return null;
  } finally {
    if (folder) {
      await unlink(join(folder, '00000001.jpg')).catch(() => undefined);
      await rmdir(folder).catch(() => undefined);
    }
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }
}
