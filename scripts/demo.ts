// Runs the demo from a laptop: ngrok tunnel + server, and keeps a Mac awake meanwhile.
// Usage: npm run demo   (needs PUBLIC_URL=https://<your-domain>.ngrok-free.dev in .env)
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";

const publicUrl = process.env.PUBLIC_URL;
const port = process.env.PORT || "8080";
if (!publicUrl) {
  console.error("Set PUBLIC_URL in .env to your ngrok domain, e.g. https://example.ngrok-free.dev");
  process.exit(1);
}
const domain = new URL(publicUrl).host;

const children: ChildProcess[] = [];
process.on("exit", () => {
  for (const child of children) child.kill();
});

// Keep the laptop awake while the demo runs: a sleeping laptop drops calls in progress.
if (process.platform === "darwin") {
  children.push(spawn("caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore" }));
}

await startTunnel();
// The server registers its own shutdown handling (Ctrl-C ends open sessions properly).
await import("../src/server.js");

/** Starts `ngrok http` and resolves once the tunnel is online; exits with a hint if it can't start. */
function startTunnel(): Promise<void> {
  return new Promise((resolve) => {
    const ngrok = spawn("ngrok", ["http", `--url=${domain}`, port, "--log=stdout", "--log-format=logfmt"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(ngrok);
    let online = false;
    const fail = (why: string) => {
      console.error(`\nngrok couldn't start the tunnel: ${why}`);
      process.exit(1);
    };

    ngrok.on("error", () => fail("is ngrok installed? (brew install ngrok)"));
    ngrok.on("exit", (code) => {
      if (!online) fail(`it exited (code ${code})`);
      else console.error("\nThe ngrok tunnel stopped; the demo page and invites are unreachable until you restart.");
    });
    ngrok.stdout.setEncoding("utf8").on("data", (text: string) => {
      for (const line of text.split("\n")) {
        if (!online && line.includes('msg="started tunnel"')) {
          online = true;
          console.log(`Tunnel online: https://${domain} -> localhost:${port}`);
          resolve();
        } else if (/lvl=(eror|crit)/.test(line)) {
          const message = /err="([^"]*)/.exec(line)?.[1]?.split("\\n")[0] ?? line;
          if (!online) fail(explain(message));
          else console.error(`ngrok: ${message}`);
        }
      }
    });
  });
}

function explain(message: string): string {
  if (message.includes("not authenticated")) return "it isn't authenticated. Run: ngrok config add-authtoken <your-token>";
  if (message.includes("already online")) return `the tunnel for ${domain} is already running elsewhere. Stop the other ngrok first.`;
  return message;
}
