import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { appRoot } from "./app-root.js";

export interface V380Device {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

let sqlModule: ReturnType<typeof initSqlJs> | null = null;

function wasmFile(): string | null {
  const candidates = [
    path.join(appRoot(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(appRoot(), "runtime", "sql-wasm.wasm"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

async function sql() {
  const wasm = wasmFile();
  if (!wasm) throw new Error("The local database reader is missing its sql-wasm.wasm file");
  sqlModule ??= initSqlJs({ wasmBinary: fs.readFileSync(wasm) });
  return sqlModule;
}

/* The V380 app stores the device login as !@#$ plus base64. */
export function decodeStored(value: string): string {
  const trimmed = value.trim();
  const body = trimmed.startsWith("!@#$") ? trimmed.slice(4) : trimmed;
  if (!body) return "";
  const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
  try {
    const text = Buffer.from(body + pad, "base64").toString("utf8");
    if (text && /^[\x20-\x7e]+$/.test(text)) return text;
  } catch {
    return trimmed;
  }
  return trimmed;
}

function databaseFiles(): string[] {
  const home = os.homedir();
  const found: string[] = [];
  const add = (file: string) => {
    if (fs.existsSync(file)) found.push(file);
  };
  if (process.platform === "darwin") {
    const containers = path.join(home, "Library", "Containers");
    if (fs.existsSync(containers)) {
      for (const name of fs.readdirSync(containers)) {
        add(path.join(containers, name, "Data", "Documents", "com.macrovideo.CLDDatabase"));
      }
    }
  }
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const roots = [
    path.join(local, "V380"),
    path.join(roaming, "V380"),
    path.join(roaming, "MacroVideo"),
    path.join(local, "V380 Pro"),
    path.join(roaming, "V380 Pro"),
    path.join(home, "Documents"),
  ];
  for (const root of roots) collectDatabases(root, 0, found);
  return [...new Set(found)];
}

function collectDatabases(dir: string, depth: number, found: string[]) {
  if (depth > 5 || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDatabases(full, depth + 1, found);
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower.includes("clddatabase") || lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) {
      found.push(full);
    }
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function devicesFrom(database: { exec(sql: string): { values: unknown[][] }[] }): V380Device[] {
  const tables = database.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
  const names = new Set((tables[0]?.values ?? []).map((row) => text(row[0])));
  if (!names.has("CLDDatabaseManager_Table_Device_List")) return [];
  const rows = database.exec(
    "SELECT device_id, nickname, device_account, device_password, server, port FROM CLDDatabaseManager_Table_Device_List",
  );
  const devices: V380Device[] = [];
  for (const row of rows[0]?.values ?? []) {
    const id = Number(row[0]);
    const username = decodeStored(text(row[2]));
    const password = decodeStored(text(row[3]));
    const host = text(row[4]).trim();
    const port = Number(row[5] || 8800);
    if (!Number.isInteger(id) || id <= 0 || !username || !password) continue;
    devices.push({
      id,
      name: text(row[1]).trim() || `Camera ${id}`,
      host,
      port: Number.isInteger(port) && port > 0 ? port : 8800,
      username,
      password,
    });
  }
  return devices;
}

function windowsIniFiles(): string[] {
  const home = os.homedir();
  const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const candidates = [
    path.join(roaming, "MacroVideo", "V380.ini"),
    path.join(home, "AppData", "Roaming", "MacroVideo", "V380.ini"),
  ];
  return candidates.filter((file) => fs.existsSync(file));
}

/* Qt writes the device list as @Variant(...) with C-style escapes. */
function unescapeIni(value: string): Buffer {
  let body = value;
  if (body.startsWith("\"")) body = body.slice(1);
  if (body.endsWith("\"")) body = body.slice(0, -1);
  const out: number[] = [];
  const hex = "0123456789abcdefABCDEF";
  const oct = "01234567";
  const named: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, a: 7, f: 12, v: 11 };
  for (let i = 0; i < body.length;) {
    if (body[i] !== "\\") {
      out.push(body.charCodeAt(i));
      i += 1;
      continue;
    }
    const next = body[i + 1] ?? "";
    if (next === "x") {
      let end = i + 2;
      while (end < body.length && end < i + 4 && hex.includes(body[end])) end += 1;
      out.push(Number.parseInt(body.slice(i + 2, end), 16));
      i = end;
    } else if (oct.includes(next)) {
      let end = i + 1;
      while (end < body.length && end < i + 4 && oct.includes(body[end])) end += 1;
      out.push(Number.parseInt(body.slice(i + 1, end), 8));
      i = end;
    } else if (next in named) {
      out.push(named[next]);
      i += 2;
    } else {
      out.push(next.charCodeAt(0));
      i += 2;
    }
  }
  return Buffer.from(out);
}

class VariantReader {
  private offset = 0;

  constructor(private data: Buffer) {}

  private u32(): number {
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private qstring(): string {
    const size = this.u32();
    if (size === 0xffffffff) return "";
    const raw = Buffer.from(this.data.subarray(this.offset, this.offset + size));
    this.offset += size;
    return raw.swap16().toString("utf16le");
  }

  variant(): unknown {
    const type = this.u32();
    if (type === 1) {
      const value = this.data[this.offset] !== 0;
      this.offset += 1;
      return value;
    }
    if (type === 2) {
      const value = this.data.readInt32BE(this.offset);
      this.offset += 4;
      return value;
    }
    if (type === 3) return this.u32();
    if (type === 4 || type === 5) {
      const value = Number(this.data.readBigUInt64BE(this.offset));
      this.offset += 8;
      return value;
    }
    if (type === 8) {
      const count = this.u32();
      const map: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) map[this.qstring()] = this.variant();
      return map;
    }
    if (type === 10) return this.qstring();
    if (type === 12) {
      const size = this.u32();
      const raw = Buffer.from(this.data.subarray(this.offset, this.offset + size));
      this.offset += size;
      return raw;
    }
    throw new Error(`unsupported V380 value type ${type}`);
  }
}

function windowsPassword(value: unknown): string {
  if (typeof value === "string") return decodeStored(value);
  if (!Buffer.isBuffer(value)) return "";
  const text = value.toString("utf8");
  if (text.startsWith("!@#$") || (text.length > 0 && text.length <= 40 && /^[\x20-\x7e]+$/.test(text) && !/^[A-Za-z0-9+/]{60,}$/.test(text))) {
    return decodeStored(text);
  }
  return "";
}

function devicesFromWindowsIni(contents: string): V380Device[] {
  const devices: V380Device[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const cut = line.indexOf("=");
    if (cut < 0 || !line.includes("\\devlist=")) continue;
    const raw = line.slice(cut + 1);
    const bytes = unescapeIni(raw);
    let start = 0;
    while (start < bytes.length) {
      const open = bytes.indexOf("@Variant(", start);
      if (open < 0) break;
      const close = bytes.indexOf(")", open);
      if (close < 0) break;
      try {
        const reader = new VariantReader(bytes.subarray(open + "@Variant(".length, close));
        const value = reader.variant();
        if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
          const row = value as Record<string, unknown>;
          const id = Number(row.id);
          const username = typeof row.username === "string" ? row.username : "";
          const password = windowsPassword(row.password);
          if (Number.isInteger(id) && id > 0) {
            devices.push({
              id,
              name: typeof row.nickname === "string" && row.nickname ? row.nickname : `Camera ${id}`,
              host: typeof row.ip === "string" ? row.ip : "",
              port: 8800,
              username,
              password,
            });
          }
        }
      } catch {
        /* The next camera record starts at the following variant. */
      }
      start = close + 1;
    }
  }
  return devices;
}

function readWindowsDevices(): V380Device[] {
  const found: V380Device[] = [];
  for (const file of windowsIniFiles()) {
    try {
      found.push(...devicesFromWindowsIni(fs.readFileSync(file, "utf8")));
    } catch {
      continue;
    }
  }
  return found;
}

export async function readV380Devices(): Promise<V380Device[]> {
  const byId = new Map<number, V380Device>();
  const SQL = await sql().catch(() => null);
  if (SQL) {
  for (const file of databaseFiles()) {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (!data.subarray(0, 15).toString("utf8").startsWith("SQLite format 3")) continue;
    let database: { exec(sql: string): { values: unknown[][] }[]; close(): void } | null = null;
    try {
      database = new SQL.Database(data);
      for (const device of devicesFrom(database)) byId.set(device.id, device);
    } catch {
      continue;
    } finally {
      database?.close();
    }
  }
  }
  for (const device of readWindowsDevices()) {
    const existing = byId.get(device.id);
    if (!existing) byId.set(device.id, device);
    else if (!existing.password && device.password) byId.set(device.id, { ...existing, ...device, host: device.host || existing.host });
  }
  return [...byId.values()];
}

export async function deviceFromV380(id: number): Promise<V380Device | undefined> {
  const devices = await readV380Devices();
  return devices.find((device) => device.id === id);
}
