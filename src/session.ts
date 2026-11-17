import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";

const APP_KEY = Buffer.from("macrovideo+*#!^@");
const MEDIA_A = 0x618123462c14795cn;
const MEDIA_B = 0x82800df0;

export interface CameraConfig {
  host: string;
  port: number;
  deviceId: number;
  username: string;
  password: string;
}

export interface FoundCamera {
  id: number;
  ip: string;
  mac: string;
  port: number;
}

export function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const cut = trimmed.indexOf("=");
    let value = trimmed.slice(cut + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, cut).trim()] = value;
  }
  return out;
}

export function cameraConfig(env: Record<string, string>, hostOverride?: string): CameraConfig {
  const deviceId = Number(env.DEVICE_ID);
  const username = env.DEVICE_USER ?? "";
  const password = env.DEVICE_PASSWORD ?? "";
  const host = hostOverride || env.CAMERA_HOST || "";
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error("Set DEVICE_ID in .env");
  if (!username || !password) throw new Error("Set DEVICE_USER and DEVICE_PASSWORD in .env");
  if (!host) throw new Error("Set CAMERA_HOST in .env or pass --host");
  return { host, port: Number(env.CAMERA_PORT || 8800), deviceId, username, password };
}

export function discover(timeoutMs = 1500): Promise<FoundCamera[]> {
  return new Promise((resolve) => {
    const found = new Map<number, FoundCamera>();
    const socket = dgram.createSocket("udp4");
    const finish = () => {
      socket.close();
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (msg) => {
      const text = msg.toString("utf8");
      if (!text.startsWith("NVDEVRESULT^")) return;
      const parts = text.split("^");
      const mac = parts[2] ?? "";
      const ip = parts[3] ?? "";
      /* NVDEVRESULT, code, mac, ip, mask, gateway, then ports, then the device id. */
      const port = Number(parts[9] ?? 8800);
      const id = Number(parts[12] ?? 0);
      if (ip && id) found.set(id, { id, ip, mac, port });
    });
    socket.bind(10009, () => {
      socket.setBroadcast(true);
      const packet = Buffer.alloc(128);
      Buffer.from("NVDEVSEARCH^100").copy(packet);
      socket.send(packet, 10008, "255.255.255.255");
    });
    setTimeout(finish, timeoutMs);
  });
}

export class CameraSocket {
  private buf = Buffer.alloc(0);
  private wait: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private dead: Error | null = null;

  constructor(private socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("timeout", () => this.fail(new Error("camera timed out")));
    socket.on("close", () => this.fail(new Error("camera closed the connection")));
  }

  private fail(err: Error) {
    if (!this.dead) this.dead = err;
    const pending = this.wait;
    this.wait = null;
    if (pending) pending.reject(this.dead);
  }

  private pump() {
    if (!this.wait || this.buf.length < this.wait.n) return;
    const pending = this.wait;
    this.wait = null;
    const out = this.buf.subarray(0, pending.n);
    this.buf = this.buf.subarray(pending.n);
    pending.resolve(Buffer.from(out));
  }

  read(n: number): Promise<Buffer> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.wait = { n, resolve, reject };
      this.pump();
    });
  }

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    this.buf = Buffer.alloc(0);
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

export function openCamera(host: string, port: number, timeoutMs: number): Promise<CameraSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => fail(new Error(`timed out connecting to ${host}:${port}`)));
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      socket.removeAllListeners("timeout");
      socket.setTimeout(timeoutMs);
      resolve(new CameraSocket(socket));
    });
  });
}

function pkcs7(data: Buffer): Buffer {
  const pad = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function aesEcb(key: Buffer, data: Buffer, decrypt = false): Buffer {
  const cipher = decrypt ? crypto.createDecipheriv("aes-128-ecb", key, null) : crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function passwordEnvelope(password: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomKey = Buffer.alloc(16);
  for (let i = 0; i < randomKey.length; i++) randomKey[i] = alphabet.charCodeAt(crypto.randomInt(alphabet.length));
  const once = aesEcb(APP_KEY, pkcs7(Buffer.from(password, "utf8")));
  const twice = aesEcb(randomKey, pkcs7(once));
  const out = Buffer.alloc(64);
  randomKey.copy(out);
  twice.copy(out, 16);
  return out;
}

export interface Login {
  ticket: number;
  version: number;
}

export async function login(config: CameraConfig): Promise<Login> {
  const packet = Buffer.alloc(520);
  packet.writeUInt32LE(1167, 0);
  packet.writeUInt32LE(120, 4);
  packet[8] = 31;
  packet.writeUInt32LE(10, 9);
  packet.writeUInt32LE(config.deviceId, 13);
  packet.write(new Date().toISOString().slice(0, 19).replace("T", " "), 17, "ascii");
  packet.write(config.username, 49, "utf8");
  passwordEnvelope(config.password).copy(packet, 81);
  const socket = await openCamera(config.host, config.port, 8000);
  try {
    await socket.write(packet);
    const reply = await socket.read(256);
    const command = reply.readUInt32LE(0);
    const result = reply.readInt32LE(4);
    if (command !== 1168) throw new Error(`unexpected login reply ${command}`);
    if (result === 1011) throw new Error("camera rejected the username");
    if (result === 1012) throw new Error("camera rejected the password");
    if (result === 1018) throw new Error("camera rejected the device id");
    if (result !== 1001) throw new Error(`camera login failed (${result})`);
    return { ticket: reply.readUInt32LE(13), version: reply[12] ?? 0 };
  } finally {
    socket.close();
  }
}

export function mediaKey(ticket: number): Buffer {
  const key = Buffer.alloc(16);
  key.writeUInt32LE(ticket, 0);
  key.writeBigUInt64LE(MEDIA_A, 4);
  key.writeUInt32LE(MEDIA_B, 12);
  return key;
}

/* Recorded HEVC on this firmware encrypts the first 64 bytes of every 80. */
export function decryptVideo(data: Buffer, key: Buffer): Buffer {
  const out = Buffer.from(data);
  for (let offset = 0; offset + 64 <= out.length; offset += 80) {
    aesEcb(key, out.subarray(offset, offset + 64), true).copy(out, offset);
  }
  return out;
}
