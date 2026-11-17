import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./app-root.js";

export interface Duty {
  name: string;
  host: string;
  port: number;
  deviceId: number;
  username: string;
  password: string;
  days: number;
  date: string;
  outDir: string;
}

function dutyFile(): string {
  return path.join(appRoot(), "runtime", "active.json");
}

export function readDuty(): Duty | null {
  try {
    const duty = JSON.parse(fs.readFileSync(dutyFile(), "utf8")) as Duty;
    if (!duty || !Number.isInteger(duty.deviceId) || duty.deviceId <= 0) return null;
    if (!duty.host || !duty.username || !duty.password || !duty.outDir) return null;
    return duty;
  } catch {
    return null;
  }
}

export function writeDuty(duty: Duty) {
  const dest = dutyFile();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(duty), { mode: 0o600 });
  fs.renameSync(temp, dest);
}

export function clearDuty() {
  fs.rmSync(dutyFile(), { force: true });
}

/* The next 3:00 is tomorrow when the clock is already on 3:00, so a restart does not loop. */
export function msUntilThreeAm(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
