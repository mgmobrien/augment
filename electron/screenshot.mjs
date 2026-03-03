// CDP screenshot + optional JS execution utility
import { writeFileSync } from "fs";
import WebSocket from "ws";

const cmd = process.argv[2] || "screenshot";
const OUTPUT = process.argv[3] || "/tmp/augment-screenshot.png";

async function getPageTarget() {
  const res = await fetch("http://localhost:9222/json");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found");
  return page.webSocketDebuggerUrl;
}

async function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) {
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.on("error", (err) => reject(err));
    setTimeout(() => { reject(new Error("timeout")); ws.close(); }, 5000);
  });
}

try {
  const wsUrl = await getPageTarget();

  if (cmd === "screenshot") {
    const result = await cdpCall(wsUrl, "Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(result.data, "base64");
    writeFileSync(OUTPUT, buf);
    console.log(`Screenshot saved to ${OUTPUT} (${buf.length} bytes)`);
  } else if (cmd === "eval") {
    // Execute JS in the page context — argv[3] is the expression
    const expr = process.argv[3];
    const result = await cdpCall(wsUrl, "Runtime.evaluate", { expression: expr, returnByValue: true });
    console.log(JSON.stringify(result.result?.value ?? result, null, 2));
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
