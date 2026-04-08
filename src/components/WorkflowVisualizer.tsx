import { useEffect, useRef } from "react";
import * as d3 from "d3";
import { Task } from "../App";

interface WorkflowVisualizerProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

interface Node extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  status: string;
  priority: string;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string;
  target: string;
}

export default function WorkflowVisualizer({ tasks, onTaskClick }: WorkflowVisualizerProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || tasks.length === 0) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    // Clear previous content
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current)
      .attr("viewBox", [0, 0, width, height])
      .attr("style", "max-width: 100%; height: auto;");

    // Prepare data
    const nodes: Node[] = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority
    }));

    const links: Link[] = [];
    tasks.forEach(task => {
      if (task.dependencies) {
        task.dependencies.forEach(depTitle => {
          // Find the task ID by title (since dependencies currently store titles in this app)
          const depTask = tasks.find(t => t.title === depTitle);
          if (depTask) {
            links.push({
              source: depTask.id,
              target: task.id
            });
          }
        });
      }
    });

    // Arrowhead marker
    svg.append("defs").append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 25)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#4b5563");

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d: any) => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(0.1))
      .force("y", d3.forceY(height / 2).strength(0.1));

    const link = svg.append("g")
      .attr("stroke", "#374151")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 2)
      .attr("marker-end", "url(#arrowhead)");

    const node = svg.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .call(d3.drag<any, any>()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended) as any)
      .on("click", (event, d) => {
        const task = tasks.find(t => t.id === d.id);
        if (task) onTaskClick(task);
      })
      .style("cursor", "pointer");

    node.append("circle")
      .attr("r", 12)
      .attr("fill", d => {
        if (d.status === "Completed") return "#10b981";
        if (d.status === "In Progress") return "#3b82f6";
        return "#4b5563";
      })
      .attr("stroke", d => {
        const task = tasks.find(t => t.id === d.id);
        const isBlocked = task?.dependencies?.some(depTitle => {
          const depTask = tasks.find(t => t.title === depTitle);
          return depTask && depTask.status !== "Completed";
        });
        return isBlocked ? "#ef4444" : "#000";
      })
      .attr("stroke-width", d => {
        const task = tasks.find(t => t.id === d.id);
        const isBlocked = task?.dependencies?.some(depTitle => {
          const depTask = tasks.find(t => t.title === depTitle);
          return depTask && depTask.status !== "Completed";
        });
        return isBlocked ? 3 : 1.5;
      });

    node.append("text")
      .attr("x", 16)
      .attr("y", 4)
      .text(d => d.title)
      .attr("fill", "#9ca3af")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .attr("class", "pointer-events-none");

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      node
        .attr("transform", (d: any) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: any) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: any) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    return () => simulation.stop();
  }, [tasks, onTaskClick]);

  return (
    <div className="w-full h-full bg-[#050505] relative overflow-hidden rounded-2xl border border-white/5">
      <div className="absolute top-4 left-4 z-10 space-y-1">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Workflow Topology</h4>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-gray-600" />
            <span className="text-[8px] text-gray-600 font-mono uppercase">Pending</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-[8px] text-gray-600 font-mono uppercase">In Progress</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-[8px] text-gray-600 font-mono uppercase">Completed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full border-2 border-red-500" />
            <span className="text-[8px] text-gray-600 font-mono uppercase text-red-500">Blocked</span>
          </div>
        </div>
      </div>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
