import fs from "node:fs";

const cache = new Map<string, number>();

function secondsAt(buf: Buffer, body: number): number {
  if (body >= buf.length) return 0;
  const version = buf[body];
  if (version === 0 && body + 20 <= buf.length) {
    const scale = buf.readUInt32BE(body + 12);
    const duration = buf.readUInt32BE(body + 16);
    if (scale > 0 && scale < 1_000_000) return duration / scale;
  }
  if (version === 1 && body + 32 <= buf.length) {
    const scale = buf.readUInt32BE(body + 20);
    const duration = Number(buf.readBigUInt64BE(body + 24));
    if (scale > 0 && scale < 1_000_000) return duration / scale;
  }
  return 0;
}

function fromBuffer(buf: Buffer): number {
  let at = 0;
  while (at < buf.length) {
    const found = buf.indexOf("mvhd", at);
    if (found < 0) return 0;
    const seconds = secondsAt(buf, found + 4);
    if (seconds > 0 && seconds < 6 * 60 * 60) return seconds;
    at = found + 4;
  }
  return 0;
}

function readSeconds(file: string, size: number): number {
  const fd = fs.openSync(file, "r");
  try {
    const take = Math.min(size, 1024 * 1024);
    const head = Buffer.alloc(take);
    fs.readSync(fd, head, 0, take, 0);
    const fromHead = fromBuffer(head);
    if (fromHead) return fromHead;
    if (size <= take) return 0;
    const tail = Buffer.alloc(take);
    fs.readSync(fd, tail, 0, take, size - take);
    return fromBuffer(tail);
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

export function mp4Seconds(file: string, size: number, mtimeMs: number): number {
  const key = `${file}\0${size}\0${mtimeMs}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const seconds = size > 4096 ? readSeconds(file, size) : 0;
  cache.set(key, seconds);
  return seconds;
}
