import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { ffmpegBin } from "./app-root.js";
import { decryptVideo, login, mediaKey, openCamera, type CameraConfig, type CameraSocket } from "./session.js";

const VIDEO_TYPES = new Set([0, 1, 40, 41, 50, 51, 52, 53]);

let stopCurrent: (() => void) | null = null;

export function stopLive() {
  stopCurrent?.();
  stopCurrent = null;
}

function startCode(data: Buffer): number {
  const long = data.indexOf(Buffer.from([0, 0, 0, 1]));
  const short = data.indexOf(Buffer.from([0, 0, 1]));
  if (long >= 0 && (short < 0 || long <= short)) return long;
  return short;
}

async function openLive(config: CameraConfig): Promise<{ socket: CameraSocket; key: Buffer }> {
  const session = await login(config);
  const socket = await openCamera(config.host, config.port, 8000);
  const request = Buffer.alloc(256);
  request.writeUInt32LE(301, 0);
  request.writeUInt32LE(config.deviceId, 4);
  request.writeUInt16LE(15, 12);
  request.writeUInt32LE(session.ticket, 14);
  request.writeUInt32LE(0x1001, 22);
  await socket.write(request);
  const reply = await socket.read(32);
  const command = reply.readUInt32LE(0);
  const result = reply.readInt32LE(4);
  if (command !== 401 || (result !== 1001 && result !== 402)) {
    socket.close();
    throw new Error(`camera refused the live picture (${command}/${result})`);
  }
  request.writeUInt32LE(303, 0);
  request.writeInt32LE(result, 4);
  void socket.write(request).catch(() => undefined);
  return { socket, key: mediaKey(session.ticket) };
}

async function writeFrames(socket: CameraSocket, key: Buffer, child: ChildProcess, signal: AbortSignal) {
  const stdin = child.stdin;
  if (!stdin) return;
  let assembled = Buffer.alloc(0);
  let pending = -1;
  while (!signal.aborted) {
    const header = await socket.read(12);
    if (header[0] !== 0x7f) continue;
    const total = header.readUInt16LE(3);
    const current = header.readUInt16LE(5);
    const length = header.readUInt16LE(7);
    const type = header[1];
    if (length > 65535) throw new Error("live picture packet was too large");
    const payload = length ? await socket.read(length) : Buffer.alloc(0);
    if (pending !== type) {
      assembled = Buffer.alloc(0);
      pending = type;
    }
    assembled = Buffer.concat([assembled, payload]);
    if (!total || current !== total - 1) continue;
    const frame = assembled;
    assembled = Buffer.alloc(0);
    pending = -1;
    if (!VIDEO_TYPES.has(type) || frame.length <= 12) continue;
    const decoded = decryptVideo(frame.subarray(12), key);
    const at = startCode(decoded);
    if (at < 0) continue;
    if (!stdin.write(decoded.subarray(at))) await new Promise((resolve) => stdin.once("drain", resolve));
  }
}

function publishJpegs(child: ChildProcess, res: ServerResponse) {
  let pending = Buffer.alloc(0);
  child.stdout?.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 4_000_000) pending = pending.subarray(pending.length - 2_000_000);
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        pending = Buffer.alloc(0);
        break;
      }
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        pending = pending.subarray(start);
        break;
      }
      const jpeg = pending.subarray(start, end + 2);
      pending = pending.subarray(end + 2);
      const header = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      if (!res.write(Buffer.concat([header, jpeg, Buffer.from("\r\n")]))) break;
    }
  });
}

/* One live picture at a time. A new request, or Close, stops the previous one. */
export async function streamLive(config: CameraConfig, res: ServerResponse, close: AbortSignal): Promise<void> {
  stopLive();
  const controller = new AbortController();
  const stop = () => controller.abort();
  stopCurrent = stop;
  close.addEventListener("abort", stop);
  const { socket, key } = await openLive(config);
  const child = spawn(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-probesize", "32", "-analyzeduration", "0",
    "-f", "hevc", "-i", "pipe:0",
    "-an", "-vf", "scale=640:-2",
    "-q:v", "7",
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let ffmpegError = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    ffmpegError = (ffmpegError + chunk.toString()).slice(-500);
  });
  child.on("close", (code) => {
    if (code && code !== 255 && ffmpegError) console.error(ffmpegError.trim());
  });
  res.writeHead(200, {
    "content-type": "multipart/x-mixed-replace; boundary=frame",
    "cache-control": "no-store, no-cache",
    connection: "close",
  });
  res.flushHeaders();
  publishJpegs(child, res);
  let stopped = false;
  const halt = () => {
    if (stopped) return;
    stopped = true;
    socket.close();
    child.kill();
    if (!res.writableEnded) res.end();
  };
  if (controller.signal.aborted) {
    halt();
    return;
  }
  controller.signal.addEventListener("abort", halt);
  child.on("close", halt);
  try {
    await writeFrames(socket, key, child, controller.signal);
  } catch {
    /* The camera or the browser closed the picture. */
  } finally {
    halt();
    close.removeEventListener("abort", stop);
    if (stopCurrent === stop) stopCurrent = null;
  }
}
