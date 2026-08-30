import fs from "fs";
import path from "path";

export const logPath = path.join(import.meta.dirname, "bridge.log");

if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
  fs.renameSync(logPath, logPath + ".old");
}

export const log = (...args) => {
  const line = new Date().toISOString() + " " + args.join(" ") + "\n";

  process.stdout.write(line);

  try {
    fs.appendFileSync(logPath, line);
  } catch {}
};
