import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load prompts from src/prompts.json
const promptsPath = path.resolve(__dirname, "src/prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const SYSTEM_PROMPTS = prompts.system_prompts;

// Global state for CPU usage
const cpuUsageCache: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };

interface ContainerInfo {
  id: string;
  longId: string;
  cgroupPath: string | null;
  lastUsageUsec: number;
  lastTime: number;
}

const containers: Record<string, ContainerInfo> = {};

// Helper to talk to Docker Socket
async function dockerApi(path: string) {
  return new Promise<any>((resolve, reject) => {
    const options = { socketPath: "/var/run/docker.sock", path, method: "GET" };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
          resolve(JSON.parse(data));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Identify containers and their cgroup paths
async function resolveContainers() {
  const dockerContainers = await dockerApi("/containers/json");
  for (let i = 1; i <= 4; i++) {
    const namePattern = `llama-cpp-${i}`;
    const container = dockerContainers.find((c: any) => 
      c.Names.some((n: string) => n.includes(namePattern)) || 
      c.Labels["com.docker.compose.service"] === namePattern
    );

    if (container) {
      const details = await dockerApi(`/containers/${container.Id}/json`);
      const longId = details.Id;
      
      // Common cgroup v2 paths for Docker
      const possiblePaths = [
        `/sys/fs/cgroup/system.slice/docker-${longId}.scope/cpu.stat`,
        `/sys/fs/cgroup/docker/${longId}/cpu.stat`,
        `/sys/fs/cgroup/system.slice/docker-${longId}.scope/cpu.stat`
      ];

      let validPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          validPath = p;
          break;
        }
      }

      containers[i.toString()] = {
        id: i.toString(),
        longId,
        cgroupPath: validPath,
        lastUsageUsec: 0,
        lastTime: Date.now()
      };
      console.log(`Resolved Instance ${i} to container ${longId.substring(0, 12)} (Path: ${validPath})`);
    }
  }
}

function readCpuUsage(cgroupPath: string): number {
  try {
    const content = fs.readFileSync(cgroupPath, "utf8");
    const match = content.match(/usage_usec (\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch (e) {
    return 0;
  }
}

async function pollCpuStats() {
  await resolveContainers();

  setInterval(() => {
    const now = Date.now();
    for (const id in containers) {
      const container = containers[id];
      if (!container.cgroupPath) continue;

      const currentUsageUsec = readCpuUsage(container.cgroupPath);
      const deltaTimeUsec = (now - container.lastTime) * 1000;
      const deltaUsageUsec = currentUsageUsec - container.lastUsageUsec;

      if (deltaTimeUsec > 0 && container.lastUsageUsec > 0) {
        // (Usage Delta / Time Delta) * 100 = % of total system (all cores)
        // Then divide by 32 to get % of the assigned 32-core cpuset
        const utilPercent = (deltaUsageUsec / deltaTimeUsec) * 100 / 32.0;
        cpuUsageCache[id] = Math.min(Math.max(utilPercent, 0), 100.0);
      }

      container.lastUsageUsec = currentUsageUsec;
      container.lastTime = now;
    }
  }, 1000); // Fast 1s polling via direct file reads
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  app.use(express.json());

  console.log("Server starting...");
  pollCpuStats().catch(err => console.error("CPU monitoring initialization failed:", err));

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
          if (response.ok) return res.json(await response.json());
        } catch (e) {}
      }
      res.status(404).json({ error: "Not found" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/status/:id", async (req, res) => {
    try {
      const url = getLlamaUrl(req.params.id);
      const response = await fetch(`${url}/health`);
      const data = response.ok ? await response.json() : { status: "offline" };
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
      res.json(await response.json());
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