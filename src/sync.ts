import path from "node:path";
import { appRoot } from "./app-root.js";
import { ensureFfmpeg } from "./ffmpeg-setup.js";
import { recentDays, runSync } from "./job.js";
import { cameraConfig, loadEnv } from "./session.js";

const root = appRoot();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run sync -- [--days N] [--date YYYY-MM-DD] [--out dir] [--limit N] [--host ip]");
    console.log("Copies SD card recordings to recordings/ and skips files already saved.");
    return;
  }
  await ensureFfmpeg();
  const env = loadEnv(path.join(root, ".env"));
  const date = arg("--date");
  const days = date ? [date] : recentDays(Math.max(1, Number(arg("--days") ?? 1)));
  const controller = new AbortController();
  await runSync({
    config: cameraConfig(env, arg("--host")),
    days,
    outDir: path.resolve(arg("--out") ?? path.join(root, "recordings")),
    limit: arg("--limit") ? Number(arg("--limit")) : Number.POSITIVE_INFINITY,
    signal: controller.signal,
  }, (event) => {
    if (event.type === "log") console.log(event.message);
    if (event.type === "progress") console.log(`  ${event.file}  ${(event.bytes / 1024 / 1024).toFixed(1)} MB`);
    if (event.type === "done") console.log(`done, saved ${event.saved}, already on disk ${event.skipped}`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
