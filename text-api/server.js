const http = require("http");
const { URL } = require("url");

const HOST = "0.0.0.0";
const START_PORT = Number(process.env.PORT) || 3001;
const MAX_PORT_TRIES = 20;

let currentPort = START_PORT;
let attempts = 0;

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) {
        tooLarge = true;
        reject(new Error("Payload too large (max 1MB)"));
      }
    });

    req.on("end", () => {
      if (tooLarge) return;
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", (err) => reject(err));
  });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    req.on("error", (err) => {
      console.error("[req error]", err.message);
    });

    try {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
        return sendJson(res, 200, {
          status: "ok",
          service: "text-utilities-api",
          port: currentPort,
          uptimeSec: Math.floor(process.uptime()),
          endpoints: ["/health", "/stats", "/transform"],
        });
      }

      if (req.method === "POST" && pathname === "/stats") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        return sendJson(res, 200, {
          characters: text.length,
          words,
          lines: text ? text.split(/\r?\n/).length : 0,
        });
      }

      if (req.method === "POST" && pathname === "/transform") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        const mode = body.mode || "upper";

        let result;
        if (mode === "upper") result = text.toUpperCase();
        else if (mode === "lower") result = text.toLowerCase();
        else if (mode === "reverse") result = text.split("").reverse().join("");
        else {
          return sendJson(res, 400, {
            error: "Unsupported mode. Use 'upper', 'lower', or 'reverse'",
          });
        }

        return sendJson(res, 200, { mode, result });
      }

      return sendJson(res, 404, { error: "Route not found" });
    } catch (err) {
      const isClientError =
        err.message === "Invalid JSON" || err.message.startsWith("Payload too large");
      return sendJson(res, isClientError ? 400 : 500, {
        error: isClientError ? err.message : "Internal server error",
      });
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      attempts += 1;
      if (attempts >= MAX_PORT_TRIES) {
        console.error(`[fatal] No se encontró puerto libre tras ${MAX_PORT_TRIES} intentos desde ${START_PORT}`);
        process.exit(1);
      }
      const nextPort = currentPort + 1;
      console.warn(`[warn] Puerto ${currentPort} en uso, probando ${nextPort}...`);
      currentPort = nextPort;
      try {
        server.close();
      } catch {}
      setTimeout(startServer, 200);
      return;
    }

    console.error("[server error]", err);
  });

  server.listen(currentPort, HOST, () => {
    attempts = 0;
    console.log(`[ready] text-utilities-api escuchando en http://${HOST}:${currentPort}`);
  });

  const shutdown = (signal) => {
    console.log(`[shutdown] Señal ${signal} recibida, cerrando servidor...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

startServer();
