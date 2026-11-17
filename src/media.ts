import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { appRoot, ffmpegBin } from "./app-root.js";

const CLIP = /^\d{4}-\d{2}-\d{2}\/\d{6}\.mp4$/;
const jobs = new Map<string, Promise<void>>();
const previewErrors = new Map<string, string>();

export interface SavedClip {
  file: string;
  bytes: number;
}

export function resolveOutDir(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return path.resolve(trimmed || path.join(appRoot(), "recordings"));
}

export function dayFolder(outDir: string | undefined, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a day folder");
  const dir = resolveOutDir(outDir);
  const folder = path.resolve(dir, day);
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!folder.startsWith(root)) throw new Error("Choose a day folder");
  return folder;
}

export function resolveClip(outDir: string | undefined, file: string): string | null {
  const normalized = file.replaceAll("\\", "/");
  if (!CLIP.test(normalized)) return null;
  const dir = resolveOutDir(outDir);
  const full = path.resolve(dir, normalized);
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!full.startsWith(root)) return null;
  return full;
}

export function listClips(outDir: string | undefined): SavedClip[] {
  const dir = resolveOutDir(outDir);
  if (!fs.existsSync(dir)) return [];
  const clips: SavedClip[] = [];
  for (const date of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const folder = path.join(dir, date);
    if (!fs.statSync(folder).isDirectory()) continue;
    for (const name of fs.readdirSync(folder)) {
      if (!/^\d{6}\.mp4$/.test(name)) continue;
      const full = path.join(folder, name);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size <= 4096) continue;
      clips.push({ file: `${date}/${name}`, bytes: stat.size });
    }
  }
  clips.sort((a, b) => a.file.localeCompare(b.file));
  return clips;
}

export async function clipInfo(outDir: string | undefined, file: string): Promise<{ exists: boolean; codec: string; media: string; message: string }> {
  const full = resolveClip(outDir, file);
  const media = mediaUrl(outDir, file);
  if (!full || !fs.existsSync(full) || fs.statSync(full).size <= 4096) {
    return { exists: false, codec: "", media, message: "That clip is not ready yet." };
  }
  return { exists: true, codec: await codecName(full), media, message: "" };
}

export async function previewStatus(outDir: string | undefined, file: string): Promise<{ ready: boolean; url: string; message: string }> {
  const full = resolveClip(outDir, file);
  if (!full || !fs.existsSync(full) || fs.statSync(full).size <= 4096) {
    return { ready: false, url: "", message: "That clip is not ready yet." };
  }
  const stat = fs.statSync(full);
  const id = createHash("sha256").update(`${full}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 32);
  const dest = path.join(appRoot(), "runtime", "previews", `${id}.mp4`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 4096) {
    return { ready: true, url: `/preview/${id}.mp4`, message: "" };
  }
  const failed = previewErrors.get(id);
  if (failed) return { ready: false, url: "", message: failed };
  if (!jobs.has(id)) {
    const job = transcode(full, dest)
      .catch((error: unknown) => {
        previewErrors.set(id, error instanceof Error ? error.message : "Could not prepare the clip.");
      })
      .finally(() => jobs.delete(id));
    jobs.set(id, job);
  }
  await Promise.race([jobs.get(id), new Promise((resolve) => setTimeout(resolve, 400))]);
  const message = previewErrors.get(id);
  if (message) return { ready: false, url: "", message };
  if (fs.existsSync(dest) && fs.statSync(dest).size > 4096) {
    return { ready: true, url: `/preview/${id}.mp4`, message: "" };
  }
  return { ready: false, url: "", message: "Preparing a copy this browser can play." };
}

export function previewFile(id: string): string | null {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const full = path.join(appRoot(), "runtime", "previews", `${id}.mp4`);
  if (!fs.existsSync(full)) return null;
  return full;
}

export function pipeFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": stat.size,
      "accept-ranges": "bytes",
      "cache-control": "private",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= stat.size || end < start) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    "content-type": "video/mp4",
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes",
    "cache-control": "private",
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function mediaUrl(outDir: string | undefined, file: string): string {
  return `/media?${new URLSearchParams({ file: file.replaceAll("\\", "/"), outDir: outDir ?? "" })}`;
}

function codecName(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-i", file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let text = "";
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.on("error", () => resolve(""));
    child.on("close", () => {
      const found = /Video:\s+([a-z0-9]+)/i.exec(text);
      resolve(found?.[1]?.toLowerCase() ?? "");
    });
  });
}

function transcode(source: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial.mp4`;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", source,
      "-an",
      "-vf", "scale=960:-2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      partial,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
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
