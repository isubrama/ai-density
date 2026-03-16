import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Event emitter for stats updates
const statsEmitter = new EventEmitter();
statsEmitter.setMaxListeners(100);

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
          // Normalize to assigned 32 cores
          const instancePercent = hostPercent / 32.0;
          const newVal = Math.min(instancePercent, 100.0);
          
          const oldVal = cpuUsageCache[i.toString()];
          if (oldVal.toFixed(2) !== newVal.toFixed(2)) {
            console.log(`[DEBUG] CPU Usage for llama-cpp-${i} changed: ${oldVal.toFixed(2)}% -> ${newVal.toFixed(2)}%`);
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

  app.post("/api/chat/:id", async (req, res) => {
    try {
      const url = getLlamaUrl(req.params.id);
      const { prompt } = req.body;
      const systemMessage = SYSTEM_PROMPTS[req.params.id] || "You are a helpful assistant.";
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
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => res.sendFile(path.resolve(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();