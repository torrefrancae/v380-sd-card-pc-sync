import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./app-root.js";

export interface SavedCamera {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

function file(): string {
  return path.join(appRoot(), "runtime", "cameras.json");
}

function readAll(): SavedCamera[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8")) as SavedCamera[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((camera) => Number.isInteger(camera.id) && camera.id > 0 && camera.username && camera.password);
  } catch {
    return [];
  }
}

function writeAll(cameras: SavedCamera[]) {
  const dest = file();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cameras, null, 2), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

export function savedCameras(): Array<Omit<SavedCamera, "password"> & { hasLogin: true }> {
  return readAll().map(({ password: _password, ...camera }) => ({ ...camera, hasLogin: true }));
}

export function savedCamera(id: number): SavedCamera | null {
  return readAll().find((camera) => camera.id === id) ?? null;
}

export function savedIds(): Set<number> {
  return new Set(readAll().map((camera) => camera.id));
}

export function rememberCamera(camera: SavedCamera): SavedCamera {
  const id = Number(camera.id);
  const username = camera.username.trim();
  const host = camera.host.trim();
  const name = camera.name.trim() || `Camera ${id}`;
  const port = Number(camera.port || 8800);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Enter the camera device id");
  if (!host) throw new Error("Enter the camera IP address");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid port");
  const cameras = readAll();
  const existing = cameras.find((item) => item.id === id);
  const password = camera.password || existing?.password || "";
  if (!username || !password) throw new Error("Enter the username and device password");
  const next: SavedCamera = { id, name, host, port, username, password };
  const rest = cameras.filter((item) => item.id !== id);
  writeAll([...rest, next].sort((a, b) => a.name.localeCompare(b.name)));
  return next;
}

export function forgetCamera(id: number) {
  writeAll(readAll().filter((camera) => camera.id !== id));
}
