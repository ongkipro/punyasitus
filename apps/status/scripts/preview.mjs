import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildStatusSite } from "./build.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const { distDir } = buildStatusSite();
const port = Number(process.env.PORT ?? 4329);

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.resolve(distDir, `.${cleanPath}`);
  if (!resolved.startsWith(distDir) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  const ext = path.extname(resolved);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".json" ? "no-store" : "public, max-age=60",
  });
  fs.createReadStream(resolved).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[apps/status] Static preview listening at http://127.0.0.1:${port}/`);
});
