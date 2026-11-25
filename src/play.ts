import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { appRoot, ffmpegBin } from "./app-root.js";
import { pipeFile, resolveClip } from "./media.js";

let active: { id: string; child: ChildProcess; done: boolean } | null = null;

function stopActive() {
  const running = active;
  active = null;
  if (!running || running.done) return;
  running.child.kill("SIGKILL");
}

export function streamPlay(req: IncomingMessage, res: ServerResponse, outDir: string | undefined, file: string, startSeconds = 0) {
  const full = resolveClip(outDir, file);
  if (!full || !fs.existsSync(full) || fs.statSync(full).size <= 4096) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Clip not found" }));
    return;
  }
  const stat = fs.statSync(full);
  const id = createHash("sha256").update(`${full}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 32);
  const dest = path.join(appRoot(), "runtime", "previews", `${id}.mp4`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 4096) {
    pipeFile(req, res, dest);
    return;
  }
  const start = Number.isFinite(startSeconds) && startSeconds > 0.2 ? Math.min(startSeconds, 6 * 60 * 60) : 0;
  stopActive();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part.mp4`;
  const child = spawn(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error",
    ...(start ? ["-ss", start.toFixed(3)] : []),
    "-i", full,
    "-an",
    "-vf", "scale=640:-2",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-g", "12",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const running = { id, child, done: false };
  active = running;
  const hub = new PassThrough();
  const cache = start ? null : fs.createWriteStream(partial);
  child.stdout?.pipe(hub);
  if (cache) hub.pipe(cache);
  res.writeHead(200, {
    "content-type": "video/mp4",
    "cache-control": "no-store",
  });
  hub.pipe(res);
  let error = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    error = (error + chunk.toString()).slice(-400);
  });
  const finish = (code: number | null) => {
    if (running.done) return;
    running.done = true;
    if (active === running) active = null;
    cache?.end(() => {
      if (code === 0 && fs.existsSync(partial) && fs.statSync(partial).size > 4096) fs.renameSync(partial, dest);
      else fs.rmSync(partial, { force: true });
    });
    if (!res.writableEnded) res.end();
    if (code && code !== 0 && code !== 255 && error) console.error(error.trim());
  };
  child.on("error", () => finish(1));
  child.on("close", (code) => finish(code));
  res.on("close", () => {
    if (!running.done) child.kill("SIGKILL");
  });
}
