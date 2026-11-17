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

function readStored(): { amount: number | null; unit: KeepUnit; outDir: string } | null {
  try {
    const saved = JSON.parse(fs.readFileSync(keepFile(), "utf8")) as { amount?: number | null; unit?: KeepUnit; outDir?: string };
    if (!saved || !saved.unit || !KEEP_UNITS.includes(saved.unit)) return null;
    if (saved.amount === null) return { amount: null, unit: saved.unit, outDir: saved.outDir ?? "" };
    if (!Number.isInteger(saved.amount) || saved.amount < 1 || !saved.outDir) return null;
    return { amount: saved.amount, unit: saved.unit, outDir: saved.outDir };
  } catch {
    return null;
  }
}

export function readKeep(): Keep | null {
  const saved = readStored();
  if (!saved || saved.amount === null || !saved.outDir) return null;
  return { amount: saved.amount, unit: saved.unit, outDir: saved.outDir };
}

/* A new install keeps 30 days. A saved empty amount stays empty across restarts. */
export function ensureDefaultKeep(outDir: string) {
  if (fs.existsSync(keepFile())) return;
  writeKeep({ amount: 30, unit: "days", outDir: resolveOutDir(outDir) });
}

export function writeKeep(keep: Keep | null) {
  const dest = keepFile();
  const previous = readStored();
  const stored = keep ?? {
    amount: null,
    unit: previous?.unit ?? "days",
    outDir: previous?.outDir ?? "",
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
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

/* Delete the oldest saved videos past the keep limit. limit is how many clips may go. */
export function pruneKept(keep: Keep, now: Date, activeFile = "", limit = 1): string[] {
  const dir = resolveOutDir(keep.outDir);
  if (!fs.existsSync(dir) || limit < 1) return [];
  const cutoff = keepCutoff(now, keep).getTime();
  const active = activeFile.replaceAll("\\", "/");
  const oldest = new Map<string, { when: number; folder: string }>();
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
      if (!key || key === active || oldest.has(key)) continue;
      const when = clipClock(key);
      if (!when || when.getTime() > cutoff) continue;
      oldest.set(key, { when: when.getTime(), folder });
    }
  }
  const chosen = [...oldest.entries()].sort((left, right) => left[1].when - right[1].when).slice(0, limit);
  const deleted: string[] = [];
  for (const [key, item] of chosen) {
    if (!deleteClip(item.folder, key)) continue;
    deleted.push(key);
    try {
      if (fs.readdirSync(item.folder).length === 0) fs.rmdirSync(item.folder);
    } catch {
      /* Leave a folder that is still in use. */
    }
  }
  return deleted;
}

function deleteClip(folder: string, key: string): boolean {
  const name = key.slice(key.indexOf("/") + 1);
  const stem = name.replace(/\.mp4$/, "");
  let removed = false;
  for (const file of [`${stem}.mp4`, `${stem}.h265`, `${stem}.partial.mp4`]) {
    try {
      if (!fs.existsSync(path.join(folder, file))) continue;
      fs.rmSync(path.join(folder, file), { force: true });
      removed = true;
    } catch {
      /* The file can be open while a copy is finishing. */
    }
  }
  return removed;
}
