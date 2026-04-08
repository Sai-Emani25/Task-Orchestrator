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
if (process.env.GEMINI_API_KEY) {
  console.log(`[Top-level] GEMINI_API_KEY prefix: ${process.env.GEMINI_API_KEY.substring(0, 4)}`);
}

import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
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
    console.log(`Initial API Key check: ${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)} (Length: ${apiKey.length})`);
  } else {
    console.warn("Initial API Key check: No valid API Key found in environment variables.");
  }

  // --- Tools Definitions ---
  
  const calendarTool = {
    name: "manage_calendar",
    description: "Create, list, or delete calendar events.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, enum: ["create", "list", "delete"] },
        title: { type: Type.STRING },
        time: { type: Type.STRING, description: "ISO 8601 format" },
        priority: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
        dependencies: { 
          type: Type.ARRAY, 
          items: { type: Type.STRING },
          description: "List of task titles or IDs that must be completed before this task."
        }
      },
      required: ["action"]
    }
  };

  const notesTool = {
    name: "manage_notes",
    description: "Store or retrieve notes from the database.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, enum: ["save", "search"] },
        content: { type: Type.STRING },
        query: { type: Type.STRING }
      },
      required: ["action"]
    }
  };

  // --- API Endpoints ---

  app.get("/api/debug-env", (req, res) => {
    const key = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
    res.json({
      hasKey: !!key,
      keyPrefix: key ? key.substring(0, 4) : "none",
      keyLength: key ? key.length : 0,
      isPlaceholder: key === "MY_GEMINI_API_KEY" || key === "YOUR_API_KEY_HERE",
      envKeys: Object.keys(process.env).filter(k => k.includes("KEY") || k.includes("API"))
    });
  });

  app.post("/api/execute", async (req, res) => {
    const { query, priority = "Medium", isDemo = false, userId = "anonymous" } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    if (isDemo) {
      // Simulated Demo Logic
      let reasoning = "";
      let toolResults = [];
      let response = "";

      const lowerQuery = query.toLowerCase();
      if (lowerQuery.includes("calendar") || lowerQuery.includes("meeting") || lowerQuery.includes("schedule")) {
        reasoning = "The user wants to manage their schedule. I will use the Logistics Agent to create a calendar event.";
        
        let deps = [];
        if (lowerQuery.includes("after") || lowerQuery.includes("depends on")) {
          deps = ["Previous Task"];
        }

        toolResults.push({ 
          tool: "Logistics", 
          result: `Simulated calendar action: create for ${query.split(" ").slice(0, 3).join(" ")} (Priority: ${priority})`,
          args: {
            action: "create",
            title: query.split(" ").slice(0, 3).join(" "),
            priority,
            dependencies: deps
          }
        });
        response = `I've successfully scheduled your task with ${priority} priority. The Logistics Agent has confirmed the entry.`;
      } else if (lowerQuery.includes("note") || lowerQuery.includes("save") || lowerQuery.includes("remember")) {
        reasoning = "The user wants to store information. I will use the Data Agent to save this note.";
        toolResults.push({ tool: "Data", result: "Note saved successfully." });
        response = "I've saved that information to your notes database for future retrieval.";
      } else {
        reasoning = "I will analyze the query and provide a general response.";
        response = `[DEMO MODE] I received your query: "${query}". In a real scenario, I would orchestrate sub-agents to handle this based on your ${priority} priority setting.`;
      }

      // Store Metadata even in demo
      const stmt = db.prepare("INSERT INTO interactions (user_query, priority, manager_reasoning, final_response, metadata) VALUES (?, ?, ?, ?, ?)");
      stmt.run(query, priority, `[DEMO] ${reasoning}`, response, JSON.stringify(toolResults));

      return res.json({ reasoning, toolResults, response });
    }

    // Ensure we have an API key (only for non-demo)
    let currentApiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
    
    if (currentApiKey === "MY_GEMINI_API_KEY" || currentApiKey === "YOUR_API_KEY_HERE" || !currentApiKey) {
      console.error(`CRITICAL: No valid API Key found at request time. Value: "${currentApiKey ? (currentApiKey.length > 4 ? currentApiKey.substring(0, 4) + '...' : currentApiKey) : 'empty'}"`);
      return res.status(401).json({ error: "API Key is missing or invalid. Please configure it in the Secrets panel." });
    }

    console.log(`Executing request with API Key: ${currentApiKey.substring(0, 4)}...${currentApiKey.substring(currentApiKey.length - 4)}`);
    
    const ai = new GoogleGenAI({ apiKey: currentApiKey });

    try {
      // 1. Primary Agent (Manager) - Parsing intent and creating plan
      const managerResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [{ text: `You are the Manager Agent of a Hierarchical Task Orchestrator. 
            Your goal is to parse the user query, explain your reasoning (Chain-of-Thought), and decide which sub-agents/tools to call.
            
            Task Dependencies:
            Users can define that one task must be completed before another. When creating a task, if the user mentions a dependency, include it in the 'dependencies' field of the Logistics Agent call.
            
            Current Context:
            - User Query: "${query}"
            - Priority Level: "${priority}"
            
            Available Tools:
            - Logistics Agent (manage_calendar)
            - Data Agent (manage_notes)
            
            Respond in a structured way:
            Reasoning: [Your step-by-step plan. IMPORTANT: Consider the priority level when scheduling or managing tasks. High priority tasks should be handled with urgency.]
            Action: [The tool call if needed, or final answer]` }]
          }
        ],
        config: {
          tools: [{ functionDeclarations: [calendarTool, notesTool] }],
          maxOutputTokens: 1024
        }
      });

      const reasoning = managerResponse.text || "Analyzing request...";
      const functionCalls = managerResponse.functionCalls;

      let toolResults = [];
      if (functionCalls) {
        for (const call of functionCalls) {
          // Simulate tool execution
          if (call.name === "manage_calendar") {
            toolResults.push({ 
              tool: "Logistics", 
              result: `Simulated calendar action: ${call.args.action} for ${call.args.title || 'event'} (Priority: ${call.args.priority || priority})`,
              args: call.args
            });
          } else if (call.name === "manage_notes") {
            const { action, content, query: searchParam } = call.args as any;
            if (action === "save" && content) {
              const stmt = db.prepare("INSERT INTO notes (content) VALUES (?)");
              stmt.run(content);
              toolResults.push({ tool: "Data", result: "Note saved successfully.", args: call.args });
            } else if (action === "search" && searchParam) {
              const stmt = db.prepare("SELECT content FROM notes WHERE content LIKE ?");
              const results = stmt.all(`%${searchParam}%`) as { content: string }[];
              toolResults.push({ 
                tool: "Data", 
                result: results.length > 0 
                  ? `Found ${results.length} notes: ${results.map(r => r.content).join(", ")}` 
                  : "No notes found matching the query.",
                args: call.args
              });
            } else {
              toolResults.push({ tool: "Data", result: "Invalid notes action or missing parameters.", args: call.args });
            }
          }
        }
      }

      // 2. Final Consolidation
      const finalResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [{ text: `Consolidate the following into a final user-friendly response.
            User Query: ${query}
            Reasoning: ${reasoning}
            Tool Results: ${JSON.stringify(toolResults)}` }]
          }
        ],
        config: {
          maxOutputTokens: 1024
        }
      });

      // 3. Store Metadata
      const stmt = db.prepare("INSERT INTO interactions (user_query, priority, manager_reasoning, final_response, metadata) VALUES (?, ?, ?, ?, ?)");
      stmt.run(query, priority, reasoning, finalResponse.text, JSON.stringify(toolResults));

      res.json({
        reasoning,
        toolResults,
        response: finalResponse.text
      });

    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

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
