import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appRoot, ffmpegBin } from "./app-root.js";

const WINDOWS_ZIP = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

let pending: Promise<string> | null = null;
let message = "";

export function ffmpegStatus(): { ffmpeg: boolean; ffmpegMessage: string } {
  if (pending) return { ffmpeg: false, ffmpegMessage: message };
  const ready = ffmpegWorks(ffmpegBin());
  if (ready) message = "";
  return { ffmpeg: ready, ffmpegMessage: message };
}

export function ensureFfmpeg(): Promise<string> {
  const current = ffmpegBin();
  if (ffmpegWorks(current)) return Promise.resolve(current);
  pending ??= downloadFfmpeg().finally(() => {
    pending = null;
  });
  return pending;
}

function ffmpegWorks(bin: string): boolean {
  if (process.platform === "win32" && !path.isAbsolute(bin)) return false;
  if (process.platform === "win32" && !fs.existsSync(bin)) return false;
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function downloadFfmpeg(): Promise<string> {
  if (process.platform !== "win32") {
    message = "ffmpeg is not installed.";
    throw new Error(message);
  }
  const runtime = path.join(appRoot(), "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const zip = path.join(runtime, "ffmpeg.zip");
  message = "Downloading ffmpeg. This happens once.";
  const response = await fetch(WINDOWS_ZIP);
  if (!response.ok || !response.body) {
    message = "Could not download ffmpeg.";
    throw new Error(message);
  }
  const file = fs.createWriteStream(zip);
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!file.write(Buffer.from(chunk.value))) {
      await new Promise((resolve) => file.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    file.on("error", reject);
    file.end(() => resolve());
  });
  message = "Unpacking ffmpeg.";
  await run("tar", ["-xf", zip, "-C", runtime]);
  const found = findFile(runtime, "ffmpeg.exe");
  if (!found) {
    message = "The ffmpeg download did not include ffmpeg.exe.";
    throw new Error(message);
  }
  const dest = path.join(runtime, "ffmpeg.exe");
  if (path.resolve(found) !== path.resolve(dest)) fs.copyFileSync(found, dest);
  const license = findFile(runtime, "LICENSE");
  if (license) fs.copyFileSync(license, path.join(runtime, "FFMPEG-LICENSE.txt"));
  fs.rmSync(zip, { force: true });
  for (const name of fs.readdirSync(runtime)) {
    if (name === "ffmpeg.exe" || name === "node.exe" || name === "sql-wasm.wasm" || name === "FFMPEG-LICENSE.txt") continue;
    fs.rmSync(path.join(runtime, name), { recursive: true, force: true });
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (ffmpegWorks(dest)) {
      message = "";
      return dest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  message = "ffmpeg did not start after the download.";
  throw new Error(message);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(error.trim() || `${command} exited ${code}`));
    });
  });
}

function findFile(dir: string, name: string): string | null {
  const wanted = name.toLowerCase();
  const skip = path.resolve(dir, "ffmpeg.exe");
  let found: string | null = null;
  const walk = (current: string) => {
    if (found) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.toLowerCase() !== wanted || path.resolve(full) === skip) continue;
      found = full;
    }
  };
  walk(dir);
  return found;
}
