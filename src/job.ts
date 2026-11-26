import fs from "node:fs";
import path from "node:path";
import { discover, login, type CameraConfig } from "./session.js";
import { listRecordings, saveClip, type Segment } from "./recordings.js";
import { syncRemoved } from "./removed-clips.js";

export type SyncEvent =
  | { type: "log"; message: string }
  | { type: "progress"; file: string; bytes: number; percent: number }
  | { type: "focus"; file: string }
  | { type: "done"; saved: number; skipped: number; stopped: boolean };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function recentDays(count: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let ago = count - 1; ago >= 0; ago--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
    days.push(`${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`);
  }
  return days;
}

/* Clip times are the camera wall clock stored as UTC unix seconds. */
function cameraNow(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()) / 1000);
}

function clipPath(outDir: string, start: number): string {
  const clock = new Date(start * 1000);
  const day = `${clock.getUTCFullYear()}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}`;
  const time = `${pad(clock.getUTCHours())}${pad(clock.getUTCMinutes())}${pad(clock.getUTCSeconds())}`;
  return path.join(outDir, day, `${time}.mp4`);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function openSession(config: CameraConfig): Promise<{ config: CameraConfig; ticket: number }> {
  try {
    const session = await login(config);
    return { config, ticket: session.ticket };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timed out|ECONN|EHOST|ENET|closed/.test(message)) throw error;
    const found = await discover();
    const match = found.find((camera) => camera.id === config.deviceId);
    if (!match) throw error;
    const moved = { ...config, host: match.ip, port: match.port || config.port };
    const session = await login(moved);
    return { config: moved, ticket: session.ticket };
  }
}

export function chooseClip(fresh: Segment[], past: Segment[], now: number, saved: (start: number) => boolean): { segment: Segment; kind: "new" | "old" } | null {
  const ready = (segment: Segment) => segment.end < now - 20 && !saved(segment.start);
  const newest = fresh.filter(ready).sort((a, b) => b.start - a.start)[0];
  if (newest) return { segment: newest, kind: "new" };
  const recent = past.filter(ready).sort((a, b) => b.start - a.start)[0];
  if (recent) return { segment: recent, kind: "old" };
  return null;
}

