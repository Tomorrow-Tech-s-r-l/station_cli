const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// npm runs scripts through cmd.exe on Windows, and cmd does not expand globs,
// so `node --test tests/unit/*.test.js` reached Node as a literal path and the
// Windows build leg died with "Could not find '...\tests\unit\*.test.js'".
// Collect the files here instead and hand Node an explicit list.
const testDir = path.join(__dirname, "..", "tests", "unit");

let entries;
try {
  entries = fs.readdirSync(testDir);
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.error(`No test directory at ${testDir}.`);
    process.exit(1);
  }
  throw error;
}

const files = entries
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${testDir}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

// A test run killed by a signal reports status null; treat it as a failure.
process.exit(result.status === null ? 1 : result.status);
