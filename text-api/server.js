const http = require("http");
const { URL } = require("url");

const HOST = "0.0.0.0";
let port = Number(process.env.PORT) || 3001;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      return sendJson(res, 200, {
        status: "ok",
        service: "text-utilities-api",
        port,
        endpoints: ["/health", "/stats", "/transform"],
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && pathname === "/stats") {
      try {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        return sendJson(res, 200, {
          characters: text.length,
          words,
          lines: text ? text.split(/\r?\n/).length : 0,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === "POST" && pathname === "/transform") {
      try {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        const mode = body.mode || "upper";

        let result = text;
        if (mode === "upper") result = text.toUpperCase();
        else if (mode === "lower") result = text.toLowerCase();
        else if (mode === "reverse") result = text.split("").reverse().join("");
        else return sendJson(res, 400, { error: "Unsupported mode. Use upper, lower, or reverse" });

        return sendJson(res, 200, { mode, result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    return sendJson(res, 404, { error: "Route not found" });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Puerto ${port} en uso, reintentando en ${port + 1}...`);
      port += 1;
      setTimeout(() => {
        try { server.close(); } catch {}
        createServer();
      }, 250);
      return;
    }
    console.error("Error del servidor:", err);
  });

  server.listen(port, HOST, () => {
    console.log(`Text utilities API listening on http://${HOST}:${port}`);
  });
}

createServer();
