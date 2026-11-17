import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ffmpegBin } from "./app-root.js";
import { decryptVideo, login, mediaKey, openCamera, type CameraConfig, type CameraSocket } from "./session.js";

export interface Segment {
  id: number;
  type: number;
  start: number;
  end: number;
}

const VIDEO_TYPES = new Set([0, 1, 40, 41, 50, 51, 52, 53]);

function putClock(buffer: Buffer, offset: number, unixSeconds: number) {
  const clock = new Date(unixSeconds * 1000);
  buffer.writeUInt16LE(clock.getUTCFullYear(), offset);
  buffer[offset + 2] = clock.getUTCMonth() + 1;
  buffer[offset + 3] = clock.getUTCDate();
  buffer[offset + 4] = clock.getUTCHours();
  buffer[offset + 5] = clock.getUTCMinutes();
  buffer[offset + 6] = clock.getUTCSeconds();
}

export async function listRecordings(config: CameraConfig, ticket: number, day: string, signal?: AbortSignal): Promise<Segment[]> {
  const [year, month, date] = day.split("-").map(Number);
  const socket = await openCamera(config.host, config.port, 8000);
  const stop = () => socket.close();
  signal?.addEventListener("abort", stop);
  try {
    const search = Buffer.alloc(128);
    search.writeUInt32LE(361, 0);
    search.writeUInt32LE(config.deviceId, 4);
    search.writeUInt32LE(ticket, 8);
    search.writeUInt16LE(year, 14);
    search.writeUInt16LE(month, 16);
    search.writeUInt16LE(date, 18);
    search.writeUInt16LE(0, 20);
    search.writeUInt16LE(year, 34);
    search.writeUInt16LE(month, 36);
    search.writeUInt16LE(date, 38);
    search.writeUInt16LE(23, 40);
    search.writeUInt16LE(59, 42);
    search.writeUInt16LE(59, 44);
    search.writeUInt32LE(1, 58);
    await socket.write(search);
    const ack = await socket.read(32);
    const ready = ack.readInt32LE(4);
    if (ack.readUInt32LE(0) !== 461) throw new Error(`recording search failed (${ack.readUInt32LE(0)})`);
    if (ready < 0) throw new Error(`recording search failed (${ready})`);
    if (ready !== 1) return [];

    const segments: Segment[] = [];
    for (let page = 0; page < 500; page++) {
      const ask = Buffer.alloc(32);
      ask.writeUInt32LE(362, 0);
      ask.writeUInt32LE(config.deviceId, 4);
      ask.writeUInt32LE(ticket, 8);
      await socket.write(ask);
      const block = await socket.read(512);
      if (block.readUInt32LE(0) !== 462) break;
      const flag = block.readUInt16LE(4);
      const count = Math.min(block.readUInt16LE(6), 38);
      for (let i = 0; i < count; i++) {
        const offset = 8 + i * 13;
        const id = block.readUInt32LE(offset);
        if (id === 0) continue;
        const start = block.readUInt32LE(offset + 5);
        const end = block.readUInt32LE(offset + 9);
        if (end <= start) continue;
        segments.push({ id, type: block[offset + 4], start, end });
      }
      if (flag === 12) break;
    }
    segments.sort((a, b) => a.start - b.start);
    return segments;
  } finally {
    signal?.removeEventListener("abort", stop);
    socket.close();
  }
}

function startCode(data: Buffer): number {
  const window = data.subarray(0, Math.min(16, data.length));
  const long = window.indexOf(Buffer.from([0, 0, 0, 1]));
  const short = window.indexOf(Buffer.from([0, 0, 1]));
  if (long >= 0 && (short < 0 || long <= short)) return long;
  return short;
}

function videoPayload(body: Buffer, key: Buffer): Buffer | null {
  const decoded = startCode(body) >= 0 ? body : decryptVideo(body, key);
  const at = startCode(decoded);
  if (at < 0) return null;
  return at === 0 ? decoded : decoded.subarray(at);
}

function codecOf(frame: Buffer): "hevc" | "h264" {
  let index = 0;
  if (frame[2] === 1) index = 3;
  if (frame[2] === 0 && frame[3] === 1) index = 4;
  const nal = frame[index] & 0x1f;
  return nal === 7 || nal === 8 || nal === 5 || nal === 1 ? "h264" : "hevc";
}

