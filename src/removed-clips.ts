import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./app-root.js";
import { clipClock, keepCutoff, readKeep } from "./keep.js";
import { listClips, resolveClip, resolveOutDir } from "./media.js";

interface RemovedClip {
  outDir: string;
  file: string;
}

function removedFile(): string {
  return path.join(appRoot(), "runtime", "removed.json");
}

function readRecords(): RemovedClip[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(removedFile(), "utf8")) as RemovedClip[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && item.outDir && /^\d{4}-\d{2}-\d{2}\/\d{6}\.mp4$/.test(item.file));
  } catch {
    return [];
  }
}

function writeRecords(records: RemovedClip[]) {
  const dest = removedFile();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

function sameDir(left: string, right: string): boolean {
  return resolveOutDir(left) === resolveOutDir(right);
}

/* Drop a record once the file is back, or once the keep limit includes that clip again. */
export function syncRemoved(outDir: string | undefined, now = new Date()): string[] {
  const dir = resolveOutDir(outDir);
  const records = readRecords();
  const keep = readKeep();
  const limited = Boolean(keep && sameDir(keep.outDir, dir));
  const cutoff = limited && keep ? keepCutoff(now, keep).getTime() : null;
  const next = records.filter((item) => {
    if (!sameDir(item.outDir, dir)) return true;
    const full = resolveClip(dir, item.file);
    if (full && fs.existsSync(full)) return false;
    if (cutoff === null) return false;
    const when = clipClock(item.file);
    return Boolean(when && when.getTime() <= cutoff);
  });
  if (next.length !== records.length) writeRecords(next);
  return next.filter((item) => sameDir(item.outDir, dir)).map((item) => item.file);
}

export function rememberRemoved(outDir: string, files: string[]) {
  const dir = resolveOutDir(outDir);
  const records = readRecords();
  const seen = new Set(records.filter((item) => sameDir(item.outDir, dir)).map((item) => item.file));
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (!/^\d{4}-\d{2}-\d{2}\/\d{6}\.mp4$/.test(normalized) || seen.has(normalized)) continue;
    records.push({ outDir: dir, file: normalized });
    seen.add(normalized);
  }
  writeRecords(records);
}

export function listedClips(outDir: string | undefined, now = new Date()) {
  const removed = new Set(syncRemoved(outDir, now));
  const clips = listClips(outDir).map((clip) => ({ ...clip, removed: false }));
  for (const file of removed) {
    if (clips.some((clip) => clip.file.replaceAll("\\", "/") === file)) continue;
    clips.push({ file, bytes: 0, seconds: 0, removed: true });
  }
  return clips;
}
