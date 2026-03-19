import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Event emitter for stats updates
const statsEmitter = new EventEmitter();
statsEmitter.setMaxListeners(100);

// Load prompts from src/prompts.json
const promptsPath = path.resolve(__dirname, "src/prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const SYSTEM_PROMPTS = prompts.system_prompts;

// Map Chatbot ID (1-20) to Llama Instance ID (1-4)
const CHATBOT_PINNING: Record<number, string> = {};
for (let i = 1; i <= 20; i++) {
  CHATBOT_PINNING[i] = Math.ceil(i / 5).toString();
}

// Global state for CPU usage
const cpuUsageCache: Record<string, number> = {
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0
};

// Caches for performance optimization
const containerIdCache: Record<string, string> = {};
const cgroupPathCache: Record<string, string> = {};
const prevCpuStats: Record<string, { containerUsage: bigint, time: bigint }> = {};

// Function to get stats from Docker Socket
async function getContainerStats(containerName: string) {
  return new Promise<any>((resolve, reject) => {
    const options = {
      socketPath: "/var/run/docker.sock",
      path: `/containers/${containerName}/stats?stream=false`,
      method: "GET"
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Docker API error: ${res.statusCode}`));
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.end();
  });
}

// Helper to read cgroup usage
function getContainerCgroupUsage(id: string, i: number): bigint {
  let p = cgroupPathCache[i.toString()];
  if (!p || !fs.existsSync(p)) {
    const paths = [
      `/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`,
      `/sys/fs/cgroup/docker/${id}/cpu.stat`,
      `/sys/fs/cgroup/cpuacct/docker/${id}/cpuacct.usage`,
    ];
    p = paths.find(fs.existsSync) || "";
    if (p) cgroupPathCache[i.toString()] = p;
  }

  if (!p) throw new Error(`No cgroup path for container ${id}`);

  const content = fs.readFileSync(p, "utf8");
  if (p.endsWith("cpu.stat")) {
    const match = content.match(/usage_usec (\d+)/);
    if (!match) throw new Error(`No usage_usec in ${p}`);
    return BigInt(match[1]) * 1000n; // convert usec to ns
  } else {
    return BigInt(content.trim()); // already in ns
  }
}

// Function to update stats for all containers in parallel
async function updateCpuStats() {
  const now = process.hrtime.bigint();
  const promises = [1, 2, 3, 4].map(async (i) => {
    try {
      let id = containerIdCache[i.toString()];
      if (!id) {
        // First time, resolve name to ID via Docker API
        let stats;
        try {
          stats = await getContainerStats(`ai-density-llama-cpp-${i}-1`);
        } catch (e) {
          stats = await getContainerStats(`llama-cpp-${i}`);
        }
        id = stats.id;
        containerIdCache[i.toString()] = id;
      }

      const usage = getContainerCgroupUsage(id, i);
      const prev = prevCpuStats[i.toString()];

      if (prev) {
        const deltaUsage = usage - prev.containerUsage;
        const deltaTime = now - prev.time;
        if (deltaTime > 0n) {
          // hostPercent is percentage of one core (100.0 = 1 core fully used)
          const hostPercent = (Number(deltaUsage) / Number(deltaTime)) * 100.0;
          // Normalize to assigned 32 cores and convert to integer
          const instancePercent = hostPercent / 32.0;
          const newVal = Math.min(Math.round(instancePercent), 100);
          
          const oldVal = cpuUsageCache[i.toString()];
          if (oldVal !== newVal) {
            console.log(`[DEBUG] CPU Usage for llama-cpp-${i} changed: ${oldVal}% -> ${newVal}%`);
          }
          cpuUsageCache[i.toString()] = newVal;
          statsEmitter.emit("statsUpdate", { id: i.toString(), cpu_usage: newVal });
        }
      }
      prevCpuStats[i.toString()] = { containerUsage: usage, time: now };
    } catch (error) {
      cpuUsageCache[i.toString()] = 0;
      statsEmitter.emit("statsUpdate", { id: i.toString(), cpu_usage: 0 });
      // Reset caches on error to allow recovery if container restarts
      delete containerIdCache[i.toString()];
      delete cgroupPathCache[i.toString()];
    }
  });

  await Promise.all(promises);
}

// Background task to poll CPU stats
async function pollCpuStats() {
  // Initial update
  await updateCpuStats();
  
  // Schedule periodic updates
  setInterval(async () => {
    await updateCpuStats();
  }, 2000); // Poll every 2 seconds
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // SSE Endpoint for stats
  app.get("/api/stats/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    statsEmitter.on("statsUpdate", onUpdate);

    req.on("close", () => {
      statsEmitter.off("statsUpdate", onUpdate);
    });
  });

  console.log("Server starting...");
  // Start polling immediately
  pollCpuStats().catch(err => console.error("CPU polling failed:", err));

  const getLlamaUrl = (id: string) => {
    const envVar = `LLAMA_API_URL_${id}`;
    return process.env[envVar] || `http://localhost:808${parseInt(id) - 1}`;
  };

  // HTTP Server to upgrade for WebSockets
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', async (message: string) => {
      try {
        const msg = JSON.parse(message.toString());
        console.log(`[DEBUG] Received WS message:`, msg);
        const { chatId, promptId } = msg;
        const instanceId = CHATBOT_PINNING[chatId];
        if (!instanceId) throw new Error("Invalid chatId");

        const [cat, grp, idx] = promptId.split(':');
        console.log(`[DEBUG] Looking up prompt cat=${cat}, grp=${grp}, idx=${idx}`);
        const systemMessage = SYSTEM_PROMPTS[cat];
        const promptText = prompts[cat][grp][idx];
        
        if (!promptText) throw new Error("Prompt not found");
        console.log(`[DEBUG] Found prompt text: "${promptText.substring(0, 50)}..."`);

        const url = getLlamaUrl(instanceId);
        console.log(`[DEBUG] Forwarding to llama instance ${instanceId} at ${url}`);
        
        const response = await fetch(`${url}/completion`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: `<|im_start|>system\n${systemMessage}<|im_end|>\n<|im_start|>user\n${promptText}<|im_end|>\n<|im_start|>assistant\n`,
            n_predict: 256,
            stream: true
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[DEBUG] Llama API error (${response.status}): ${errText}`);
          throw new Error(`Llama API error: ${response.status}`);
        }
if (!response.body) throw new Error("No response body");

console.log(`[DEBUG] Successfully connected to instance ${instanceId}, streaming tokens...`);

const reader = (response.body as any).getReader();
const decoder = new TextDecoder();

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    console.log(`[DEBUG] Received chunk: ${text.length} bytes`);

    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.content) {
            ws.send(JSON.stringify({ chatId, token: json.content }));
          }
        } catch (e) {
          console.error(`[DEBUG] Error parsing JSON: ${line}`);
        }
      }
    }
  }
  console.log(`[DEBUG] Stream completed for chatId ${chatId}`);
} finally {
  reader.releaseLock();
}
      } catch (err: any) {
        console.error(`[DEBUG] Error in WS handler:`, err);
        ws.send(JSON.stringify({ chatId: -1, error: err.message }));
      }
    });
  });

  app.get("/api/models/:id", async (req, res) => {
    try {
      const url = getLlamaUrl(req.params.id);
      const endpoints = ["/v1/models", "/props", "/models"];
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(`${url}${endpoint}`);
          if (response.ok) {
            const data = await response.json();
            return res.json(data);
          }
        } catch (e) {}
      }
      throw new Error(`Could not fetch model info from any endpoint`);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/status/:id", async (req, res) => {
    try {
      const url = getLlamaUrl(req.params.id);
      const response = await fetch(`${url}/health`);
      if (!response.ok) throw new Error("Offline");
      const data = await response.json();
      res.json({ 
        status: data.status === "ok" ? "online" : "offline",
        cpu_usage: cpuUsageCache[req.params.id] || 0
      });
    } catch (error: any) {
      res.json({ status: "offline", cpu_usage: 0 });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => res.sendFile(path.resolve(__dirname, "dist", "index.html")));
  }

  server.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();