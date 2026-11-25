import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { appRoot } from "./app-root.js";
import { ensureFfmpeg, ffmpegStatus } from "./ffmpeg-setup.js";
import { recentDays, runSync, type SyncEvent } from "./job.js";
import { discover, login, type CameraConfig } from "./session.js";
import { cancelPreview, clipInfo, dayFolder, pipeFile, previewFile, previewStatus, resolveClip } from "./media.js";
import { msUntilThreeAm, readDuty, writeDuty } from "./duty.js";
import { ensureDefaultKeep, parseKeep, pruneKept, readKeep, writeKeep } from "./keep.js";
import { listedClips, rememberRemoved, syncRemoved } from "./removed-clips.js";
import { stopLive, streamLive } from "./live.js";
import { ensureThumb } from "./thumb.js";
import { streamPlay } from "./play.js";
import { forgetCamera, rememberCamera, savedCamera, savedCameras, savedIds } from "./saved-cameras.js";
import { deviceFromV380, readV380Devices } from "./v380-store.js";

const root = appRoot();

interface StartBody {
  host?: string;
  port?: number;
  deviceId?: number;
  username?: string;
  password?: string;
  name?: string;
  days?: number;
  date?: string;
  outDir?: string;
  limit?: number;
  fromApp?: boolean;
  keepAmount?: number | string;
  keepUnit?: string;
}

const listeners = new Set<http.ServerResponse>();
let active: AbortController | null = null;
let activeFile = "";
let activeBytes = 0;
let activePercent = 0;
let restarting = false;
let paused = false;
let resumeSoon = false;

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

function emit(event: SyncEvent | { type: "error"; message: string } | { type: "idle" } | { type: "paused" }) {
  if (event.type === "focus") {
    activeFile = event.file;
    activeBytes = 0;
    activePercent = 0;
  }
  if (event.type === "progress") {
    activeFile = event.file;
    activeBytes = event.bytes;
    activePercent = event.percent;
  }
  if (event.type === "done" || event.type === "error" || event.type === "idle") {
    activeFile = "";
    activeBytes = 0;
    activePercent = 0;
  }
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const listener of listeners) {
    if (listener.destroyed || listener.writableEnded) {
      listeners.delete(listener);
      continue;
    }
    try {
      listener.write(line);
    } catch {
      listeners.delete(listener);
    }
  }
  if (event.type === "log" && event.message.startsWith("saved ")) {
    const found = event.message.match(/(\d{4}-\d{2}-\d{2}[/\\]\d{6}\.mp4)/);
    if (found) releaseOne(found[1].replaceAll("\\", "/"));
  }
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
  const kept = savedCamera(deviceId);
  if (kept) {
    host = host || kept.host;
    username = username || kept.username;
    password = password || kept.password;
    if (!body.port) port = kept.port;
  }
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
  if (!username || !password) throw new Error("Enter the username and device password");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid port");
  return { host, port, deviceId, username, password };
}

async function startSync(body: StartBody) {
  if (active) throw new Error("A download is already running");
  const config = await cameraFrom(body);
  rememberCamera({
    id: config.deviceId,
    name: body.name?.trim() || savedCamera(config.deviceId)?.name || `Camera ${config.deviceId}`,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  });
  await ensureFfmpeg();
  const date = (body.date ?? "").trim();
  const days = date ? [date] : recentDays(Math.max(1, Math.min(60, Number(body.days || 7))));
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use a date like 2026-11-17");
  const outDir = path.resolve(body.outDir?.trim() || path.join(root, "recordings"));
  const limit = body.limit ? Number(body.limit) : Number.POSITIVE_INFINITY;
  const dayCount = Math.max(1, Math.min(60, Number(body.days || 7)));
  paused = false;
  writeDuty({
    name: body.name?.trim() || savedCamera(config.deviceId)?.name || `Camera ${config.deviceId}`,
    host: config.host,
    port: config.port,
    deviceId: config.deviceId,
    username: config.username,
    password: config.password,
    days: date ? 1 : dayCount,
    date,
    outDir,
    paused: false,
  });
  rememberKeep(body, outDir);
  const controller = new AbortController();
  active = controller;
  emit({ type: "log", message: "Starting download. Closing the page leaves this running." });
  void runSync({ config, days, outDir, limit, signal: controller.signal }, emit)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message });
    })
    .finally(() => {
      active = null;
      emit({ type: "idle" });
      if (restarting) return;
      if (resumeSoon) {
        resumeSoon = false;
        void resumeDuty();
        return;
      }
      if (paused || readDuty()?.paused) return;
      if (readDuty()) setTimeout(() => { void resumeDuty(); }, 5000);
    });
}

