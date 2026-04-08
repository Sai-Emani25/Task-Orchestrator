import * as dotenv from "dotenv";
import path from "path";

// Load .env explicitly from the root directory
const envPath = path.resolve(process.cwd(), ".env");
const result = dotenv.config({ path: envPath, override: true });

if (result.error) {
  console.warn(`[Dotenv] Warning: Could not load .env file from ${envPath}. This is expected if using platform secrets.`);
} else {
  console.log(`[Dotenv] Success: Loaded environment variables from ${envPath}`);
  console.log(`[Dotenv] Keys loaded: ${Object.keys(result.parsed || {}).join(", ")}`);
}

console.log(`[Top-level] GEMINI_API_KEY present: ${!!process.env.GEMINI_API_KEY}`);

import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import cors from "cors";

// Initialize Database
const db = new Database("orchestrator.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_query TEXT,
    priority TEXT,
    manager_reasoning TEXT,
    final_response TEXT,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: Add priority column if it doesn't exist (for existing databases)
try {
  db.prepare("ALTER TABLE interactions ADD COLUMN priority TEXT").run();
} catch (e) {
  // Column likely already exists
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  let apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  
  // Specifically ignore placeholder values
  if (apiKey === "MY_GEMINI_API_KEY" || apiKey === "YOUR_API_KEY_HERE" || !apiKey) {
    console.warn("WARNING: API Key is missing or a placeholder. Attempting to use provided fallback if available.");
    apiKey = ""; 
  }

  if (apiKey) {
    console.log("Initial API Key check: Valid API Key found.");
  } else {
    console.warn("Initial API Key check: No valid API Key found in environment variables.");
  }

  // --- API Endpoints ---

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
