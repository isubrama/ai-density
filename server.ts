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
const cpuUsageCache: Record<string, number> = {
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0
};

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

// Function to update stats for all containers in parallel
async function updateCpuStats() {
  const promises = [1, 2, 3, 4].map(async (i) => {
    try {
      // Try common container name formats
      let stats;
      try {
        stats = await getContainerStats(`ai-density-llama-cpp-${i}-1`);
      } catch (e) {
        stats = await getContainerStats(`llama-cpp-${i}`);
      }
      
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numCpus = stats.cpu_stats.online_cpus || 1;

      if (systemDelta > 0 && cpuDelta > 0) {
        // Normalize to assigned 32 cores for this instance
        const hostPercent = (cpuDelta / systemDelta) * numCpus * 100.0;
        const instancePercent = hostPercent / 32.0;
        cpuUsageCache[i.toString()] = Math.min(instancePercent, 100.0);
      } else {
        cpuUsageCache[i.toString()] = 0;
      }
    } catch (error) {
      cpuUsageCache[i.toString()] = 0;
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