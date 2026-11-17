import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { appRoot } from "./app-root.js";
import { ensureFfmpeg, ffmpegStatus } from "./ffmpeg-setup.js";
import { recentDays, runSync, type SyncEvent } from "./job.js";
import { discover, login, type CameraConfig } from "./session.js";
import { deviceFromV380, readV380Devices } from "./v380-store.js";

const root = appRoot();
const page = fs.readFileSync(path.join(root, "public", "index.html"));

interface StartBody {
  host?: string;
  port?: number;
  deviceId?: number;
  username?: string;
  password?: string;
  days?: number;
  date?: string;
  outDir?: string;
  limit?: number;
  fromApp?: boolean;
}

const listeners = new Set<http.ServerResponse>();
let active: AbortController | null = null;

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

function emit(event: SyncEvent | { type: "error"; message: string } | { type: "idle" }) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const listener of listeners) listener.write(line);
}

async function readJson(req: http.IncomingMessage): Promise<StartBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 100_000) throw new Error("request is too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as StartBody;
}

async function cameraFrom(body: StartBody): Promise<CameraConfig> {
  const deviceId = Number(body.deviceId);
  let host = (body.host ?? "").trim();
  let username = (body.username ?? "").trim();
  let password = body.password ?? "";
  let port = Number(body.port || 8800);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error("Enter the camera device id");
  if (!username || !password || !host) {
    const saved = await deviceFromV380(deviceId);
    if (saved) {
      host = host || saved.host;
      username = username || saved.username;
      password = password || saved.password;
      if (!body.port) port = saved.port;
    }
  }
  if (!host) throw new Error("Enter the camera IP address");
  if (!username || !password) throw new Error("Install V380, sign in, and scan again, or type the device login");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid port");
  return { host, port, deviceId, username, password };
}

async function startSync(body: StartBody) {
  if (active) throw new Error("A download is already running");
  await ensureFfmpeg();
  const config = await cameraFrom(body);
  const date = (body.date ?? "").trim();
  const days = date ? [date] : recentDays(Math.max(1, Math.min(60, Number(body.days || 1))));
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use a date like 2026-11-17");
  const outDir = path.resolve(body.outDir?.trim() || path.join(root, "recordings"));
  const limit = body.limit ? Number(body.limit) : Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  active = controller;
  emit({ type: "log", message: "Starting download" });
  void runSync({ config, days, outDir, limit, signal: controller.signal }, emit)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message });
    })
    .finally(() => {
      active = null;
      emit({ type: "idle" });
    });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      send(res, 200, { ...ffmpegStatus(), running: active !== null });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/discover") {
      const cameras = await discover(2000);
      send(res, 200, { cameras });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v380") {
      const saved = await readV380Devices();
      const live = await discover(2000);
      send(res, 200, {
        cameras: saved.map((device) => {
          const match = live.find((camera) => camera.id === device.id);
          return {
            id: device.id,
            name: device.name,
            host: match?.ip || device.host,
            port: match?.port || device.port,
            username: device.username,
            hasLogin: Boolean(device.username && device.password),
            onNetwork: Boolean(match),
          };
        }),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const session = await login(await cameraFrom(await readJson(req)));
      send(res, 200, { ok: true, version: session.version });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sync") {
      await startSync(await readJson(req));
      send(res, 202, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      active?.abort();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("data: {\"type\":\"hello\"}\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) send(res, 400, { error: message });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${port}`;
  console.log(`V380 sync is at ${address}`);
  void ensureFfmpeg().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
  const opener = process.platform === "win32" ? spawn("cmd", ["/c", "start", "", address]) : spawn(process.platform === "darwin" ? "open" : "xdg-open", [address]);
  opener.on("error", () => undefined);
  opener.unref();
});
