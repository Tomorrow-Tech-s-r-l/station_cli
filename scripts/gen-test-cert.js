#!/usr/bin/env node
/**
 * Generates a throwaway self-signed certificate for the firmware download
 * tests, which stand a local HTTPS server up in place of the GitHub Releases
 * API. Regenerated when missing or older than a day; never used outside tests.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = process.env.FWU_TEST_CERT_DIR || path.join(os.tmpdir(), "fwu-test-cert");
const cert = path.join(dir, "cert.pem");
const key = path.join(dir, "key.pem");

const fresh = () => {
  try {
    const age = Date.now() - fs.statSync(cert).mtimeMs;
    return fs.existsSync(key) && age < 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
};

if (fresh()) {
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert,
      "-days", "2", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
} catch (e) {
  // No openssl (or it failed): the HTTP tests detect the missing certificate
  // and skip themselves rather than failing the suite.
  console.error("gen-test-cert: openssl unavailable — HTTP tests will be skipped.");
}
