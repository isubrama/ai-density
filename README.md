# Ampere LLM Orchestrator

<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

## Overview

The **Ampere LLM Orchestrator** is a high-performance, high-density platform designed for orchestrating and monitoring multiple Large Language Model (LLM) instances on **Ampere Computing's Cloud-Native CPUs**. 

By leveraging the multi-core architecture of Ampere Altra/Altra Max processors, this application achieves extreme throughput and density, running multiple independent `llama.cpp` servers concurrently—each isolated and pinned to specific CPU core sets.

## Key Features

- **Multi-Instance Orchestration:** Deploy and manage 4+ independent `llama.cpp` server nodes simultaneously.
- **Domain-Specific AI Experts:**
  - **Legal & Compliance:** Regulatory and corporate law specialist.
  - **Cybersecurity:** Threat intelligence and network security architect.
  - **Fintech & Finance:** Algorithmic trading and financial regulation expert.
  - **Supply Chain & Ops:** Global logistics and operational resilience specialist.
- **Real-Time Performance Monitoring:**
  - **Cluster Throughput (TPS):** Aggregate tokens per second across all active instances.
  - **Peak Throughput:** Tracks the highest performance achieved during the session.
  - **Instance-Level Metrics:** Per-chatbot TPS and prompt status tracking.
- **High-Density Execution:** Pinning individual LLM nodes to specific CPU core sets (using `cpuset`) for maximum hardware utilization.
- **One-Click Load Simulation:** A global "Run All" feature that orchestrates 20+ parallel chatbot sessions (5 per instance).

## Architecture

The system consists of a modern full-stack architecture optimized for high-density inference:

- **Frontend:** React (Vite) + Tailwind CSS + Lucide Icons for a professional, real-time monitoring dashboard.
- **Backend:** Node.js (Express) serving as an intelligent API proxy and instance manager.
- **Inference Nodes:** Multiple `llama.cpp` servers running in Docker, each serving GGUF models fetched directly from Hugging Face.

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Ampere-based Cloud Instance (OCI A1, AWS M6g/C6g/R6g, GCP T2A, etc.)
- (Optional) Node.js 18+ for local development

### Deployment with Docker

1. **Clone the repository.**
2. **Configure your environment:**
   Copy `.env.example` to `.env` and adjust the model parameters if needed.
   ```bash
   cp .env.example .env
   ```
3. **Launch the Orchestrator:**
   ```bash
   docker-compose up -d
   ```
4. **Access the UI:**
   Navigate to `http://localhost:3000` to monitor the cluster.

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server (Frontend + Backend proxy):
   ```bash
   npm run dev
   ```

## Configuration

The orchestration is highly configurable via environment variables in the `.env` file:

| Variable | Description |
|----------|-------------|
| `LLAMA_CPP_IMAGE` | The container image for the `llama.cpp` server nodes. |
| `HF_REPO_X` | Hugging Face repository for instance X (1-4). |
| `HF_FILE_X` | Specific GGUF model file for instance X (1-4). |
| `LLAMA_ARG_THREADS` | Number of CPU threads assigned to each `llama.cpp` process. |
| `LLAMA_ARG_CTX_SIZE` | Context window size for each instance. |

## Why Ampere?

Ampere CPUs provide a deterministic, high-core-count environment ideal for LLM density. By avoiding the overhead of multi-threading contention and leveraging large core counts, this orchestrator demonstrates how a single Ampere server can replace several GPU-based nodes for high-throughput, low-cost inference workloads.

---
*Built for High-Efficiency AI on Ampere Computing.*
