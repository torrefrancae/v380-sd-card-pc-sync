import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function appRoot(): string {
  if (process.env.V380_HOME) return path.resolve(process.env.V380_HOME);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [here, path.resolve(here, "..")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "public", "index.html"))) return dir;
  }
  return path.resolve(here, "..");
}

export function ffmpegBin(): string {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const bundled = path.join(appRoot(), "runtime", name);
  if (fs.existsSync(bundled)) return bundled;
  return "ffmpeg";
}
