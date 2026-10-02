/**
 * Integration tests for the firmware download layer, against a local HTTPS
 * server standing in for the GitHub Releases API.
 *
 * This is the code that runs unattended on a station with no operator
 * watching, and the failure it must never allow is a partial or wrong image
 * reaching the flasher. The three properties pinned here are exactly the ones
 * that are invisible until they bite:
 *
 *   1. The GitHub token is dropped on the redirect to the object store.
 *      Forwarding it there gets the request rejected with 400 by S3, and
 *      leaks the credential to a third party.
 *   2. A truncated or wrong-digest download is refused and the cache is left
 *      clean, so the next run re-downloads instead of flashing a bad image.
 *   3. A good download is cached and reused without a second fetch.
 *
 * Requires a throwaway certificate; `npm run test:unit` generates one via
 * scripts/gen-test-cert.js and points NODE_EXTRA_CA_CERTS at it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  httpGetJson,
  httpDownloadToFile,
  HttpError,
  isGitHubApiHost,
} = require("../dist/S1TTXX/fwu/http");
const { ensureImage } = require("../dist/S1TTXX/fwu/catalog");

const CERT_DIR = process.env.FWU_TEST_CERT_DIR || path.join(os.tmpdir(), "fwu-test-cert");
const haveCert =
  fs.existsSync(path.join(CERT_DIR, "cert.pem")) &&
  fs.existsSync(path.join(CERT_DIR, "key.pem"));

/** Records what each request carried, so assertions can inspect the headers. */
function startServer(handler) {
  const seen = [];
  const server = https.createServer(
    {
      cert: fs.readFileSync(path.join(CERT_DIR, "cert.pem")),
      key: fs.readFileSync(path.join(CERT_DIR, "key.pem")),
    },
    (req, res) => {
      seen.push({ url: req.url, headers: { ...req.headers } });
      handler(req, res, seen);
    }
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        seen,
        origin: `https://localhost:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fwu-cache-"));
}

const IMAGE = Buffer.from("APPLICATION IMAGE BODY, NOT A MERGED ONE".repeat(16));
const IMAGE_SHA = crypto.createHash("sha256").update(IMAGE).digest("hex");

const suite = { skip: !haveCert, ...(haveCert ? {} : { skip: "no test certificate generated" }) };

test("the token is scoped to GitHub's own API hosts", () => {
  // The positive half of the rule the redirect test below exercises: the token
  // goes to GitHub, and to nothing else — including hosts that merely look
  // like GitHub, which is how a redirect to an attacker-controlled name would
  // try to collect it.
  assert.equal(isGitHubApiHost("api.github.com"), true);
  assert.equal(isGitHubApiHost("github.com"), true);
  assert.equal(isGitHubApiHost("objects.githubusercontent.com"), false);
  assert.equal(isGitHubApiHost("release-assets.githubusercontent.com"), false);
  assert.equal(isGitHubApiHost("github-releases.s3.amazonaws.com"), false);
  assert.equal(isGitHubApiHost("api.github.com.evil.test"), false);
  assert.equal(isGitHubApiHost("notgithub.com"), false);
  assert.equal(isGitHubApiHost("localhost"), false);
});

test("httpGetJson parses a JSON body", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ tag_name: "v1.2.3" }]));
  });
  try {
    const body = await httpGetJson(`${s.origin}/releases`);
    assert.equal(body[0].tag_name, "v1.2.3");
  } finally {
    await s.close();
  }
});

test("a non-2xx response raises HttpError carrying the status", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  try {
    await assert.rejects(() => httpGetJson(`${s.origin}/missing`), (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.statusCode, 404);
      return true;
    });
  } finally {
    await s.close();
  }
});

test("a plain HTTP URL is refused outright", suite, async () => {
  await assert.rejects(
    () => httpGetJson("http://example.com/releases"),
    /Refusing non-HTTPS firmware URL/
  );
});

test("the GitHub token is never forwarded to a non-GitHub host", suite, async () => {
  // The asset store stands in for objects.githubusercontent.com / S3: the
  // signed URL already carries its own credentials, and S3 rejects a request
  // that also presents an Authorization header.
  const s = await startServer((req, res, seen) => {
    if (req.url === "/asset") {
      res.writeHead(302, { location: `${s.origin}/store/signed-blob` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(IMAGE);
  });
  try {
    const dest = path.join(tmpDir(), "image.bin");
    await httpDownloadToFile(`${s.origin}/asset`, dest, { token: "SECRET-TOKEN" });

    const [first, second] = s.seen;
    assert.equal(first.url, "/asset");
    assert.equal(second.url, "/store/signed-blob");
    // The host here is `localhost`, which is not a GitHub API host, so the
    // token must not appear on either hop.
    assert.equal(first.headers.authorization, undefined);
    assert.equal(second.headers.authorization, undefined);
    assert.deepEqual(fs.readFileSync(dest), IMAGE);
  } finally {
    await s.close();
  }
});

test("a download leaves no .part file behind on success", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200);
    res.end(IMAGE);
  });
  try {
    const dir = tmpDir();
    const dest = path.join(dir, "image.bin");
    await httpDownloadToFile(`${s.origin}/asset`, dest);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally {
    await s.close();
  }
});

test("a failed download leaves nothing behind for a later run to flash", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const dir = tmpDir();
    const dest = path.join(dir, "image.bin");
    await assert.rejects(() => httpDownloadToFile(`${s.origin}/asset`, dest));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await s.close();
  }
});

test("ensureImage rejects a body shorter than the size GitHub reported", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200);
    res.end(IMAGE.subarray(0, 10)); // truncated transfer
  });
  try {
    const cacheDir = tmpDir();
    await assert.rejects(
      () =>
        ensureImage(
          {
            kind: "interface",
            tag: "v1.0.0",
            version: [1, 0, 0],
            prerelease: false,
            assetName: "S1TTXX-firmware-1.0.0.bin",
            assetUrl: `${s.origin}/asset`,
            assetSizeBytes: IMAGE.length,
            minCliVersion: null,
          },
          { channel: "stable", sources: {}, token: null, cliVersion: [0, 4, 0], cacheDir, cacheKeepPerKind: 2, warnings: [] }
        ),
      /refusing to flash a partial image/
    );
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    await s.close();
  }
});

test("ensureImage rejects an empty body", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const cacheDir = tmpDir();
    await assert.rejects(
      () =>
        ensureImage(
          {
            kind: "powerbank",
            tag: "v1.0.0",
            version: [1, 0, 0],
            prerelease: false,
            assetName: "P1TT2C-firmware-1.0.0.bin",
            assetUrl: `${s.origin}/asset`,
            assetSizeBytes: 0,
            minCliVersion: null,
          },
          { channel: "stable", sources: {}, token: null, cliVersion: [0, 4, 0], cacheDir, cacheKeepPerKind: 2, warnings: [] }
        ),
      /is empty/
    );
  } finally {
    await s.close();
  }
});

test("ensureImage rejects a body whose digest does not match", suite, async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200);
    res.end(Buffer.from("A DIFFERENT IMAGE ENTIRELY"));
  });
  try {
    const cacheDir = tmpDir();
    const candidate = {
      kind: "interface",
      tag: "v1.0.0",
      version: [1, 0, 0],
      prerelease: false,
      assetName: "S1TTXX-firmware-1.0.0.bin",
      assetUrl: `${s.origin}/asset`,
      assetSizeBytes: 0, // unknown size, so only the digest can catch this
      minCliVersion: null,
      digest: `sha256:${IMAGE_SHA}`,
    };
    await assert.rejects(
      () =>
        ensureImage(candidate, {
          channel: "stable",
          sources: {},
          token: null,
          cliVersion: [0, 4, 0],
          cacheDir,
          cacheKeepPerKind: 2,
          warnings: [],
        }),
      /does not match the digest/
    );
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    await s.close();
  }
});

test("a verified image is cached and the second run does not re-download", suite, async () => {
  let hits = 0;
  const s = await startServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end(IMAGE);
  });
  try {
    const cacheDir = tmpDir();
    const candidate = {
      kind: "interface",
      tag: "v1.0.0",
      version: [1, 0, 0],
      prerelease: false,
      assetName: "S1TTXX-firmware-1.0.0.bin",
      assetUrl: `${s.origin}/asset`,
      assetSizeBytes: IMAGE.length,
      minCliVersion: null,
      digest: `sha256:${IMAGE_SHA}`,
    };
    const opts = {
      channel: "stable",
      sources: {},
      token: null,
      cliVersion: [0, 4, 0],
      cacheDir,
      cacheKeepPerKind: 2,
      warnings: [],
    };

    const first = await ensureImage(candidate, opts);
    assert.deepEqual(fs.readFileSync(first), IMAGE);
    assert.equal(hits, 1);

    const second = await ensureImage(candidate, opts);
    assert.equal(second, first);
    assert.equal(hits, 1, "a cached image must not be fetched again");
  } finally {
    await s.close();
  }
});

test("a cached file of the wrong size is discarded and re-fetched", suite, async () => {
  let hits = 0;
  const s = await startServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end(IMAGE);
  });
  try {
    const cacheDir = tmpDir();
    const candidate = {
      kind: "interface",
      tag: "v1.0.0",
      version: [1, 0, 0],
      prerelease: false,
      assetName: "S1TTXX-firmware-1.0.0.bin",
      assetUrl: `${s.origin}/asset`,
      assetSizeBytes: IMAGE.length,
      minCliVersion: null,
    };
    const opts = { channel: "stable", sources: {}, token: null, cliVersion: [0, 4, 0], cacheDir, cacheKeepPerKind: 2, warnings: [] };

    // Plant a stale, truncated file where the cache expects the image.
    const cachePath = path.join(
      cacheDir,
      `${candidate.kind}-${candidate.tag}-${candidate.assetName}`
    );
    fs.writeFileSync(cachePath, Buffer.from("stale"));

    const resolved = await ensureImage(candidate, opts);
    assert.equal(hits, 1);
    assert.deepEqual(fs.readFileSync(resolved), IMAGE);
  } finally {
    await s.close();
  }
});
