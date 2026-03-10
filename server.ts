import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load prompts from src/prompts.json
const promptsPath = path.resolve(__dirname, "src/prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const SYSTEM_PROMPTS = prompts.system_prompts;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  console.log("Server starting...");
  console.log("NODE_ENV:", process.env.NODE_ENV);

  const getLlamaUrl = (id: string) => {
    const envVar = `LLAMA_API_URL_${id}`;
    return process.env[envVar] || `http://localhost:808${parseInt(id) - 1}`;
  };

  app.get("/api/models/:id", async (req, res) => {
    console.log(`Fetching models for instance ${req.params.id}`);
    try {
      const url = getLlamaUrl(req.params.id);
      // Try common llama.cpp endpoints
      const endpoints = ["/v1/models", "/props", "/models"];
      
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(`${url}${endpoint}`);
          if (response.ok) {
            const data = await response.json();
            return res.json(data);
          }
        } catch (e) {
          // Continue to next endpoint
        }
      }
      
      throw new Error(`Could not fetch model info from any endpoint`);
    } catch (error: any) {
      console.log(`Failed to fetch models for ${req.params.id}: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/status/:id", async (req, res) => {
    console.log(`Status check for instance ${req.params.id}`);
    try {
      const url = getLlamaUrl(req.params.id);
      console.log(`Fetching health from: ${url}/health`);
      const response = await fetch(`${url}/health`);
      if (!response.ok) {
        throw new Error(`llama.cpp API error: ${response.statusText}`);
      }
      const text = await response.text();
      console.log(`Response from ${url}/health: ${text.substring(0, 100)}`);
      const data = JSON.parse(text);
      res.json({ status: data.status === "ok" ? "online" : "offline", details: data });
    } catch (error: any) {
      console.log(`Status check failed for ${req.params.id}: ${error.message}`);
      res.json({ status: "offline", error: error.message });
    }
  });

  app.post("/api/chat/:id", async (req, res) => {
    console.log(`Chat request for instance ${req.params.id}`);
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

      if (!response.ok) {
        throw new Error(`llama.cpp API error: ${response.statusText}`);
      }

      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      console.log(`Chat request failed for ${req.params.id}: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("Setting up Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Serving static files from dist...");
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();