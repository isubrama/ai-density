import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load prompts from src/prompts.json
const promptsPath = path.resolve(__dirname, "src/prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const SYSTEM_PROMPTS = prompts.system_prompts;

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

// Global list of connected WS clients
const wsClients = new Set<WebSocket>();

// Function to broadcast message to all connected clients
function broadcast(message: any) {
  const payload = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Function to update stats for all containers in parallel
async function updateCpuStats() {
  const now = process.hrtime.bigint();
  const stats: Record<string, number> = {};
  
  const promises = [1, 2, 3, 4].map(async (i) => {
    try {
      let id = containerIdCache[i.toString()];
      if (!id) {
        // First time, resolve name to ID via Docker API
        let containerStats;
        try {
          containerStats = await getContainerStats(`ai-density-llama-cpp-${i}-1`);
        } catch (e) {
          containerStats = await getContainerStats(`llama-cpp-${i}`);
        }
        id = containerStats.id;
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
          
          cpuUsageCache[i.toString()] = newVal;
          stats[i.toString()] = newVal;
        }
      }
      prevCpuStats[i.toString()] = { containerUsage: usage, time: now };
    } catch (error) {
      cpuUsageCache[i.toString()] = 0;
      stats[i.toString()] = 0;
      delete containerIdCache[i.toString()];
      delete cgroupPathCache[i.toString()];
    }
  });

  await Promise.all(promises);
  
  if (Object.keys(stats).length > 0) {
    broadcast({ type: "stats", data: stats });
  }
}

// Background task to poll CPU stats
async function pollCpuStats() {
  await updateCpuStats();
  setInterval(async () => {
    await updateCpuStats();
  }, 2000); 
}

const getLlamaUrl = (id: string) => {
  const envVar = `LLAMA_API_URL_${id}`;
  return process.env[envVar] || `http://localhost:808${parseInt(id) - 1}`;
};

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(express.json());

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    console.log(`[WS] Client connected. Total clients: ${wsClients.size}`);
    
    // Send initial stats on connection
    ws.send(JSON.stringify({ type: "stats", data: cpuUsageCache }));

    ws.on("message", async (message) => {
      try {
        const payload = JSON.parse(message.toString());
        
        if (payload.type === "chat") {
          const { instanceId, prompt, requestId } = payload;
          const url = getLlamaUrl(instanceId);
          const systemMessage = SYSTEM_PROMPTS[instanceId] || "You are a helpful assistant.";
          
          try {
            const response = await fetch(`${url}/completion`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: `<|im_start|>system\n${systemMessage}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`,
                n_predict: 256,
                stream: false
              })
            });
            const data = await response.json();
            ws.send(JSON.stringify({
              type: "chat_response",
              requestId,
              data
            }));
          } catch (error: any) {
            ws.send(JSON.stringify({
              type: "chat_response",
              requestId,
              error: error.message
            }));
          }
        }
      } catch (e) {
        console.error("[WS] Error processing message:", e);
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[WS] Client disconnected. Total clients: ${wsClients.size}`);
    });
  });

  console.log("Server starting...");
  pollCpuStats().catch(err => console.error("CPU polling failed:", err));

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