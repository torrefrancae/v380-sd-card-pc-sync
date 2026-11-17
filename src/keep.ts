import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./app-root.js";
import { resolveOutDir } from "./media.js";

export const KEEP_UNITS = ["minutes", "hours", "days", "weeks", "months"] as const;
export type KeepUnit = (typeof KEEP_UNITS)[number];

export interface Keep {
  amount: number;
  unit: KeepUnit;
  outDir: string;
}

const CLIP = /^(\d{4})-(\d{2})-(\d{2})\/(\d{2})(\d{2})(\d{2})\.mp4$/;

function keepFile(): string {
  return path.join(appRoot(), "runtime", "keep.json");
}

export function readKeep(): Keep | null {
  try {
    const saved = JSON.parse(fs.readFileSync(keepFile(), "utf8")) as Keep;
    if (!saved || !Number.isInteger(saved.amount) || saved.amount < 1) return null;
    if (!KEEP_UNITS.includes(saved.unit) || !saved.outDir) return null;
    return saved;
  } catch {
    return null;
  }
}

export function writeKeep(keep: Keep | null) {
  const dest = keepFile();
  if (!keep) {
    fs.rmSync(dest, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(keep), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

/* Blank means keep every local video. A number deletes older saved files on this PC. */
export function parseKeep(amount: unknown, unit: unknown, outDir: string): Keep | null {
  if (amount === "" || amount === null || amount === undefined) return null;
  const count = Number(amount);
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) {
    throw new Error("Enter how many minutes, hours, days, weeks, or months to keep");
  }
  if (typeof unit !== "string" || !KEEP_UNITS.includes(unit as KeepUnit)) {
    throw new Error("Choose minutes, hours, days, weeks, or months");
  }
  return { amount: count, unit: unit as KeepUnit, outDir: resolveOutDir(outDir) };
}

export function keepCutoff(now: Date, keep: Keep): Date {
  const cut = new Date(now.getTime());
  if (keep.unit === "minutes") cut.setMinutes(cut.getMinutes() - keep.amount);
  else if (keep.unit === "hours") cut.setHours(cut.getHours() - keep.amount);
  else if (keep.unit === "days") cut.setDate(cut.getDate() - keep.amount);
  else if (keep.unit === "weeks") cut.setDate(cut.getDate() - keep.amount * 7);
  else cut.setMonth(cut.getMonth() - keep.amount);
  return cut;
}

/* File names are the camera clock, the same clock shown in the file list. */
export function clipClock(file: string): Date | null {
  const match = CLIP.exec(file.replaceAll("\\", "/"));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const when = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  if (when.getFullYear() !== parts[0] || when.getMonth() !== parts[1] - 1 || when.getDate() !== parts[2]) return null;
  if (when.getHours() !== parts[3] || when.getMinutes() !== parts[4] || when.getSeconds() !== parts[5]) return null;
  return when;
}

function clipKey(day: string, name: string): string | null {
  const base = name.replace(/\.h265$/, "").replace(/\.partial\.mp4$/, "");
  if (!/^\d{6}\.mp4$/.test(base)) return null;
  return `${day}/${base}`;
}

export function pruneKept(keep: Keep, now: Date, activeFile = ""): string[] {
  const dir = resolveOutDir(keep.outDir);
  if (!fs.existsSync(dir)) return [];
  const cutoff = keepCutoff(now, keep).getTime();
  const active = activeFile.replaceAll("\\", "/");
  const deleted: string[] = [];
  for (const day of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const folder = path.join(dir, day);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(folder)) {
      const key = clipKey(day, name);
      if (!key) continue;
      const when = clipClock(key);
      if (!when || when.getTime() > cutoff) continue;
      if (key === active) continue;
      const full = path.join(folder, name);
      try {
        fs.rmSync(full, { force: true });
        deleted.push(key);
      } catch {
        /* The file can be open while a copy is finishing. */
      }
    }
    try {
      if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
    } catch {
      /* Leave a folder that is still in use. */
    }
  }
  return [...new Set(deleted)];
}
