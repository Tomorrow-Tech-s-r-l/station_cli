const fs = require("fs");
const path = require("path");

const targets = ["dist", "executables"];

for (const target of targets) {
  const fullPath = path.join(__dirname, "..", target);
  try {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`Removed ${target}/`);
  } catch (error) {
    console.error(`Failed to remove ${target}/:`, error.message || error);
    process.exitCode = 1;
  }
}
