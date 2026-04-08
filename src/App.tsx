import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Bot, User, Terminal, Calendar, Database, ChevronRight, Loader2, LogIn, LogOut, Share2 } from "lucide-react";
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, collection, addDoc, query, where, onSnapshot, orderBy, limit, serverTimestamp, User as FirebaseUser } from "./firebase";
import WorkflowVisualizer from "./components/WorkflowVisualizer";
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  priority?: string;
  reasoning?: string;
  toolResults?: any[];
}

interface SubTask {
  title: string;
  status: "Pending" | "In Progress" | "Completed";
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  time?: string;
  priority: "High" | "Medium" | "Low";
  status: "Pending" | "In Progress" | "Completed";
  subTasks: SubTask[];
  dependencies?: string[];
  createdAt: any;
  updatedAt?: any;
}

interface AgentStatus {
  name: string;
  status: "Idle" | "Busy" | "Active";
  lastTask?: string;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([
    { name: "Manager", status: "Idle" },
    { name: "Logistics", status: "Idle" },
    { name: "Data", status: "Idle" },
    { name: "Research", status: "Idle" },
  ]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTasksPanel, setShowTasksPanel] = useState(false);
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [filterPriority, setFilterPriority] = useState<string>("All");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [input, setInput] = useState("");
  const [priority, setPriority] = useState<"High" | "Medium" | "Low">("Medium");
  const [isDemo, setIsDemo] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const calendarTool = {
    name: "manage_calendar",
    description: "Create, list, or delete calendar events and tasks.",
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

  const formatDate = (timestamp: any) => {
    if (!timestamp) return "N/A";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Load history from Firestore
        const qInteractions = query(
          collection(db, "interactions"),
          where("userId", "==", u.uid),
          orderBy("createdAt", "asc"),
          limit(50)
        );
        onSnapshot(qInteractions, (snapshot) => {
          const history = snapshot.docs.map(doc => ({
            id: doc.id,
            role: "assistant" as const,
            content: doc.data().response,
            reasoning: doc.data().reasoning,
            toolResults: JSON.parse(doc.data().metadata || "[]"),
            priority: doc.data().priority,
          }));
          // setMessages(history); // For now, we don't overwrite current session messages
        });

        // Load tasks from Firestore
        const qTasks = query(
          collection(db, "tasks"),
          where("userId", "==", u.uid),
          orderBy("createdAt", "desc")
        );
        onSnapshot(qTasks, (snapshot) => {
          const fetchedTasks = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as Task));
          setTasks(fetchedTasks);
        });
      } else {
        setMessages([]);
        setTasks([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const handleSend = async (overrideInput?: string) => {
    const queryText = overrideInput || input;
    if (!queryText.trim() || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: queryText,
      priority,
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!overrideInput) setInput("");
    setIsLoading(true);

    // Update Agent Statuses
    setAgents(prev => prev.map(a => 
      a.name === "Manager" ? { ...a, status: "Busy", lastTask: queryText } : a
    ));

    try {
      let reasoning = "";
      let toolResults: any[] = [];
      let finalResponseText = "";

      if (isDemo) {
        // Simulated Demo Logic
        const lowerQuery = queryText.toLowerCase();
        if (lowerQuery.includes("calendar") || lowerQuery.includes("meeting") || lowerQuery.includes("schedule")) {
          reasoning = "The user wants to manage their schedule. I will use the Logistics Agent to create a calendar event.";
          let deps: string[] = [];
          if (lowerQuery.includes("after") || lowerQuery.includes("depends on")) {
            deps = ["Previous Task"];
          }
          toolResults.push({ 
            tool: "Logistics", 
            result: `Simulated calendar action: create for ${queryText.split(" ").slice(0, 3).join(" ")} (Priority: ${priority})`,
            args: { action: "create", title: queryText.split(" ").slice(0, 3).join(" "), priority, dependencies: deps }
          });
          finalResponseText = `I've successfully scheduled your task with ${priority} priority. The Logistics Agent has confirmed the entry.`;
        } else if (lowerQuery.includes("note") || lowerQuery.includes("save") || lowerQuery.includes("remember")) {
          reasoning = "The user wants to store information. I will use the Data Agent to save this note.";
          toolResults.push({ tool: "Data", result: "Note saved successfully.", args: { action: "save", content: queryText } });
          finalResponseText = "I've saved that information to your notes database for future retrieval.";
        } else {
          reasoning = "I will analyze the query and provide a general response.";
          finalResponseText = `[DEMO MODE] I received your query: "${queryText}". In a real scenario, I would orchestrate sub-agents to handle this based on your ${priority} priority setting.`;
        }
      } else {
        // 1. Primary Agent (Manager) - Parsing intent and creating plan
        const taskContext = tasks.map(t => `- ${t.title} (Status: ${t.status}, Priority: ${t.priority}, Deps: ${t.dependencies?.join(", ") || "None"})`).join("\n");
        
        const managerResponse = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              role: "user",
              parts: [{ text: `You are the Manager Agent of a Hierarchical Task Orchestrator. 
              Your goal is to parse the user query, explain your reasoning (Chain-of-Thought), and decide which sub-agents/tools to call.
              
              Task Dependencies & Prioritization:
              - Users can define that one task must be completed before another.
              - If a user requests a task that depends on an uncompleted task, flag it as 'Blocked' in your reasoning.
              - If a High priority task depends on a Medium/Low priority task, suggest elevating the blocker's priority.
              - Ensure tasks are scheduled in the correct logical order.
              
              Current Tasks Context:
              ${taskContext || "No active tasks."}
              
              User Query: "${queryText}"
              Requested Priority: "${priority}"
              
              Available Tools:
              - Logistics Agent (manage_calendar): For scheduling and dependencies.
              - Data Agent (manage_notes): For storing information.
              
              Respond in a structured way:
              Reasoning: [Your step-by-step plan. Explain how you are handling dependencies and priorities.]
              Action: [The tool call if needed, or final answer]` }]
            }
          ],
          config: {
            tools: [{ functionDeclarations: [calendarTool, notesTool] }],
          }
        });

        reasoning = managerResponse.text || "Analyzing request...";
        const functionCalls = managerResponse.functionCalls;

        if (functionCalls) {
          for (const call of functionCalls) {
            if (call.name === "manage_calendar") {
              const args = call.args as any;
              // Check for existing blockers in context
              const blockers = (args.dependencies || []).filter((dep: string) => {
                const blockerTask = tasks.find(t => t.title.toLowerCase() === dep.toLowerCase());
                return blockerTask && blockerTask.status !== "Completed";
              });

              toolResults.push({ 
                tool: "Logistics", 
                result: `Simulated calendar action: ${args.action} for ${args.title || 'event'} (Priority: ${args.priority || priority})${blockers.length > 0 ? `. WARNING: Blocked by ${blockers.join(", ")}` : ""}`,
                args: call.args
              });
            } else if (call.name === "manage_notes") {
              const args = call.args as any;
              if (args.action === "save") {
                // We'll handle the actual DB save later in the Firestore block
                toolResults.push({ tool: "Data", result: "Note prepared for storage.", args: call.args });
              } else if (args.action === "search") {
                // For search, we might need a backend call, but let's simulate for now
                toolResults.push({ tool: "Data", result: "Searching notes database...", args: call.args });
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
              Address any dependency blockers or priority conflicts discovered.
              
              User Query: ${queryText}
              Reasoning: ${reasoning}
              Tool Results: ${JSON.stringify(toolResults)}` }]
            }
          ]
        });
        finalResponseText = finalResponse.text || "I've processed your request.";
      }

      // Simulate sub-agent activity based on tool results
      if (toolResults.length > 0) {
        for (const res of toolResults) {
          setAgents(prev => prev.map(a => 
            a.name === res.tool ? { ...a, status: "Active", lastTask: queryText } : a
          ));
          setTimeout(() => {
            setAgents(prev => prev.map(a => 
              a.name === res.tool ? { ...a, status: "Idle" } : a
            ));
          }, 3000);
        }
      }

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: finalResponseText,
        reasoning,
        toolResults,
        priority,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setAgents(prev => prev.map(a => a.name === "Manager" ? { ...a, status: "Idle" } : a));

      // Save to Firestore if logged in
      if (user) {
        await addDoc(collection(db, "interactions"), {
          userId: user.uid,
          query: queryText,
          priority,
          reasoning,
          response: finalResponseText,
          metadata: JSON.stringify(toolResults),
          createdAt: serverTimestamp()
        });

        for (const res of toolResults) {
          if (res.tool === "Logistics" && res.args?.action === "create") {
            const subTasks: SubTask[] = [
              { title: "Identify stakeholders", status: "Completed" },
              { title: "Check availability", status: "Completed" },
              { title: "Finalize time slot", status: "In Progress" },
              { title: "Send invitations", status: "Pending" }
            ];
            
            await addDoc(collection(db, "tasks"), {
              userId: user.uid,
              title: res.args?.title || queryText,
              priority: res.args?.priority || priority,
              status: "In Progress",
              subTasks,
              dependencies: res.args?.dependencies || [],
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          } else if (res.tool === "Data" && res.args?.action === "save") {
            await addDoc(collection(db, "notes"), {
              userId: user.uid,
              content: res.args.content || queryText,
              createdAt: serverTimestamp()
            });
          }
        }
      }
    } catch (error: any) {
      console.error("Error:", error);
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Error: ${error.message || "An unexpected error occurred."}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-gray-100 font-sans">
      {/* Task Details Modal */}
      <AnimatePresence>
        {selectedTask && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="p-6 space-y-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono border ${
                        selectedTask.priority === "High" ? "bg-red-500/10 border-red-500/20 text-red-500" :
                        selectedTask.priority === "Medium" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-500" :
                        "bg-blue-500/10 border-blue-500/20 text-blue-500"
                      }`}>
                        {selectedTask.priority} PRIORITY
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono border ${
                        selectedTask.status === "Completed" ? "bg-green-500/10 border-green-500/20 text-green-500" :
                        selectedTask.status === "In Progress" ? "bg-blue-500/10 border-blue-500/20 text-blue-500" :
                        "bg-gray-500/10 border-gray-500/20 text-gray-500"
                      }`}>
                        {selectedTask.status.toUpperCase()}
                      </span>
                    </div>
                    <h2 className="text-xl font-semibold text-white">{selectedTask.title}</h2>
                  </div>
                  <button 
                    onClick={() => setSelectedTask(null)}
                    className="p-2 hover:bg-white/5 rounded-lg transition-colors text-gray-500 hover:text-white"
                  >
                    <ChevronRight className="w-5 h-5 rotate-90" />
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-[9px] text-gray-600 font-mono uppercase">Created At</p>
                      <p className="text-xs text-gray-400 font-mono">{formatDate(selectedTask.createdAt)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[9px] text-gray-600 font-mono uppercase">Last Updated</p>
                      <p className="text-xs text-gray-400 font-mono">{formatDate(selectedTask.updatedAt)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono uppercase tracking-wider">
                    <Terminal className="w-3 h-3" />
                    Sub-Task Execution
                  </div>
                  <div className="space-y-2">
                    {selectedTask.subTasks.map((sub, i) => (
                      <div key={i} className="flex items-center justify-between p-3 bg-white/5 border border-white/5 rounded-xl">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${
                            sub.status === "Completed" ? "bg-green-500" :
                            sub.status === "In Progress" ? "bg-blue-500 animate-pulse" :
                            "bg-gray-600"
                          }`} />
                          <span className="text-sm text-gray-300">{sub.title}</span>
                        </div>
                        <span className="text-[10px] font-mono text-gray-500">{sub.status}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedTask.dependencies && selectedTask.dependencies.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono uppercase tracking-wider">
                      <Database className="w-3 h-3" />
                      Dependencies
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedTask.dependencies.map((dep, i) => (
                        <div key={i} className="px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400 font-mono">
                          BLOCKER: {dep}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t border-white/5 flex justify-end">
                  <button 
                    onClick={() => setSelectedTask(null)}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-sm font-medium transition-colors"
                  >
                    Close Details
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Workflow Visualization Modal */}
      <AnimatePresence>
        {showWorkflow && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-black/80 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#0a0a0a] border border-white/10 rounded-3xl w-full max-w-6xl h-full max-h-[80vh] overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-[#0f0f0f]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center">
                    <Database className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold tracking-tight">Workflow Topology Visualizer</h2>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest font-mono">Directed Acyclic Graph (DAG) View</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowWorkflow(false)}
                  className="p-2 hover:bg-white/5 rounded-lg transition-colors text-gray-500 hover:text-white"
                >
                  <ChevronRight className="w-5 h-5 rotate-90" />
                </button>
              </div>
              <div className="flex-1 p-6">
                <WorkflowVisualizer tasks={tasks} onTaskClick={(task) => {
                  setSelectedTask(task);
                  setShowWorkflow(false);
                }} />
              </div>
              <div className="p-4 border-t border-white/10 bg-[#0f0f0f] flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-gray-600" />
                    <span className="text-[9px] text-gray-500 font-mono uppercase">Pending</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-[9px] text-gray-500 font-mono uppercase">In Progress</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-[9px] text-gray-500 font-mono uppercase">Completed</span>
                  </div>
                </div>
                <p className="text-[9px] text-gray-600 font-mono uppercase">Drag nodes to rearrange • Click nodes for details</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="border-b border-white/10 p-4 flex items-center justify-between bg-[#0f0f0f]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Terminal className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Hierarchical Task Orchestrator</h1>
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-mono">ADK Framework v1.0</p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <button 
            onClick={() => setIsDemo(!isDemo)}
            className={`px-2 py-1 rounded border text-[10px] font-mono transition-all ${
              isDemo 
                ? "bg-purple-500/20 border-purple-500/50 text-purple-400" 
                : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
            }`}
          >
            DEMO MODE: {isDemo ? "ON" : "OFF"}
          </button>
          <button 
            onClick={() => setShowTasksPanel(!showTasksPanel)}
            className={`flex items-center gap-2 px-2 py-1 rounded border text-[10px] font-mono transition-all ${
              showTasksPanel 
                ? "bg-blue-500/20 border-blue-500/50 text-blue-400" 
                : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
            }`}
          >
            <Calendar className="w-3 h-3" />
            TASKS {tasks.length > 0 && `(${tasks.length})`}
          </button>
          <button 
            onClick={() => setShowAgentsPanel(!showAgentsPanel)}
            className={`flex items-center gap-2 px-2 py-1 rounded border text-[10px] font-mono transition-all ${
              showAgentsPanel 
                ? "bg-green-500/20 border-green-500/50 text-green-400" 
                : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
            }`}
          >
            <Bot className="w-3 h-3" />
            AGENTS
          </button>
          <button 
            onClick={() => setShowWorkflow(!showWorkflow)}
            className={`flex items-center gap-2 px-2 py-1 rounded border text-[10px] font-mono transition-all ${
              showWorkflow 
                ? "bg-orange-500/20 border-orange-500/50 text-orange-400" 
                : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
            }`}
          >
            <Share2 className="w-3 h-3" />
            WORKFLOW
          </button>
          {user ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-2 py-1 bg-white/5 border border-white/10 rounded">
                <img src={user.photoURL || ""} alt="" className="w-4 h-4 rounded-full" />
                <span className="text-[10px] text-gray-400 font-mono truncate max-w-[100px]">{user.displayName}</span>
              </div>
              <button 
                onClick={handleLogout}
                className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-gray-500 hover:text-red-400"
                title="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button 
              onClick={handleLogin}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-[10px] font-semibold transition-all shadow-lg shadow-blue-600/20"
            >
              <LogIn className="w-3.5 h-3.5" />
              LOGIN WITH GOOGLE
            </button>
          )}
        </div>
      </header>

      {/* Main Content Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth"
          >
            {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-8">
            <div className="space-y-4 opacity-50">
              <Bot className="w-12 h-12 text-blue-500 mx-auto" />
              <div>
                <p className="text-lg font-medium">Manager Agent Ready</p>
                <p className="text-sm text-gray-400">Initialize a multi-step task or query logistics.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl w-full px-4">
              {[
                { title: "Schedule Meeting", query: "Schedule a high-priority sync with the engineering team for tomorrow at 2 PM", icon: Calendar },
                { title: "Save Note", query: "Remember that the project deadline has been moved to next Friday", icon: Database },
                { title: "Check Logistics", query: "List all my calendar events for the upcoming week", icon: Terminal },
                { title: "Complex Task", query: "Analyze the latest notes and schedule a follow-up if any deadlines are mentioned", icon: Bot },
              ].map((scenario, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(scenario.query)}
                  className="p-4 bg-[#1a1a1a] border border-white/5 rounded-xl text-left hover:border-blue-500/50 hover:bg-blue-500/5 transition-all group"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <scenario.icon className="w-4 h-4 text-blue-500" />
                    <span className="text-xs font-semibold text-gray-300 group-hover:text-blue-400">{scenario.title}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 line-clamp-2">{scenario.query}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[85%] space-y-2 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <div className="flex items-center gap-2 mb-1">
                  {msg.role === "assistant" ? (
                    <Bot className="w-4 h-4 text-blue-400" />
                  ) : (
                    <User className="w-4 h-4 text-gray-400" />
                  )}
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                    {msg.role === "assistant" ? "Manager Agent" : "User"}
                  </span>
                  {msg.priority && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                      msg.priority === "High" ? "bg-red-500/10 border-red-500/20 text-red-500" :
                      msg.priority === "Medium" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-500" :
                      "bg-blue-500/10 border-blue-500/20 text-blue-500"
                    }`}>
                      {msg.priority}
                    </span>
                  )}
                </div>

                <div className={`p-4 rounded-2xl text-sm leading-relaxed ${
                  msg.role === "user" 
                    ? "bg-blue-600 text-white rounded-tr-none" 
                    : "bg-[#1a1a1a] border border-white/5 rounded-tl-none"
                }`}>
                  {msg.content}
                </div>

                {msg.reasoning && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-2 p-3 bg-[#111] border border-white/5 rounded-xl space-y-2"
                  >
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono uppercase">
                      <ChevronRight className="w-3 h-3" />
                      Chain of Thought
                    </div>
                    <p className="text-xs text-gray-400 italic leading-relaxed">
                      {msg.reasoning}
                    </p>
                  </motion.div>
                )}

                {msg.toolResults && msg.toolResults.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {msg.toolResults.map((res: any, i: number) => (
                      <button 
                        key={i} 
                        onClick={() => {
                          if (res.tool === "Logistics") {
                            const relatedTask = tasks.find(t => t.title === msg.content || t.title.includes(msg.content.substring(0, 20)));
                            if (relatedTask) setSelectedTask(relatedTask);
                          }
                        }}
                        className={`flex items-center gap-2 px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] text-gray-400 transition-colors ${res.tool === "Logistics" ? "hover:bg-blue-500/10 hover:border-blue-500/30 cursor-pointer" : ""}`}
                      >
                        {res.tool === "Logistics" ? <Calendar className="w-3 h-3" /> : <Database className="w-3 h-3" />}
                        {res.tool}: {res.result}
                        {res.tool === "Logistics" && <ChevronRight className="w-2 h-2 opacity-50" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-[#1a1a1a] p-4 rounded-2xl rounded-tl-none border border-white/5 flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
              <span className="text-xs text-gray-400 font-mono animate-pulse">Orchestrating sub-agents...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-4 bg-[#0f0f0f] border-t border-white/10">
        <div className="max-w-4xl mx-auto space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Priority:</span>
            {(["Low", "Medium", "High"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`px-3 py-1 rounded-full text-[10px] font-mono transition-all border ${
                  priority === p 
                    ? (p === "High" ? "bg-red-600 border-red-500 text-white" : 
                       p === "Medium" ? "bg-yellow-600 border-yellow-500 text-white" : 
                       "bg-blue-600 border-blue-500 text-white")
                    : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Command the orchestrator..."
              className="w-full bg-[#1a1a1a] border border-white/10 rounded-xl py-3 pl-4 pr-12 text-sm focus:outline-none focus:border-blue-500/50 transition-colors placeholder:text-gray-600"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg transition-all"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
        <p className="text-[10px] text-center text-gray-600 mt-3 font-mono">
          SECURE AGENT CHANNEL • ENCRYPTED METADATA LOGGING ACTIVE
        </p>
      </div>
    </div>

    {/* Tasks Panel Sidebar */}
    <AnimatePresence>
      {showTasksPanel && (
        <motion.div
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 300, opacity: 0 }}
          className="w-80 border-l border-white/10 bg-[#0f0f0f] flex flex-col"
        >
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Active Tasks</h3>
            <button onClick={() => setShowTasksPanel(false)} className="text-gray-500 hover:text-white">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Filters */}
          <div className="p-4 space-y-4 border-b border-white/10">
            <div className="space-y-2">
              <p className="text-[9px] text-gray-600 font-mono uppercase">Filter Priority</p>
              <div className="flex flex-wrap gap-1">
                {["All", "High", "Medium", "Low"].map(p => (
                  <button
                    key={p}
                    onClick={() => setFilterPriority(p)}
                    className={`px-2 py-1 rounded text-[9px] font-mono border transition-all ${
                      filterPriority === p 
                        ? "bg-blue-600 border-blue-500 text-white" 
                        : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[9px] text-gray-600 font-mono uppercase">Filter Status</p>
              <div className="flex flex-wrap gap-1">
                {["All", "Pending", "In Progress", "Completed"].map(s => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={`px-2 py-1 rounded text-[9px] font-mono border transition-all ${
                      filterStatus === s 
                        ? "bg-blue-600 border-blue-500 text-white" 
                        : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Task List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {tasks
              .filter(t => (filterPriority === "All" || t.priority === filterPriority))
              .filter(t => (filterStatus === "All" || t.status === filterStatus))
              .map(task => (
                <button
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className="w-full p-3 bg-white/5 border border-white/5 rounded-xl text-left hover:border-blue-500/30 transition-all group"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[8px] px-1.5 py-0.5 rounded border font-mono ${
                      task.priority === "High" ? "bg-red-500/10 border-red-500/20 text-red-500" :
                      task.priority === "Medium" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-500" :
                      "bg-blue-500/10 border-blue-500/20 text-blue-500"
                    }`}>
                      {task.priority}
                    </span>
                    <span className="text-[8px] text-gray-600 font-mono">{task.status}</span>
                  </div>
                  <p className="text-xs text-gray-300 font-medium line-clamp-2 group-hover:text-blue-400">{task.title}</p>
                </button>
              ))}
            {tasks.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-30 py-20">
                <Calendar className="w-8 h-8 mb-2" />
                <p className="text-[10px] font-mono uppercase">No tasks found</p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Agents Panel Sidebar */}
    <AnimatePresence>
      {showAgentsPanel && (
        <motion.div
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 300, opacity: 0 }}
          className="w-80 border-l border-white/10 bg-[#0f0f0f] flex flex-col"
        >
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Agent Network</h3>
            <button onClick={() => setShowAgentsPanel(false)} className="text-gray-500 hover:text-white">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {agents.map((agent, i) => (
              <div key={i} className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      agent.status === "Busy" ? "bg-red-500 animate-pulse" :
                      agent.status === "Active" ? "bg-green-500 animate-pulse" :
                      "bg-gray-600"
                    }`} />
                    <span className="text-sm font-semibold text-gray-200">{agent.name} Agent</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                    agent.status === "Busy" ? "bg-red-500/10 border-red-500/20 text-red-500" :
                    agent.status === "Active" ? "bg-green-500/10 border-green-500/20 text-green-500" :
                    "bg-gray-500/10 border-gray-500/20 text-gray-500"
                  }`}>
                    {agent.status.toUpperCase()}
                  </span>
                </div>
                {agent.lastTask && (
                  <div className="space-y-1">
                    <p className="text-[9px] text-gray-600 font-mono uppercase">Current/Last Task</p>
                    <p className="text-[11px] text-gray-400 line-clamp-2 italic">"{agent.lastTask}"</p>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="p-4 border-t border-white/10 bg-black/20">
            <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              HEARTBEAT MONITOR ACTIVE
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  </div>
</div>
  );
}
