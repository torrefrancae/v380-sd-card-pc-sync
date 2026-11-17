import fs from "node:fs";
import path from "node:path";
import { discover, login, type CameraConfig } from "./session.js";
import { listRecordings, saveClip } from "./recordings.js";

export type SyncEvent =
  | { type: "log"; message: string }
  | { type: "progress"; file: string; bytes: number }
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

export async function runSync(options: {
  config: CameraConfig;
  days: string[];
  outDir: string;
  limit: number;
  signal: AbortSignal;
}, emit: (event: SyncEvent) => void): Promise<void> {
  const opened = await openSession(options.config);
  emit({ type: "log", message: `camera ${opened.config.host} id ${opened.config.deviceId}` });
  const now = cameraNow();
  let saved = 0;
  let skipped = 0;
  for (const day of options.days) {
    if (options.signal.aborted) {
      emit({ type: "done", saved, skipped, stopped: true });
      return;
    }
    const segments = await listRecordings(opened.config, opened.ticket, day);
    const ready = segments.filter((segment) => segment.end < now - 20);
    emit({ type: "log", message: `${day}  ${ready.length} clips` });
    for (const segment of ready) {
      if (saved >= options.limit || options.signal.aborted) {
        emit({ type: "done", saved, skipped, stopped: options.signal.aborted });
        return;
      }
      const output = clipPath(options.outDir, segment.start);
      const label = path.relative(options.outDir, output);
      if (fs.existsSync(output) && fs.statSync(output).size > 4096) {
        skipped += 1;
        continue;
      }
      emit({ type: "log", message: `saving ${label}` });
      let attempt = 0;
      for (;;) {
        try {
          let lastNote = 0;
          await saveClip(opened.config, opened.ticket, segment, output, (bytes) => {
            const nowMs = Date.now();
            if (nowMs - lastNote < 10000) return;
            lastNote = nowMs;
            emit({ type: "progress", file: label, bytes });
          }, options.signal);
          emit({ type: "log", message: `saved ${label} (${megabytes(fs.statSync(output).size)})` });
          saved += 1;
          break;
        } catch (error) {
          fs.rmSync(output, { force: true });
          if (options.signal.aborted) {
            emit({ type: "done", saved, skipped, stopped: true });
            return;
          }
          attempt += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 2) throw error;
          emit({ type: "log", message: `retry ${label} (${message})` });
        }
      }
    }
  }
  emit({ type: "done", saved, skipped, stopped: false });
}
