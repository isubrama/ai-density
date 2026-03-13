# Ampere LLM Orchestrator

<div align="center">
<img width="400" alt="Ampere Logo" src="./public/ampere-logo.svg" />
</div>

## Overview

The **Ampere LLM Orchestrator** is a high-performance, high-density platform designed for orchestrating and monitoring multiple Large Language Model (LLM) instances on **AmpereOne® M CPUs**.

By leveraging the high core-count architecture of Ampere processors, this application achieves extreme throughput and density, running multiple independent `llama.cpp` servers concurrently—each isolated and pinned to specific **32-core segments** for deterministic performance.

## Key Features

- **High-Density Orchestration:** Deploy and manage 4 independent `llama.cpp` nodes simultaneously, each with its own dedicated 32-core resources.
- **Domain-Specific AI Experts:**
  - **Legal & Compliance:** Regulatory and corporate law specialist.
  - **Cybersecurity:** Threat intelligence and network security architect.
  - **Fintech & Finance:** Algorithmic trading and financial regulation expert.
  - **Supply Chain & Ops:** Global logistics and operational resilience specialist.
- **Modern Startup UI:** Sleek dark-mode dashboard with real-time performance visualization.
- **Real-Time Performance Metrics:**
  - **Cluster Throughput (TPS):** Aggregate tokens per second across all 20 active workers.
  - **Peak Throughput:** Tracking session-high performance levels.
  - **CPU Load Monitoring:** Real-time utilization stats per container, normalized to the assigned 32-core `cpuset`.
- **Deterministic Compute:** Uses `cpuset` pinning to ensure no resource contention between AI domains.

## Architecture

The system consists of a modern full-stack architecture optimized for high-density inference:

- **Frontend:** React (Vite) + Tailwind CSS + Lucide Icons featuring a glassmorphism "AI Startup" aesthetic.
- **Backend:** Node.js (Express) serving as an intelligent API proxy and performance monitor.
- **Inference Nodes:** 4x `llama.cpp` containers running in Docker, each serving specialized GGUF models.

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Ampere-based Cloud Instance (OCI A1, AWS M6g/C6g/R6g, GCP T2A, etc.)
- Node.js 20+

### Deployment with Docker

1. **Clone the repository.**
2. **Configure your environment:**
   Copy `.env.example` to `.env` and adjust the model parameters.
   ```bash
   cp .env.example .env
   ```
3. **Launch the Orchestrator:**
   ```bash
   docker-compose up -d
   ```
4. **Access the Dashboard:**
   Navigate to `http://localhost:3000` to start the cluster orchestration.

## Configuration

The orchestration is highly configurable via environment variables:

| Variable | Description |
|----------|-------------|
| `HF_REPO_X` | Hugging Face repository for Domain Expert X (1-4). |
| `HF_FILE_X` | Specific GGUF model file for Domain Expert X (1-4). |
| `LLAMA_ARG_THREADS` | Number of CPU threads (default 32) per instance. |
| `cpuset` | Core pinning (e.g., 0-31, 32-63) defined in `docker-compose.yml`. |

## Why Ampere?

AmpereOne® M CPUs provide a deterministic, high-core-count environment ideal for LLM density. By avoiding the overhead of multi-threading contention and leveraging large core counts, this orchestrator demonstrates how a single Ampere server can replace expensive GPU-based infrastructure for high-throughput, low-latency inference workloads.

---
*Built for High-Efficiency AI on Ampere Computing.*
