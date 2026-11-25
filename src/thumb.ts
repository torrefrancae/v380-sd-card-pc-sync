import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appRoot, ffmpegBin } from "./app-root.js";
import { resolveClip } from "./media.js";

const jobs = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let running = 0;

function slot<T>(work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      running += 1;
      work().then(resolve, reject).finally(() => {
        running -= 1;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (running < 2) start();
    else waiting.push(start);
  });
}

function grab(source: string, dest: string, seek: boolean): Promise<void> {
  const partial = `${dest}.tmp.jpg`;
  return new Promise((resolve, reject) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (seek) args.push("-ss", "1");
    args.push(
      "-i", source,
      "-frames:v", "1",
      "-vf", "crop=iw:trunc(ih/3/2)*2:0:0,scale=320:-2",
      "-q:v", "5",
      "-update", "1",
      partial,
    );
    const child = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-400);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        fs.rmSync(partial, { force: true });
        reject(new Error(error.trim() || `ffmpeg exited ${code}`));
        return;
      }
      fs.renameSync(partial, dest);
      resolve();
    });
  });
}

async function writeThumb(source: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await grab(source, dest, true);
  } catch {
    await grab(source, dest, false);
  }
}

export function ensureThumb(outDir: string | undefined, file: string): Promise<string | null> {
  const full = resolveClip(outDir, file);
  if (!full || !fs.existsSync(full) || fs.statSync(full).size <= 4096) return Promise.resolve(null);
  const stat = fs.statSync(full);
  const id = createHash("sha256").update(`${full}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 32);
  const dest = path.join(appRoot(), "runtime", "thumbs", `${id}.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 200) return Promise.resolve(dest);
  const existing = jobs.get(id);
  if (existing) return existing;
  const job = slot(() => writeThumb(full, dest))
    .then(() => (fs.existsSync(dest) && fs.statSync(dest).size > 200 ? dest : null))
    .catch(() => null)
    .finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}