function sendPlayback(socket: CameraSocket, mode: number, segment: Segment, note: number, frameId: number, packet: number) {
  const ack = Buffer.alloc(32);
  ack.writeUInt32LE(364, 0);
  ack[4] = mode;
  ack[5] = note;
  ack.writeUInt16LE(200, 6);
  ack.writeUInt16LE(frameId & 0xffff, 8);
  ack.writeUInt32LE(segment.id, 12);
  if (mode === 1) putClock(ack, 16, segment.start);
  ack.writeUInt16LE(mode === 2 ? packet : 0, 23);
  return socket.write(ack);
}

export async function downloadSegment(config: CameraConfig, ticket: number, segment: Segment, elementary: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<"hevc" | "h264"> {
  const key = mediaKey(ticket);
  const socket = await openCamera(config.host, config.port, 20000);
  const stop = () => socket.close();
  signal?.addEventListener("abort", stop);
  const file = fs.createWriteStream(elementary);
  let codec: "hevc" | "h264" | null = null;
  let written = 0;
  try {
    const request = Buffer.alloc(64);
    request.writeUInt32LE(363, 0);
    request.writeUInt32LE(config.deviceId, 4);
    request.writeUInt32LE(ticket, 8);
    request.writeUInt32LE(segment.id, 12);
    putClock(request, 16, segment.start);
    request[23] = segment.type;
    await socket.write(request);
    const reply = await socket.read(64);
    const result = reply.readInt32LE(4);
    if (reply.readUInt32LE(0) !== 463 || result !== 1000) {
      throw new Error(`camera refused playback (${reply.readUInt32LE(0)}/${result})`);
    }
    await sendPlayback(socket, 1, segment, 0, 0, 0);

    let pending = Buffer.alloc(0);
    let note = 0;
    let lastPacket = 0;
    let lastFrame = 0;
    let sinceAck = 0;
    for (;;) {
      const header = await socket.read(8);
      const type = header[0];
      note = header[1];
      const packet = header.readUInt16LE(2);
      const size = header.readUInt16LE(4);
      const payload = size ? await socket.read(size) : Buffer.alloc(0);
      if (type === 0xef) break;
      if (type === 0x1f) continue;
      if (type === 0x6f) {
        await sendPlayback(socket, 2, segment, note, lastFrame, lastPacket);
        sinceAck = 0;
        continue;
      }
      if (type !== 0x7f) throw new Error(`unexpected playback packet 0x${type.toString(16)}`);
      lastPacket = packet;
      pending = Buffer.concat([pending, payload]);
      sinceAck += 1;
      while (pending.length >= 22) {
        const frameType = pending.readUInt16LE(4);
        const frameSize = pending.readUInt32LE(18);
        if (frameSize > 0x80000) throw new Error(`recorded frame too large (${frameSize})`);
        if (pending.length < 22 + frameSize) break;
        const body = pending.subarray(22, 22 + frameSize);
        lastFrame = pending.readUInt32LE(0);
        pending = pending.subarray(22 + frameSize);
        if (!VIDEO_TYPES.has(frameType)) continue;
        const annex = videoPayload(Buffer.from(body), key);
        if (!annex) continue;
        if (!codec) codec = codecOf(annex);
        if (!file.write(annex)) await new Promise((resolve) => file.once("drain", resolve));
        written += annex.length;
        onBytes(written);
      }
      if (sinceAck >= 200) {
        await sendPlayback(socket, 2, segment, note, lastFrame, lastPacket);
        sinceAck = 0;
      }
    }
  } finally {
    await sendPlayback(socket, 3, segment, 0, 0, 0).catch(() => undefined);
    signal?.removeEventListener("abort", stop);
    socket.close();
    await new Promise((resolve) => file.end(resolve));
  }
  if (!codec || written === 0) throw new Error("camera sent no video for this clip");
  return codec;
}

export function mux(codec: "hevc" | "h264", elementary: string, output: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-fflags", "+genpts", "-f", codec, "-i", elementary,
      "-c", "copy", output,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("stopped"));
      else if (code === 0) resolve();
      else reject(new Error(error.trim() || `ffmpeg exited ${code}`));
    });
  });
}

export async function saveClip(config: CameraConfig, ticket: number, segment: Segment, output: string, onBytes: (n: number) => void, signal?: AbortSignal) {
  const elementary = `${output}.h265`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const codec = await downloadSegment(config, ticket, segment, elementary, onBytes, signal);
  const temp = `${output}.partial.mp4`;
  try {
    await mux(codec, elementary, temp, signal);
    fs.renameSync(temp, output);
  } finally {
    fs.rmSync(elementary, { force: true });
    fs.rmSync(temp, { force: true });
  }
}