/* Older days are oldest-first. The cursor starts at the most recent of them and stays there until that day has no finished clip left. */
export function olderDayIndex(count: number, cursor: number, exhausted: boolean): number {
  if (count <= 0) return -1;
  const current = cursor < 0 || cursor >= count ? count - 1 : cursor;
  if (!exhausted) return current;
  return current - 1;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function searchDay(config: CameraConfig, ticket: number, day: string, signal: AbortSignal): Promise<Segment[]> {
  return listRecordings(config, ticket, day, signal);
}

export async function runSync(options: {
  config: CameraConfig;
  days: string[];
  outDir: string;
  limit: number;
  signal: AbortSignal;
}, emit: (event: SyncEvent) => void): Promise<void> {
  let opened = await openSession(options.config);
  emit({ type: "log", message: `camera ${opened.config.host} id ${opened.config.deviceId}` });
  emit({ type: "log", message: "Watching for the most recent finished clip. The next most recent day starts after that day is caught up." });
  const fixed = options.days.length === 1;
  let olderCursor = -1;
  let saved = 0;
  let skipped = 0;
  let rate = 28_000;
  let quiet = false;
  let taken = 0;
  const counted = new Set<number>();
  const hold = new Map<number, number>();
  while (saved < options.limit && !options.signal.aborted) {
    const window = fixed ? options.days : recentDays(options.days.length);
    const newest = window[window.length - 1];
    const older = window.filter((day) => day !== newest);
    olderCursor = olderDayIndex(older.length, olderCursor, false);
    const backlogDay = olderCursor >= 0 ? older[olderCursor] : "";
    emit({ type: "log", message: backlogDay ? `checking ${newest} and ${backlogDay}` : `checking ${newest}` });
    let fresh: Segment[] = [];
    let past: Segment[] = [];
    let olderFailed = false;
    try {
      const results = await Promise.allSettled([
        searchDay(opened.config, opened.ticket, newest, options.signal),
        backlogDay ? searchDay(opened.config, opened.ticket, backlogDay, options.signal) : Promise.resolve([]),
      ]);
      if (results[0].status === "fulfilled") fresh = results[0].value;
      if (results[1].status === "fulfilled") past = results[1].value;
      if (results[0].status === "rejected" && results[1].status === "rejected") {
        throw results[0].reason;
      }
      if (results[0].status === "rejected") emit({ type: "log", message: `new-clip check failed (${messageOf(results[0].reason)})` });
      if (results[1].status === "rejected") {
        olderFailed = true;
        emit({ type: "log", message: `older-clip check failed (${messageOf(results[1].reason)})` });
      }
    } catch (error) {
      if (options.signal.aborted) break;
      emit({ type: "log", message: `reconnecting (${messageOf(error)})` });
      opened = await openSession(opened.config);
      continue;
    }
    const aside = new Set(syncRemoved(options.outDir));
    const onDisk = (start: number) => {
      const output = clipPath(options.outDir, start);
      if (fs.existsSync(output) && fs.statSync(output).size > 4096) return true;
      const label = path.relative(options.outDir, output).split(path.sep).join("/");
      return aside.has(label);
    };
    for (const segment of [...fresh, ...past]) {
      if (!onDisk(segment.start) || counted.has(segment.start)) continue;
      counted.add(segment.start);
      skipped += 1;
    }
    const available = (segment: Segment) => (hold.get(segment.id) ?? 0) <= Date.now();
    const nowSeconds = cameraNow();
    const choice = chooseClip(fresh.filter(available), past.filter(available), nowSeconds, onDisk);
    if (!choice) {
      const deferred = past.some((segment) => segment.end < nowSeconds - 20 && !onDisk(segment.start) && !available(segment));
      const exhausted = Boolean(backlogDay) && !deferred && !olderFailed;
      const next = olderDayIndex(older.length, olderCursor, exhausted);
      olderCursor = next;
      if (exhausted && next >= 0) continue;
      if (!quiet) {
        emit({ type: "focus", file: "" });
        emit({ type: "log", message: "No finished clip is waiting. Checking again shortly." });
      }
      quiet = true;
      await wait(30_000, options.signal);
      continue;
    }
    quiet = false;
    const output = clipPath(options.outDir, choice.segment.start);
    const label = path.relative(options.outDir, output).split(path.sep).join("/");
    const seconds = Math.max(1, choice.segment.end - choice.segment.start);
    emit({ type: "focus", file: label });
    emit({ type: "log", message: `${choice.kind === "new" ? "new" : "older"} ${label}` });
    let attempt = 0;
    for (;;) {
      try {
        let lastNote = 0;
        await saveClip(opened.config, opened.ticket, choice.segment, output, (bytes) => {
          const nowMs = Date.now();
          if (nowMs - lastNote < 1000) return;
          lastNote = nowMs;
          const percent = Math.min(99, Math.round((bytes / (seconds * rate)) * 100));
          emit({ type: "progress", file: label, bytes, percent });
        }, options.signal);
        const size = fs.statSync(output).size;
        rate = Math.max(1000, Math.round(size / seconds));
        emit({ type: "log", message: `saved ${label} (${megabytes(size)})` });
        saved += 1;
        break;
      } catch (error) {
        fs.rmSync(output, { force: true });
        if (options.signal.aborted) {
          emit({ type: "done", saved, skipped, stopped: true });
          return;
        }
        attempt += 1;
        const message = messageOf(error);
        if (attempt >= 2) {
          hold.set(choice.segment.id, Date.now() + 120_000);
          emit({ type: "log", message: `left ${label} for later (${message})` });
          break;
        }
        emit({ type: "log", message: `retry ${label} (${message})` });
        opened = await openSession(opened.config);
      }
    }
    taken += 1;
    if (taken < 2 || options.signal.aborted) continue;
    taken = 0;
    emit({ type: "log", message: "Waiting 30 seconds before the next clips." });
    await wait(30_000, options.signal);
  }
  emit({ type: "done", saved, skipped, stopped: options.signal.aborted });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
