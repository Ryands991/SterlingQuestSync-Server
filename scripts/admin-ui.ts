// Sterling Admin: the owner jobs in a small window. Runs only on the owner's PC.
//
//   npm run admin-ui      (or double-click "Sterling Admin.cmd")
//
// It starts a tiny web server on 127.0.0.1 with a random port and a random key for this launch only,
// and opens it in an app-style browser window. Other programs and web pages can't use it: requests
// need this launch's key, and the Host and Origin must be this exact local address. It offers only
// the fixed jobs in admin-lib.ts and stops on its own a little after the window closes.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { accounts, ban, signups, overview, backup, backupDir, signIn, notices, addNotice, removeNotice, AdminError } from "./admin-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "admin-ui");
const KEY = randomBytes(24).toString("hex");
const IDLE_MS = 45_000;
const FIRST_MS = 120_000;

const FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.png": ["icon.png", "image/png"],
  "/fonts/spectral-sc-latin-600-normal.woff2": ["fonts/spectral-sc-latin-600-normal.woff2", "font/woff2"],
  "/fonts/source-sans-3-latin-400-normal.woff2": ["fonts/source-sans-3-latin-400-normal.woff2", "font/woff2"],
  "/fonts/source-sans-3-latin-600-normal.woff2": ["fonts/source-sans-3-latin-600-normal.woff2", "font/woff2"],
  "/fonts/source-sans-3-latin-700-normal.woff2": ["fonts/source-sans-3-latin-700-normal.woff2", "font/woff2"],
};

let lastSeen = Date.now();
let seenPage = false;
let origin = "";

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v));

function keyOk(req: IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const want = Buffer.from(KEY);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > 4096) req.destroy();
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(s || "{}");
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Only these jobs exist. Arguments are checked again inside admin-lib.
const JOBS: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  overview: async () => ({ ...(await overview()), sign_in: signIn() }),
  backup: async () => {
    const r = await backup();
    openFolder(r.dir);
    return { message: "Saved " + r.file };
  },
  openbackups: async () => {
    openFolder(backupDir());
    return { ok: true };
  },
  accounts: () => accounts(),
  ban: (b) => ban(String(b.id ?? ""), true).then((message) => ({ message })),
  unban: (b) => ban(String(b.id ?? ""), false).then((message) => ({ message })),
  signups: (b) => signups(String(b.mode ?? "")).then((message) => ({ message })),
  notices: () => notices(),
  addnotice: (b) => addNotice(b).then((message) => ({ message })),
  removenotice: (b) => removeNotice(String(b.id ?? "")).then((message) => ({ message })),
  ping: async () => ({ ok: true }),
};

const server = createServer(async (req, res) => {
  // Refuse anything not addressed to this exact local server (blocks DNS rebinding tricks).
  if (req.headers.host !== origin.slice("http://".length)) return send(res, 421, "wrong host", "text/plain");
  const url = new URL(req.url || "/", origin);
  if (req.method === "GET" && FILES[url.pathname]) {
    const [file, type] = FILES[url.pathname];
    const path = join(UI, file);
    if (!existsSync(path)) return send(res, 404, "missing", "text/plain");
    if (url.pathname === "/") seenPage = true;
    lastSeen = Date.now();
    return send(res, 200, readFileSync(path), type);
  }
  const m = /^\/api\/([a-z]+)$/.exec(url.pathname);
  if (req.method !== "POST" || !m || !JOBS[m[1]]) return send(res, 404, "not found", "text/plain");
  if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "Wrong origin." });
  if (!keyOk(req)) return json(res, 403, { error: "This window's key doesn't match. Close it and start Sterling Admin again." });
  lastSeen = Date.now();
  try {
    json(res, 200, await JOBS[m[1]](await readBody(req)));
  } catch (e) {
    json(res, 400, { error: e instanceof AdminError ? e.message : "Something went wrong: " + (e as Error).message });
  }
});

function openFolder(dir: string) {
  if (process.env.SQS_ADMIN_NO_WINDOW) return;
  mkdirSync(dir, { recursive: true });
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [dir], { stdio: "ignore", detached: true });
}

function openWindow(url: string) {
  if (process.env.SQS_ADMIN_NO_WINDOW) return;
  if (process.platform === "win32") {
    // Edge's app mode gives a plain window with no tabs or address bar. Falls back to the default browser.
    const p = spawn("cmd", ["/c", "start", "", "msedge", `--app=${url}`, "--window-size=960,700"], { stdio: "ignore", detached: true });
    p.on("exit", (code) => {
      if (code) spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    });
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  }
}

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${addr.port}`;
  const url = `${origin}/#${KEY}`;
  console.log("Sterling Admin is running. Its window should open now.");
  console.log("If it doesn't, open this address in your browser (it only works on this PC, this time):");
  console.log("  " + url);
  console.log("This window closes on its own a little after the admin window is closed.");
  openWindow(url);
});

const started = Date.now();
setInterval(() => {
  const idle = Date.now() - lastSeen;
  if ((seenPage && idle > IDLE_MS) || (!seenPage && Date.now() - started > FIRST_MS)) {
    console.log("Admin window closed. Stopping.");
    process.exit(0);
  }
}, 5_000).unref();
