const fs = require("fs");
const path = require("path");

if (process.platform === "win32") {
  process.exit(0);
}

const target = path.join(__dirname, "..", "dist", "cli.js");

try {
  fs.chmodSync(target, 0o755);
  console.log("Marked dist/cli.js as executable.");
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.warn("dist/cli.js not found; skipped chmod.");
    process.exit(0);
  }
  throw error;
}
