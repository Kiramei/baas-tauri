import { createServer } from "node:http";
import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".cur": "image/x-icon",
  ".ico": "image/x-icon",
};

export function createExportServer(directory, basePath = "") {
  if (basePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
    throw new Error(
      "The deployment base path must contain safe path segments without a trailing slash"
    );
  }
  const root = realpathSync(directory);
  const inside = (file) => {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  return createServer((request, response) => {
    const fail = (status) => {
      response.writeHead(status);
      response.end();
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      fail(405);
      return;
    }
    let url, pathname;
    try {
      url = new URL(request.url, "http://export.invalid");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      fail(400);
      return;
    }
    if (pathname.includes("\\") || pathname.includes("\0")) {
      fail(400);
      return;
    }
    if (basePath && pathname === basePath) {
      response.writeHead(308, { Location: basePath + "/" + url.search });
      response.end();
      return;
    }
    if (!pathname.startsWith(basePath + "/")) {
      fail(404);
      return;
    }
    let file = path.resolve(root, "." + pathname.slice(basePath.length));
    if (!inside(file)) {
      fail(404);
      return;
    }
    try {
      if (statSync(file).isDirectory()) {
        if (!pathname.endsWith("/")) {
          response.writeHead(308, { Location: url.pathname + "/" + url.search });
          response.end();
          return;
        }
        file = path.join(file, "index.html");
      }
      file = realpathSync(file);
      if (!inside(file) || !statSync(file).isFile()) {
        fail(404);
        return;
      }
      response.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) fail(404);
      else fail(500);
    }
  });
}
