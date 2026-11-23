import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function readAvailableRanges(path, size) {
  if (!size) return [];
  if (process.platform !== 'win32' || !process.env.SystemRoot) return [[0,size]];
  const fsutil = join(process.env.SystemRoot,'System32','fsutil.exe');
  let output;
  try {
    output = execFileSync(fsutil, ['file','queryallocranges','offset=0','length='+size,path], {
      encoding:'utf8', windowsHide:true, timeout:5000,
      stdio:['ignore','pipe','ignore'],
    });
  } catch {
    return [[0,size]];
  }
  const ranges = [];
  for (const line of output.split(/\r?\n/)) {
    const offsets = line.match(/0x[0-9a-f]+/gi);
    if (offsets?.length !== 2) continue;
    const [start,length] = offsets.map(n=>Number.parseInt(n,16));
    const end = Math.min(size,start+length);
    if (end<=start) continue;
    const previous = ranges.at(-1);
    if (previous && start<=previous[1]) previous[1]=Math.max(previous[1],end);
    else ranges.push([start,end]);
  }
  return ranges;
}

export function hasByteRange(ranges, start, length) {
  return length === 0 || ranges.some(([first,last])=>first<=start&&start+length<=last);
}