function rememberKeep(body: StartBody, outDir: string) {
  if (body.keepAmount === undefined && body.keepUnit === undefined) return;
  writeKeep(parseKeep(body.keepAmount, body.keepUnit, outDir));
  sweepOldVideos();
}

function sweepOldVideos(): string[] {
  const keep = readKeep();
  syncRemoved(keep ? keep.outDir : path.join(root, "recordings"));
  return [];
}

/* One saved video may remove one older video. Nothing is deleted when nothing new was saved. */
function releaseOne(savedFile: string): string[] {
  const keep = readKeep();
  if (!keep) return [];
  const deleted = pruneKept(keep, new Date(), savedFile, 1);
  if (!deleted.length) return [];
  rememberRemoved(keep.outDir, deleted);
  emit({ type: "log", message: `Removed 1 local video older than ${keep.amount} ${keep.unit}.` });
  return deleted;
}

function holdDuty(on: boolean) {
  paused = on;
  const duty = readDuty();
  if (!duty) return;
  writeDuty({ ...duty, paused: on });
}

function resumeDuty() {
  const duty = readDuty();
  if (!duty || duty.paused || paused || active) return;
  void startSync({
    name: duty.name,
    host: duty.host,
    port: duty.port,
    deviceId: duty.deviceId,
    username: duty.username,
    password: duty.password,
    days: duty.days,
    date: duty.date,
    outDir: duty.outDir,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/watch")) {
      const file = url.pathname === "/watch" ? "watch.html" : "index.html";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(root, "public", file)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reveal") {
      const body = await readJson(req);
      const folder = dayFolder(body.outDir, (body.date ?? "").trim());
      fs.mkdirSync(folder, { recursive: true });
      const opener = process.platform === "win32"
        ? spawn("explorer.exe", [folder])
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [folder]);
      opener.on("error", () => undefined);
      opener.unref();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/keep") {
      const keep = readKeep();
      send(res, 200, { amount: keep?.amount ?? null, unit: keep?.unit ?? "days", outDir: keep?.outDir ?? "" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/keep") {
      const body = await readJson(req);
      const outDir = body.outDir?.trim() || readKeep()?.outDir || path.join(root, "recordings");
      writeKeep(parseKeep(body.keepAmount, body.keepUnit, outDir));
      const deleted = sweepOldVideos();
      const keep = readKeep();
      send(res, 200, { ok: true, deleted, amount: keep?.amount ?? null, unit: keep?.unit ?? null });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/clips") {
      send(res, 200, { clips: listedClips(url.searchParams.get("outDir") ?? undefined) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/play") {
      await ensureFfmpeg();
      const start = Number(url.searchParams.get("start"));
      streamPlay(req, res, url.searchParams.get("outDir") ?? undefined, url.searchParams.get("file") ?? "", Number.isFinite(start) ? start : 0);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/clip") {
      send(res, 200, await clipInfo(url.searchParams.get("outDir") ?? undefined, url.searchParams.get("file") ?? ""));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/preview/cancel") {
      cancelPreview();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/preview") {
      await ensureFfmpeg();
      send(res, 200, await previewStatus(url.searchParams.get("outDir") ?? undefined, url.searchParams.get("file") ?? ""));
      return;
    }
    if (req.method === "GET" && url.pathname === "/media") {
      const clip = resolveClip(url.searchParams.get("outDir") ?? undefined, url.searchParams.get("file") ?? "");
      if (!clip || !fs.existsSync(clip)) {
        send(res, 404, { error: "Clip not found" });
        return;
      }
      pipeFile(req, res, clip);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/preview/")) {
      const id = url.pathname.slice("/preview/".length).replace(/\.mp4$/, "");
      const clip = previewFile(id);
      if (!clip) {
        send(res, 404, { error: "Clip not found" });
        return;
      }
      pipeFile(req, res, clip);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/thumb") {
      await ensureFfmpeg();
      const thumb = await ensureThumb(url.searchParams.get("outDir") ?? undefined, url.searchParams.get("file") ?? "");
      if (!thumb) {
        send(res, 404, { error: "No preview yet" });
        return;
      }
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": fs.statSync(thumb).size,
        "cache-control": "private, max-age=86400",
      });
      fs.createReadStream(thumb).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      send(res, 200, { ...ffmpegStatus(), running: active !== null, paused: paused || Boolean(readDuty()?.paused), activeFile, activeBytes, activePercent });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/saved") {
      send(res, 200, { cameras: savedCameras() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/saved") {
      const body = await readJson(req);
      const config = await cameraFrom(body);
      const camera = rememberCamera({
        id: config.deviceId,
        name: body.name?.trim() || savedCamera(config.deviceId)?.name || `Camera ${config.deviceId}`,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
      });
      send(res, 200, { ok: true, id: camera.id, name: camera.name });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/saved") {
      forgetCamera(Number(url.searchParams.get("id")));
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/discover") {
      const known = savedIds();
      const cameras = (await discover(2000)).filter((camera) => !known.has(camera.id));
      send(res, 200, { cameras });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v380") {
      const saved = await readV380Devices();
      const live = await discover(2000);
      send(res, 200, {
        cameras: saved.filter((device) => !savedIds().has(device.id)).map((device) => {
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
      send(res, 202, { ok: true, cameras: savedCameras() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pause") {
      if (!active && !readDuty()) throw new Error("Nothing is downloading");
      holdDuty(true);
      emit({ type: "paused" });
      active?.abort();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/resume") {
      const duty = readDuty();
      if (!duty) throw new Error("Nothing is paused");
      holdDuty(false);
      if (active) resumeSoon = true;
      else resumeDuty();
      send(res, 202, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/live/stop") {
      stopLive();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/live") {
      const camera = savedCamera(Number(url.searchParams.get("id")));
      if (!camera) throw new Error("Save this camera first, including its username and password");
      await ensureFfmpeg();
      const closed = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) closed.abort();
      });
      await streamLive({
        host: camera.host,
        port: camera.port || 8800,
        deviceId: camera.id,
        username: camera.username,
        password: camera.password,
      }, res, closed.signal);
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
      const drop = () => listeners.delete(res);
      req.on("close", drop);
      res.on("close", drop);
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) send(res, 400, { error: message });
  }
});

const port = Number(process.env.PORT || 8787);
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") process.exit(86);
  console.error(error.message);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => {
  const name = os.hostname().trim() || "localhost";
  const address = `http://${name}:${port}`;
  console.log(`V380 sync is at ${address}`);
  ensureDefaultKeep(path.join(root, "recordings"));
  sweepOldVideos();
  prunePreviews();
  void ensureFfmpeg().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
  paused = Boolean(readDuty()?.paused);
  resumeDuty();
  const sweep = setInterval(() => sweepOldVideos(), 15_000);
  sweep.unref();
  const restart = setTimeout(() => {
    restarting = true;
    active?.abort();
    setTimeout(() => process.exit(0), 800);
  }, msUntilThreeAm(new Date()));
  restart.unref();
  if (process.env.V380_NO_OPEN) return;
  const opener = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${address}"`], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(process.platform === "darwin" ? "open" : "xdg-open", [address], { detached: true, stdio: "ignore" });
  opener.on("error", () => undefined);
  opener.unref();
});

function pruneOld(dir: string, days: number) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      /* A preview can be open while it is pruned. */
    }
  }
}

function prunePreviews() {
  pruneOld(path.join(root, "runtime", "previews"), 3);
  pruneOld(path.join(root, "runtime", "thumbs"), 14);
}
