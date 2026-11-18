import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { parse } from "node:url";
import next from "next";
import { handleWsUpgrade } from "./lib/server/wsHub";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function bootstrap() {
  await app.prepare();

  const tlsKeyPath = process.env.ULTRON_TLS_KEY_PATH?.trim();
  const tlsCertPath = process.env.ULTRON_TLS_CERT_PATH?.trim();
  const useTls =
    Boolean(tlsKeyPath && tlsCertPath) &&
    fs.existsSync(tlsKeyPath!) &&
    fs.existsSync(tlsCertPath!);

  const requestListener: http.RequestListener = (req, res) => {
    const parsedUrl = parse(req.url ?? "/", true);
    void handle(req, res, parsedUrl);
  };

  const server = useTls
    ? https.createServer(
        {
          key: fs.readFileSync(tlsKeyPath!),
          cert: fs.readFileSync(tlsCertPath!),
        },
        requestListener,
      )
    : http.createServer(requestListener);

  const nextUpgradeHandler = app.getUpgradeHandler();

  server.on("upgrade", (req, socket, head) => {
    const handled = handleWsUpgrade(req, socket, head);
    if (!handled) {
      void nextUpgradeHandler(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    const scheme = useTls ? "https" : "http";
    console.log(
      `> ULTRON Hub ready on ${scheme}://${hostname}:${port} (${dev ? "development" : "production"})`,
    );
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start ULTRON server:", err);
  process.exit(1);
});
