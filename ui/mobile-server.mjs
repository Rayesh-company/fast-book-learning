import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const UI_DIR = __dirname;

const PORT = parseInt(process.env.PORT || "8766", 10);
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "8765", 10);
const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const RETICLE_DAEMON_PORT = parseInt(process.env.RETICLE_PORT || "4400", 10);

// Read pairing token if available
let pairingToken = "";
const tokenPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".reticle", "pairing-token");
if (fs.existsSync(tokenPath)) {
  try {
    pairingToken = fs.readFileSync(tokenPath, "utf-8").trim();
  } catch {}
}

const RETICLE_SNIPPET = `
<!-- Reticle In-App Verification Bridge -->
<script type="module">
  try {
    const { reticle } = await import('https://cdn.jsdelivr.net/npm/@reticlehq/browser@3.6.0/+esm');
    reticle.connect({
      url: 'ws://127.0.0.1:${RETICLE_DAEMON_PORT}',
      projectId: 'mobile-4c854b11',
      token: '${pairingToken}',
      allowNonLocalhost: true
    });
    console.log('[Reticle] connected to daemon on 127.0.0.1:${RETICLE_DAEMON_PORT}');
  } catch (err) {
    console.warn('[Reticle] connection failed:', err);
  }
</script>
`;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
};

function resolveStaticPath(reqUrl) {
  const parsed = new URL(reqUrl, "http://localhost");
  let pathname = decodeURIComponent(parsed.pathname);

  // Normalize mobile entrypoint
  if (pathname === "/" || pathname === "/mobile" || pathname === "/mobile/") {
    return path.join(UI_DIR, "mobile", "index.html");
  }

  if (pathname.startsWith("/mobile/")) {
    const rel = pathname.slice("/mobile/".length);
    const target = path.join(UI_DIR, "mobile", rel);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }

  if (pathname.startsWith("/vendor/")) {
    const rel = pathname.slice("/vendor/".length);
    const target = path.join(UI_DIR, "vendor", rel);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }

  if (pathname.startsWith("/book-reader/")) {
    const rel = pathname.slice("/book-reader/".length);
    const target = path.join(UI_DIR, "book-reader", rel);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }

  if (pathname.startsWith("/icons/")) {
    const rel = pathname.slice("/icons/".length);
    const target = path.join(UI_DIR, "icons", rel);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }

  // General ui root file check
  const uiDirect = path.join(UI_DIR, pathname.slice(1));
  if (fs.existsSync(uiDirect) && fs.statSync(uiDirect).isFile()) {
    return uiDirect;
  }

  return null;
}

const server = http.createServer((req, res) => {
  const staticFile = resolveStaticPath(req.url);

  if (staticFile) {
    const ext = path.extname(staticFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    try {
      let content = fs.readFileSync(staticFile);
      if (ext === ".html") {
        let htmlStr = content.toString("utf-8");
        htmlStr = htmlStr.replace('/mobile/app.mjs', `/mobile/app.mjs?t=${Date.now()}`);
        if (htmlStr.includes("</head>")) {
          htmlStr = htmlStr.replace("</head>", `${RETICLE_SNIPPET}\n</head>`);
        } else {
          htmlStr += RETICLE_SNIPPET;
        }
        content = Buffer.from(htmlStr, "utf-8");
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      res.end(content);
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }
  }

  // Proxy to backend (serve.py on port 8765)
  const proxyReq = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${BACKEND_HOST}:${BACKEND_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Backend unavailable",
        detail: err.message,
        hint: `Ensure ui/serve.py is running on http://${BACKEND_HOST}:${BACKEND_PORT}`,
      })
    );
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Node Mobile Front Server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Local URL:   http://localhost:${PORT}/mobile/`);
  console.log(`  Backend API: http://${BACKEND_HOST}:${BACKEND_PORT}`);
  console.log(`  Reticle:     ws://127.0.0.1:${RETICLE_DAEMON_PORT} (token: ${pairingToken ? "found" : "none"})`);
});
