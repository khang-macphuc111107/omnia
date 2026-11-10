import {
  BarChart3,
  Binary,
  Check,
  Clipboard,
  Code2,
  Download,
  GitBranch,
  History,
  Layers3,
  Play,
  RotateCcw,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

type AlgorithmId = "binary-search" | "two-sum" | "merge-sort" | "bfs" | "dijkstra" | "topological-sort" | "union-find" | "knapsack" | "kruskal-mst";
type AlgorithmTab = "playground" | "trace" | "pseudocode" | "complexity" | "export";
type ExportFormat = "json" | "markdown";
type CodeLanguage = "pseudocode" | "python" | "cpp" | "rust";
type AlgorithmState = {
  algorithm: AlgorithmId;
  numbers: string;
  target: string;
  graph: string;
  directedGraph: string;
  dsuOperations: string;
  start: string;
  goal: string;
  capacity: string;
  weights: string;
  values: string;
  directed: boolean;
  complexityN: string;
};
type TraceStep = { label: string; detail: string; status: "inspect" | "match" | "skip" };
type AlgorithmResult = {
  label: string;
  answer: string;
  summary: string;
  complexity: string;
  memory: string;
  steps: TraceStep[];
  metrics: Array<{ label: string; value: string }>;
};
type HistoryEntry = { id: string; algorithm: AlgorithmId; answer: string; complexity: string };

const initialState: AlgorithmState = {
  algorithm: "binary-search",
  numbers: "1, 3, 5, 7, 9, 13",
  target: "7",
  graph: "A-B:4, A-C:9, B-C:2, B-D:7, C-D:3",
  directedGraph: "A → B, A → C, B → D, C → D",
  dsuOperations: "union(A,B); union(B,C); find(A); connected(A,C); components",
  start: "A",
  goal: "D",
  capacity: "7",
  weights: "2, 3, 4, 5",
  values: "6, 10, 12, 15",
  directed: true,
  complexityN: "64",
};

const algorithmMeta: Record<AlgorithmId, { label: string; description: string; icon: "binary" | "branch" | "layers" | "waypoints" }> = {
  "binary-search": { label: "Binary search", description: "Trace a sorted lookup with low / mid / high bounds.", icon: "binary" },
  "two-sum": { label: "Two-sum hash map", description: "Find a complement in one pass over an integer list.", icon: "branch" },
  "merge-sort": { label: "Merge sort", description: "Split, recursively sort, and merge a list with stable ordering.", icon: "layers" },
  bfs: { label: "BFS traversal", description: "Explore an unweighted graph layer by layer.", icon: "layers" },
  dijkstra: { label: "Dijkstra shortest path", description: "Compare weighted paths with a deterministic priority trace.", icon: "waypoints" },
  "topological-sort": { label: "Topological sort", description: "Order a directed acyclic graph and expose cycle evidence.", icon: "branch" },
  "union-find": { label: "Union-Find · DSU", description: "Replay component unions, representative lookups, and connectivity checks.", icon: "branch" },
  knapsack: { label: "0/1 knapsack", description: "Choose items under a capacity constraint using dynamic programming.", icon: "layers" },
  "kruskal-mst": { label: "Kruskal · MST", description: "Build a minimum spanning tree and expose cycle-rejection decisions.", icon: "waypoints" },
};

const algorithms = Object.keys(algorithmMeta) as AlgorithmId[];
const tabs: AlgorithmTab[] = ["playground", "trace", "pseudocode", "complexity", "export"];
const codeLanguages: Array<{ id: CodeLanguage; label: string }> = [
  { id: "pseudocode", label: "Pseudocode" },
  { id: "python", label: "Python" },
  { id: "cpp", label: "C++" },
  { id: "rust", label: "Rust" },
];

const correctnessNotes: Record<AlgorithmId, { invariant: string; proof: string; edgeCases: string[] }> = {
  "binary-search": {
    invariant: "If target exists, it stays inside the inclusive [low, high] interval.",
    proof: "Each comparison discards a half whose values cannot equal the target; the interval strictly shrinks.",
    edgeCases: ["Empty input", "Duplicate values", "Target below or above every value"],
  },
  "two-sum": {
    invariant: "The map contains every earlier value and its original index.",
    proof: "At index i, checking target − value finds exactly the complement needed for a pair ending at i.",
    edgeCases: ["Repeated values", "Negative numbers", "No valid pair"],
  },
  "merge-sort": {
    invariant: "Each merge step preserves sorted order for the already-consumed prefixes.",
    proof: "The halves are sorted recursively; choosing the smaller head at each merge yields a sorted combined range.",
    edgeCases: ["Empty input", "Duplicate values", "Already sorted input"],
  },
  bfs: {
    invariant: "The queue is processed in nondecreasing distance from the start node.",
    proof: "Every neighbor is enqueued after its parent, so the first visit gives the shortest unweighted distance.",
    edgeCases: ["Disconnected goal", "Self-loop", "Repeated edges"],
  },
  dijkstra: {
    invariant: "The settled node with the smallest tentative distance is final when all weights are nonnegative.",
    proof: "Any alternative route to a settled node would pass through a tentative distance no smaller than the one selected.",
    edgeCases: ["Unreachable goal", "Zero-weight edges", "Negative edge rejected by this preview"],
  },
  "topological-sort": {
    invariant: "A node enters the output only after every incoming edge has been removed.",
    proof: "Kahn's queue contains exactly the zero-indegree frontier; a shorter output than |V| is a directed cycle witness.",
    edgeCases: ["Empty graph", "Multiple valid orders", "Directed cycle"],
  },
  "union-find": {
    invariant: "Each parent pointer leads to a root that represents exactly one connected component.",
    proof: "Union links distinct roots; path compression changes only parent routes, never component membership.",
    edgeCases: ["Repeated union", "Unknown node initialized on first use", "Already-connected query"],
  },
  knapsack: {
    invariant: "dp[c] stores the best value achievable with processed items and capacity at most c.",
    proof: "Descending capacity iteration prevents using the same 0/1 item more than once.",
    edgeCases: ["Capacity zero", "Item heavier than capacity", "Missing value defaults to zero"],
  },
  "kruskal-mst": {
    invariant: "After each accepted edge, the selected forest is acyclic and is a minimum-weight forest for its connected components.",
    proof: "The cut property makes the lightest edge crossing any unresolved cut safe; DSU rejects edges that would close a cycle.",
    edgeCases: ["Disconnected graph produces a forest", "Repeated or equal-weight edges", "Negative weights are accepted in this preview"],
  },
};

function numberList(value: string): number[] {
  return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
}

function numberOf(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function graphEdges(value: string, allowNegative = false): Array<{ from: string; to: string; weight: number }> {
  return value.split(",").flatMap((chunk) => {
    const [pair, weightText] = chunk.trim().split(":");
    if (!pair || !weightText) return [];
    const [from, to] = pair.split("-").map((item) => item.trim());
    const weight = Number(weightText.trim());
    if (!from || !to || !Number.isFinite(weight) || (!allowNegative && weight < 0)) return [];
    return [{ from, to, weight }];
  });
}

function directedEdges(value: string): Array<{ from: string; to: string }> {
  return value.split(",").flatMap((chunk) => {
    const pair = chunk.trim().split(":", 1)[0] ?? "";
    const parts = pair.split(/\s*(?:->|→|>)\s*/);
    const from = parts[0]?.trim();
    const to = parts[1]?.trim();
    return parts.length === 2 && from && to ? [{ from, to }] : [];
  });
}

function adjacency(value: string): Map<string, Array<{ node: string; weight: number }>> {
  const map = new Map<string, Array<{ node: string; weight: number }>>();
  for (const edge of graphEdges(value)) {
    const from = map.get(edge.from) ?? [];
    const to = map.get(edge.to) ?? [];
    from.push({ node: edge.to, weight: edge.weight });
    to.push({ node: edge.from, weight: edge.weight });
    map.set(edge.from, from);
    map.set(edge.to, to);
  }
  return map;
}

function calculate(state: AlgorithmState): AlgorithmResult {
  if (state.algorithm === "binary-search") {
    const values = [...numberList(state.numbers)].sort((a, b) => a - b);
    const target = numberOf(state.target);
    const steps: TraceStep[] = [];
    let low = 0;
    let high = values.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const value = values[mid] ?? 0;
      if (value === target) {
        steps.push({ label: `mid = ${mid}`, detail: `Inspect ${value}; target matched.`, status: "match" });
        found = mid;
        break;
      }
      steps.push({ label: `low ${low} · mid ${mid} · high ${high}`, detail: `Inspect ${value}; move ${value < target ? "low → mid + 1" : "high → mid − 1"}.`, status: "inspect" });
      if (value < target) low = mid + 1;
      else high = mid - 1;
    }
    if (found < 0) steps.push({ label: "Search exhausted", detail: `${target} is not present in the sorted preview.`, status: "skip" });
    return {
      label: "Binary search trace",
      answer: found >= 0 ? `Found at index ${found}` : "Not found",
      summary: `${values.length} sorted values · target ${target}`,
      complexity: "O(log n)",
      memory: "O(1)",
      steps,
      metrics: [{ label: "Comparisons", value: String(steps.filter((step) => step.status !== "skip").length) }, { label: "Sorted input", value: values.join(", ") || "—" }],
    };
  }
  if (state.algorithm === "two-sum") {
    const values = numberList(state.numbers);
    const target = numberOf(state.target);
    const seen = new Map<number, number>();
    const steps: TraceStep[] = [];
    let pair: [number, number] | null = null;
    values.forEach((value, index) => {
      if (pair) return;
      const complement = target - value;
      if (seen.has(complement)) {
        pair = [seen.get(complement) ?? 0, index];
        steps.push({ label: `i = ${index}`, detail: `${value} completes ${complement}; pair found.`, status: "match" });
      } else {
        seen.set(value, index);
        steps.push({ label: `i = ${index}`, detail: `Store ${value}; look for complement ${complement}.`, status: "inspect" });
      }
    });
    return {
      label: "Two-sum hash-map trace",
      answer: pair ? `Pair at indices ${pair[0]} + ${pair[1]}` : "No pair found",
      summary: `${values.length} values · target ${target}`,
      complexity: "O(n)",
      memory: "O(n)",
      steps,
      metrics: [{ label: "Map entries", value: String(seen.size) }, { label: "Target", value: String(target) }],
    };
  }
  if (state.algorithm === "merge-sort") {
    const values = numberList(state.numbers);
    const steps: TraceStep[] = [];
    const sort = (items: number[], depth: number): number[] => {
      if (items.length <= 1) return items;
      const midpoint = Math.floor(items.length / 2);
      const left = sort(items.slice(0, midpoint), depth + 1);
      const right = sort(items.slice(midpoint), depth + 1);
      const merged: number[] = [];
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < left.length || rightIndex < right.length) {
        if (rightIndex >= right.length || (leftIndex < left.length && (left[leftIndex] ?? 0) <= (right[rightIndex] ?? 0))) merged.push(left[leftIndex++] ?? 0);
        else merged.push(right[rightIndex++] ?? 0);
      }
      steps.push({ label: `Depth ${depth} · merge ${left.length} + ${right.length}`, detail: `${left.join(", ") || "∅"} ⟂ ${right.join(", ") || "∅"} → ${merged.join(", ") || "∅"}.`, status: "inspect" });
      return merged;
    };
    const sorted = sort(values, 0);
    if (!values.length) steps.push({ label: "Empty input", detail: "Add comma-separated values to rehearse a merge trace.", status: "skip" });
    return {
      label: "Merge-sort divide-and-conquer trace",
      answer: sorted.length ? sorted.join(", ") : "No values",
      summary: `${values.length} values · stable ascending order`,
      complexity: "O(n log n)",
      memory: "O(n)",
      steps,
      metrics: [{ label: "Input length", value: String(values.length) }, { label: "Merge passes", value: String(steps.filter((step) => step.status !== "skip").length) }],
    };
  }
  if (state.algorithm === "union-find") {
    const parent = new Map<string, string>();
    const size = new Map<string, number>();
    let components = 0;
    let compressedLinks = 0;
    const make = (node: string) => {
      if (!parent.has(node)) { parent.set(node, node); size.set(node, 1); components += 1; }
    };
    const find = (node: string): string => {
      make(node);
      let root = node;
      while (parent.get(root) !== root) root = parent.get(root) ?? root;
      let current = node;
      while (current !== root) {
        const next = parent.get(current) ?? root;
        if (next !== root) compressedLinks += 1;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const steps: TraceStep[] = [];
    for (const rawOperation of state.dsuOperations.split(";")) {
      const operation = rawOperation.trim();
      if (!operation) continue;
      const unionMatch = /^union\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)$/i.exec(operation);
      const findMatch = /^find\(\s*([^,()]+)\s*\)$/i.exec(operation);
      const connectedMatch = /^connected\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)$/i.exec(operation);
      if (unionMatch) {
        const first = unionMatch[1]?.trim(); const second = unionMatch[2]?.trim();
        if (!first || !second) continue;
        let leftRoot = find(first); let rightRoot = find(second);
        if (leftRoot === rightRoot) {
          steps.push({ label: `union(${first}, ${second})`, detail: `Already connected through representative ${leftRoot}; component count stays ${components}.`, status: "skip" });
          continue;
        }
        if ((size.get(leftRoot) ?? 1) < (size.get(rightRoot) ?? 1)) [leftRoot, rightRoot] = [rightRoot, leftRoot];
        parent.set(rightRoot, leftRoot);
        size.set(leftRoot, (size.get(leftRoot) ?? 1) + (size.get(rightRoot) ?? 1));
        components -= 1;
        steps.push({ label: `union(${first}, ${second})`, detail: `Attach root ${rightRoot} under ${leftRoot}; ${components} component(s) remain.`, status: "inspect" });
      } else if (findMatch?.[1]) {
        const node = findMatch[1].trim();
        steps.push({ label: `find(${node})`, detail: `Representative is ${find(node)}.`, status: "match" });
      } else if (connectedMatch?.[1] && connectedMatch[2]) {
        const first = connectedMatch[1].trim(); const second = connectedMatch[2].trim();
        const firstRoot = find(first); const secondRoot = find(second);
        steps.push({ label: `connected(${first}, ${second})`, detail: firstRoot === secondRoot ? `Yes · representative ${firstRoot}.` : `No · representatives ${firstRoot} and ${secondRoot}.`, status: firstRoot === secondRoot ? "match" : "skip" });
      } else if (/^components$/i.test(operation)) {
        const groups = new Map<string, string[]>();
        for (const node of parent.keys()) { const root = find(node); groups.set(root, [...(groups.get(root) ?? []), node]); }
        const summary = [...groups.values()].map((group) => group.sort().join(" / ")).sort().join(" · ") || "No nodes yet";
        steps.push({ label: "components", detail: `${components} component(s): ${summary}.`, status: "inspect" });
      } else {
        steps.push({ label: `Unrecognized: ${operation}`, detail: "Use semicolon-separated union(a,b), find(a), connected(a,b), or components operations.", status: "skip" });
      }
    }
    const groups = new Map<string, string[]>();
    for (const node of parent.keys()) { const root = find(node); groups.set(root, [...(groups.get(root) ?? []), node]); }
    const partition = [...groups.values()].map((group) => group.sort().join(" / ")).sort().join(" · ");
    return {
      label: "Union-Find operation trace",
      answer: partition || "No nodes initialized",
      summary: `${components} component(s) · ${parent.size} node(s) initialized`,
      complexity: "Amortized O(α(n)) per operation",
      memory: "O(n)",
      steps: steps.length ? steps : [{ label: "No operations", detail: "Add semicolon-separated DSU operations to start a preview.", status: "skip" }],
      metrics: [{ label: "Components", value: String(components) }, { label: "Nodes", value: String(parent.size) }, { label: "Compressed links", value: String(compressedLinks) }],
    };
  }
  if (state.algorithm === "knapsack") {
    const weights = numberList(state.weights);
    const values = numberList(state.values);
    const capacity = Math.max(0, Math.floor(numberOf(state.capacity)));
    const dp = Array.from({ length: capacity + 1 }, () => 0);
    const steps: TraceStep[] = [];
    weights.forEach((weight, index) => {
      const value = values[index] ?? 0;
      for (let current = capacity; current >= weight; current -= 1) dp[current] = Math.max(dp[current] ?? 0, (dp[current - weight] ?? 0) + value);
      steps.push({ label: `Item ${index + 1}`, detail: `weight ${weight}, value ${value}; best at capacity ${capacity} is ${dp[capacity] ?? 0}.`, status: "inspect" });
    });
    return {
      label: "0/1 knapsack DP trace",
      answer: `Best value ${dp[capacity] ?? 0}`,
      summary: `${weights.length} items · capacity ${capacity}`,
      complexity: "O(n · C)",
      memory: "O(C)",
      steps,
      metrics: [{ label: "Capacity", value: String(capacity) }, { label: "DP states", value: String(dp.length) }],
    };
  }
  if (state.algorithm === "kruskal-mst") {
    const edges = graphEdges(state.graph, true)
      .map((edge, index) => ({ ...edge, index }))
      .sort((left, right) => left.weight - right.weight || left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.index - right.index);
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();
    const make = (node: string) => {
      if (!parent.has(node)) { parent.set(node, node); rank.set(node, 0); }
    };
    const find = (node: string): string => {
      make(node);
      const root = parent.get(node) ?? node;
      if (root === node) return node;
      const representative = find(root);
      parent.set(node, representative);
      return representative;
    };
    const union = (first: string, second: string): boolean => {
      let leftRoot = find(first);
      let rightRoot = find(second);
      if (leftRoot === rightRoot) return false;
      if ((rank.get(leftRoot) ?? 0) < (rank.get(rightRoot) ?? 0)) [leftRoot, rightRoot] = [rightRoot, leftRoot];
      parent.set(rightRoot, leftRoot);
      if ((rank.get(leftRoot) ?? 0) === (rank.get(rightRoot) ?? 0)) rank.set(leftRoot, (rank.get(leftRoot) ?? 0) + 1);
      return true;
    };
    const steps: TraceStep[] = [];
    const selected: Array<{ from: string; to: string; weight: number }> = [];
    let totalWeight = 0;
    for (const edge of edges) {
      const accepted = union(edge.from, edge.to);
      if (accepted) {
        selected.push(edge);
        totalWeight += edge.weight;
        steps.push({ label: `Accept ${edge.from} — ${edge.to} (${edge.weight})`, detail: `Connect two components; ${selected.length} edge(s) selected so far.`, status: "match" });
      } else {
        steps.push({ label: `Reject ${edge.from} — ${edge.to} (${edge.weight})`, detail: "Both endpoints already share a representative; accepting this edge would create a cycle.", status: "skip" });
      }
    }
    const nodeCount = parent.size;
    const componentRoots = new Set([...parent.keys()].map((node) => find(node)));
    const disconnected = componentRoots.size > 1;
    const chosen = selected.map((edge) => `${edge.from}—${edge.to} (${edge.weight})`).join(" + ");
    if (!edges.length) steps.push({ label: "No graph edges", detail: "Add weighted edges such as A-B:4, B-C:2, C-D:3 to build a preview forest.", status: "skip" });
    return {
      label: "Kruskal minimum-spanning-tree trace",
      answer: selected.length ? `${disconnected ? "Forest" : "MST"} weight ${totalWeight}` : "No spanning edges",
      summary: `${nodeCount} nodes · ${selected.length} selected edge(s)${disconnected ? " · disconnected forest" : ""}`,
      complexity: "O(E log E)",
      memory: "O(V)",
      steps: steps.length ? steps : [{ label: "No graph edges", detail: "Add weighted edges to start a Kruskal rehearsal.", status: "skip" }],
      metrics: [{ label: "Selected edges", value: String(selected.length) }, { label: "Total weight", value: String(totalWeight) }, { label: "Components", value: String(componentRoots.size) }, { label: "Edges considered", value: String(edges.length) }, { label: "Selection", value: chosen || "—" }],
    };
  }
  if (state.algorithm === "topological-sort") {
    if (!state.directed) {
      return {
        label: "Topological-sort Kahn trace",
        answer: "Enable directed graph",
        summary: "Topological ordering requires directed edges.",
        complexity: "O(V + E)",
        memory: "O(V)",
        steps: [{ label: "Directed mode disabled", detail: "Turn on Directed graph rehearsal to inspect indegrees and cycle evidence.", status: "skip" }],
        metrics: [{ label: "Ordered nodes", value: "0" }, { label: "Cycle", value: "Not evaluated" }],
      };
    }
    const arcs = directedEdges(state.directedGraph);
    const nodes = new Set<string>();
    const outgoing = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const edge of arcs) {
      nodes.add(edge.from); nodes.add(edge.to);
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
      if (!indegree.has(edge.from)) indegree.set(edge.from, 0);
    }
    const queue = [...nodes].filter((node) => (indegree.get(node) ?? 0) === 0).sort();
    const order: string[] = [];
    const steps: TraceStep[] = [];
    while (queue.length) {
      const node = queue.shift() as string;
      order.push(node);
      steps.push({ label: `Emit ${node}`, detail: `Remove outgoing edges to ${(outgoing.get(node) ?? []).join(", ") || "no neighbors"}.`, status: "inspect" });
      for (const neighbor of outgoing.get(node) ?? []) {
        const next = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, next);
        if (next === 0) queue.push(neighbor);
      }
      queue.sort();
    }
    const hasCycle = order.length !== nodes.size;
    if (hasCycle) steps.push({ label: "Cycle detected", detail: `${nodes.size - order.length} node(s) never reached zero indegree.`, status: "skip" });
    if (!nodes.size) steps.push({ label: "Empty graph", detail: "Add directed edges such as A-B:1, A-C:1, B-D:1.", status: "skip" });
    return {
      label: "Topological-sort Kahn trace",
      answer: hasCycle ? "Cycle detected" : order.length ? order.join(" → ") : "No nodes",
      summary: `${nodes.size} nodes · ${arcs.length} directed edges`,
      complexity: "O(V + E)",
      memory: "O(V)",
      steps,
      metrics: [{ label: "Ordered nodes", value: String(order.length) }, { label: "Cycle", value: hasCycle ? "Yes" : "No" }],
    };
  }
  const graph = adjacency(state.graph);
  const start = state.start.trim() || "A";
  const goal = state.goal.trim() || "D";
  const steps: TraceStep[] = [];
  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  const queue = [start];
  const visited = new Set<string>();
  const weighted = state.algorithm === "dijkstra";
  while (queue.length) {
    let current: string | undefined;
    if (weighted) {
      // Remove the selected node from the actual queue. Sorting a copied
      // array here leaves `queue` unchanged and makes Dijkstra loop forever
      // on the first queued node.
      let bestIndex = 0;
      for (let index = 1; index < queue.length; index += 1) {
        if ((distances.get(queue[index]!) ?? Infinity) < (distances.get(queue[bestIndex]!) ?? Infinity)) bestIndex = index;
      }
      current = queue.splice(bestIndex, 1)[0];
    } else {
      current = queue.shift();
    }
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const distance = distances.get(current) ?? 0;
    steps.push({ label: `Visit ${current}`, detail: `${weighted ? `distance ${distance}` : `layer ${distance}`}; inspect ${graph.get(current)?.length ?? 0} neighbor(s).`, status: current === goal ? "match" : "inspect" });
    if (current === goal) break;
    for (const neighbor of graph.get(current) ?? []) {
      const candidate = weighted ? distance + neighbor.weight : distance + 1;
      if (candidate < (distances.get(neighbor.node) ?? Infinity)) {
        distances.set(neighbor.node, candidate);
        previous.set(neighbor.node, current);
        queue.push(neighbor.node);
      }
    }
  }
  const path: string[] = [];
  if (distances.has(goal)) {
    let cursor: string | undefined = goal;
    while (cursor) {
      path.unshift(cursor);
      cursor = previous.get(cursor);
    }
  }
  const resultName = weighted ? "Dijkstra shortest-path trace" : "BFS traversal trace";
  return {
    label: resultName,
    answer: path.length ? `${path.join(" → ")} · cost ${distances.get(goal) ?? 0}` : "Goal unreachable",
    summary: `${graph.size} nodes · ${start} → ${goal}`,
    complexity: weighted ? "O((V + E) log V)" : "O(V + E)",
    memory: "O(V)",
    steps: steps.length ? steps : [{ label: "No graph edges", detail: "Add edges such as A-B:4, B-C:2 to run the preview.", status: "skip" }],
    metrics: [{ label: "Visited", value: String(visited.size) }, { label: "Edges", value: String(graphEdges(state.graph).length) }],
  };
}

function pseudocodeFor(algorithm: AlgorithmId, language: CodeLanguage): string {
  const pseudo: Record<AlgorithmId, string> = {
    "binary-search": [
      "low ← 0; high ← length(values) − 1",
      "while low ≤ high:",
      "  mid ← floor((low + high) / 2)",
      "  if values[mid] = target: return mid",
      "  if values[mid] < target: low ← mid + 1",
      "  else: high ← mid − 1",
      "return NOT_FOUND",
    ].join("\n"),
    "two-sum": [
      "seen ← empty map",
      "for each (value, index):",
      "  complement ← target − value",
      "  if complement in seen: return (seen[complement], index)",
      "  seen[value] ← index",
      "return NO_PAIR",
    ].join("\n"),
    "merge-sort": [
      "if length(values) ≤ 1: return values",
      "mid ← floor(length(values) / 2)",
      "left ← merge_sort(values[0..mid])",
      "right ← merge_sort(values[mid..end])",
      "return merge(left, right) in ascending order",
    ].join("\n"),
    bfs: [
      "queue ← [start]; distance[start] ← 0",
      "while queue is not empty:",
      "  node ← queue.pop_front()",
      "  for neighbor in graph[node]:",
      "    if neighbor is unseen:",
      "      distance[neighbor] ← distance[node] + 1",
      "      queue.push_back(neighbor)",
      "return distance[goal] or UNREACHABLE",
    ].join("\n"),
    dijkstra: [
      "distance[start] ← 0; priority_queue ← {(0, start)}",
      "while priority_queue is not empty:",
      "  (cost, node) ← priority_queue.pop_min()",
      "  if cost ≠ distance[node]: continue",
      "  for (neighbor, weight) in graph[node]:",
      "    candidate ← cost + weight",
      "    if candidate < distance[neighbor]: relax and push",
      "return shortest path or UNREACHABLE",
    ].join("\n"),
    "topological-sort": [
      "indegree ← count incoming edges for every node",
      "queue ← all nodes with indegree = 0",
      "while queue is not empty:",
      "  node ← queue.pop_front(); output node",
      "  for neighbor in outgoing[node]: decrement indegree",
      "    if indegree[neighbor] = 0: queue.push_back(neighbor)",
      "if output has fewer than |V| nodes: return CYCLE",
    ].join("\n"),
    "union-find": [
      "find(x):",
      "  if parent[x] ≠ x: parent[x] ← find(parent[x])",
      "  return parent[x]",
      "union(a, b):",
      "  root_a ← find(a); root_b ← find(b)",
      "  if root_a ≠ root_b: attach smaller tree under larger",
      "connected(a, b) ← find(a) = find(b)",
    ].join("\n"),
    knapsack: [
      "dp[0..capacity] ← 0",
      "for each (weight, value):",
      "  for c from capacity down to weight:",
      "    dp[c] ← max(dp[c], dp[c − weight] + value)",
      "return dp[capacity]",
    ].join("\n"),
    "kruskal-mst": [
      "sort edges by nondecreasing weight",
      "dsu.make_set(each endpoint)",
      "for edge (u, v, weight) in sorted edges:",
      "  if find(u) ≠ find(v):",
      "    accept edge; union(u, v)",
      "return accepted edges and total weight",
    ].join("\n"),
  };
  const source = pseudo[algorithm];
  if (language === "pseudocode") return source;
  const lines = source.split("\n");
  if (language === "python") return lines.map((line) => line.replaceAll("←", "=").replaceAll("≠", "!=").replaceAll("≤", "<=").replaceAll("≥", ">=").replace(/NOT_FOUND|NO_PAIR|UNREACHABLE/g, "None")).join("\n");
  if (language === "cpp") return lines.map((line) => line.replaceAll("←", "=").replaceAll("≠", "!=").replaceAll("≤", "<=").replaceAll("≥", ">=").replace(/NOT_FOUND|NO_PAIR|UNREACHABLE/g, "-1")).join("\n");
  return lines.map((line) => line.replaceAll("←", "=").replaceAll("≠", "!=").replaceAll("≤", "<=").replaceAll("≥", ">=").replace(/NOT_FOUND|NO_PAIR|UNREACHABLE/g, "None")).join("\n");
}

function iconFor(kind: (typeof algorithmMeta)[AlgorithmId]["icon"]) {
  if (kind === "binary") return <Binary size={15} />;
  if (kind === "branch") return <GitBranch size={15} />;
  if (kind === "waypoints") return <Waypoints size={15} />;
  return <Layers3 size={15} />;
}

function inputFields(state: AlgorithmState, update: <K extends keyof AlgorithmState>(key: K, value: AlgorithmState[K]) => void) {
  if (state.algorithm === "binary-search" || state.algorithm === "two-sum") return <div className="algorithm-lab__input-grid"><label><span>Numbers</span><input aria-label="Algorithm numbers" value={state.numbers} onChange={(event) => update("numbers", event.target.value)} /></label><label><span>Target</span><input aria-label="Algorithm target" inputMode="decimal" value={state.target} onChange={(event) => update("target", event.target.value)} /></label></div>;
  if (state.algorithm === "merge-sort") return <div className="algorithm-lab__input-grid"><label className="algorithm-lab__field--wide"><span>Numbers <small>comma-separated; stable ascending output</small></span><input aria-label="Algorithm numbers" value={state.numbers} onChange={(event) => update("numbers", event.target.value)} /></label></div>;
  if (state.algorithm === "bfs" || state.algorithm === "dijkstra") return <div className="algorithm-lab__input-grid"><label className="algorithm-lab__field--wide"><span>Edges <small>format: A-B:4, B-C:2</small></span><input aria-label="Graph edges" value={state.graph} onChange={(event) => update("graph", event.target.value)} /></label><label><span>Start node</span><input aria-label="Graph start node" value={state.start} onChange={(event) => update("start", event.target.value)} /></label><label><span>Goal node</span><input aria-label="Graph goal node" value={state.goal} onChange={(event) => update("goal", event.target.value)} /></label></div>;
  if (state.algorithm === "kruskal-mst") return <div className="algorithm-lab__input-grid"><label className="algorithm-lab__field--wide"><span>Weighted undirected edges <small>format: A-B:4, B-C:2 · sorted by weight in the preview</small></span><input aria-label="Graph edges" value={state.graph} onChange={(event) => update("graph", event.target.value)} /></label></div>;
  if (state.algorithm === "topological-sort") return <div className="algorithm-lab__input-grid"><label className="algorithm-lab__field--wide"><span>Directed edges <small>format: A → B, A → C, B → D</small></span><input aria-label="Directed graph edges" value={state.directedGraph} onChange={(event) => update("directedGraph", event.target.value)} /></label><label className="algorithm-lab__toggle"><input type="checkbox" aria-label="Treat graph as directed" checked={state.directed} onChange={(event) => update("directed", event.target.checked)} /><span>Directed graph rehearsal</span></label></div>;
  if (state.algorithm === "union-find") return <div className="algorithm-lab__input-grid"><label className="algorithm-lab__field--wide"><span>Operations <small>separate with semicolons: union(A,B); find(A); connected(A,B); components</small></span><input aria-label="Union-Find operations" value={state.dsuOperations} onChange={(event) => update("dsuOperations", event.target.value)} /></label></div>;
  return <div className="algorithm-lab__input-grid"><label><span>Weights</span><input aria-label="Knapsack weights" value={state.weights} onChange={(event) => update("weights", event.target.value)} /></label><label><span>Values</span><input aria-label="Knapsack values" value={state.values} onChange={(event) => update("values", event.target.value)} /></label><label><span>Capacity</span><input aria-label="Knapsack capacity" inputMode="numeric" value={state.capacity} onChange={(event) => update("capacity", event.target.value)} /></label></div>;
}

export function AlgorithmLabPreview() {
  const [state, setState] = useState<AlgorithmState>(initialState);
  const [tab, setTab] = useState<AlgorithmTab>("playground");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [codeLanguage, setCodeLanguage] = useState<CodeLanguage>("pseudocode");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState("Ready for a deterministic algorithm rehearsal.");
  const result = useMemo(() => calculate(state), [state]);
  const codeSnippet = useMemo(() => pseudocodeFor(state.algorithm, codeLanguage), [codeLanguage, state.algorithm]);
  const notes = correctnessNotes[state.algorithm];
  const complexityN = Math.max(1, numberOf(state.complexityN, 64));
  const complexityRows = useMemo(() => [
    { label: "Constant", notation: "O(1)", operations: 1 },
    { label: "Binary search", notation: "O(log n)", operations: Math.max(1, Math.ceil(Math.log2(complexityN))) },
    { label: "Linear scan", notation: "O(n)", operations: complexityN },
    { label: "Nested loop", notation: "O(n²)", operations: complexityN ** 2 },
    { label: "Subset DP", notation: "O(2ⁿ)", operations: Math.min(999_999, 2 ** Math.min(20, complexityN)) },
  ], [complexityN]);
  const payload = useMemo(() => {
    const data = { schema: "omnia.algorithm-lab.preview.v1", scope: "renderer-session", state, result, complexityRows, history, code: { language: codeLanguage, source: codeSnippet }, correctness: notes };
    if (format === "json") return JSON.stringify(data, null, 2);
    const fence = "```";
    return `# Omnia Algorithm & CP Lab preview\n\n- Algorithm: ${algorithmMeta[state.algorithm].label}\n- Answer: ${result.answer}\n- Complexity: ${result.complexity}\n- Memory: ${result.memory}\n- Code language: ${codeLanguages.find((entry) => entry.id === codeLanguage)?.label ?? codeLanguage}\n\n## Pseudocode / reference snippet\n\n${fence}${codeLanguage}\n${codeSnippet}\n${fence}\n\n## Trace\n\n${result.steps.map((step) => `- **${step.label}** — ${step.detail}`).join("\n")}\n\n## Correctness notes\n\n- Invariant: ${notes.invariant}\n- Proof sketch: ${notes.proof}\n- Edge cases: ${notes.edgeCases.join(", ")}\n\nRenderer-local preview; no code execution, compiler, provider request, or durable write.\n`;
  }, [codeLanguage, codeSnippet, complexityRows, format, history, notes, result, state]);
  const update = <K extends keyof AlgorithmState>(key: K, value: AlgorithmState[K]) => setState((current) => ({ ...current, [key]: value }));
  const run = () => {
    setHistory((current) => [{ id: `${Date.now()}-${state.algorithm}`, algorithm: state.algorithm, answer: result.answer, complexity: result.complexity }, ...current.filter((entry) => entry.algorithm !== state.algorithm)].slice(0, 5));
    setStatus(`${result.label} calculated in the browser preview.`);
    setTab("trace");
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    setTab(nextTab);
    document.getElementById(`algorithm-lab-tab-${nextTab}`)?.focus();
  };
  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; nothing was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} algorithm preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); }
  };
  const copySnippet = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; snippet was not copied."); return; }
    try { await navigator.clipboard.writeText(codeSnippet); setStatus(`Copied ${codeLanguages.find((entry) => entry.id === codeLanguage)?.label ?? codeLanguage} reference snippet.`); } catch { setStatus("Clipboard access was denied; snippet was not copied."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `omnia-algorithm-lab-preview.${format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(url); setStatus("Downloaded a renderer-local algorithm preview.");
  };

  return <section className="algorithm-lab" aria-labelledby="algorithm-lab-heading">
    <header className="algorithm-lab__header"><div><span className="eyebrow">Algorithms · CP · data structures</span><h2 id="algorithm-lab-heading">Algorithm &amp; CP Lab</h2><p>Rehearse common patterns with editable inputs, inspectable traces, and complexity comparisons.</p></div><span className="algorithm-lab__badge"><Sparkles size={13} /> Preview only</span></header>
    <div className="algorithm-lab__algorithm-grid" role="list" aria-label="Algorithm presets">{algorithms.map((entry) => <button key={entry} type="button" className={`algorithm-lab__algorithm ${state.algorithm === entry ? "is-active" : ""}`} aria-pressed={state.algorithm === entry} onClick={() => { setState((current) => ({ ...current, algorithm: entry })); setStatus(`Selected ${algorithmMeta[entry].label} preview.`); }}><span className="algorithm-lab__algorithm-icon">{iconFor(algorithmMeta[entry].icon)}</span><span><strong>{algorithmMeta[entry].label}</strong><small>{algorithmMeta[entry].description}</small></span></button>)}</div>
    <nav className="algorithm-lab__tabs" role="tablist" aria-label="Algorithm lab views">{tabs.map((entry, index) => <button key={entry} id={`algorithm-lab-tab-${entry}`} type="button" role="tab" aria-selected={tab === entry} aria-controls={`algorithm-lab-panel-${entry}`} tabIndex={tab === entry ? 0 : -1} className={tab === entry ? "is-active" : ""} onClick={() => setTab(entry)} onKeyDown={(event) => moveTab(event, index)}>{entry === "playground" ? <Code2 size={14} /> : entry === "trace" ? <Play size={14} /> : entry === "pseudocode" ? <Code2 size={14} /> : entry === "complexity" ? <BarChart3 size={14} /> : <Clipboard size={14} />}{entry.charAt(0).toUpperCase() + entry.slice(1)}</button>)}</nav>
    {tab === "playground" ? <div id="algorithm-lab-panel-playground" className="algorithm-lab__layout" role="tabpanel" aria-labelledby="algorithm-lab-tab-playground" tabIndex={0}><div className="algorithm-lab__card"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Inputs</span><h3>{algorithmMeta[state.algorithm].label}</h3></div><span className="algorithm-lab__domain">Editable rehearsal</span></div>{inputFields(state, update)}<div className="algorithm-lab__actions"><button type="button" className="button button--secondary" onClick={run}><Play size={13} /> Run preview</button><button type="button" className="button button--ghost" onClick={() => { setState(initialState); setHistory([]); setStatus("Algorithm lab preview reset."); }}><RotateCcw size={13} /> Reset</button></div><p className="algorithm-lab__boundary"><Sparkles size={14} /> No compiler, interpreter, terminal, provider request, filesystem read, or durable write is involved.</p></div><aside className="algorithm-lab__card algorithm-lab__result"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Result card</span><h3>{result.label}</h3></div><Check size={16} /></div><strong className="algorithm-lab__value">{result.answer}</strong><p>{result.summary}</p><div className="algorithm-lab__result-meta"><span><b>Time</b>{result.complexity}</span><span><b>Space</b>{result.memory}</span></div><div className="algorithm-lab__metrics">{result.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}</div></aside></div> : null}
    {tab === "trace" ? <div id="algorithm-lab-panel-trace" className="algorithm-lab__trace-layout" role="tabpanel" aria-labelledby="algorithm-lab-tab-trace" tabIndex={0}><section className="algorithm-lab__card"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Inspectable execution plan</span><h3>{result.answer}</h3></div><span className="algorithm-lab__domain">{result.steps.length} steps</span></div><ol className="algorithm-lab__trace" aria-label="Algorithm trace">{result.steps.map((step, index) => <li key={`${step.label}-${index}`} className={`algorithm-lab__trace-step algorithm-lab__trace-step--${step.status}`}><span>{index + 1}</span><div><strong>{step.label}</strong><p>{step.detail}</p></div></li>)}</ol></section><aside className="algorithm-lab__card"><span className="eyebrow">Pattern notes</span><h3>What to inspect</h3><ul className="algorithm-lab__notes"><li>Invariant: each step narrows or expands a known search state.</li><li>Evidence: only deterministic local inputs are shown.</li><li>Next: connect a real compiler/runtime in a later native phase.</li></ul><p className="algorithm-lab__boundary">This trace is a rehearsal, not an executed program or proof of runtime performance.</p></aside></div> : null}
    {tab === "pseudocode" ? <div id="algorithm-lab-panel-pseudocode" className="algorithm-lab__pseudocode-layout" role="tabpanel" aria-labelledby="algorithm-lab-tab-pseudocode" tabIndex={0}><section className="algorithm-lab__card"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Reference implementation</span><h3>{algorithmMeta[state.algorithm].label}</h3></div><label className="algorithm-lab__inline-field"><span>Language</span><select aria-label="Algorithm pseudocode language" value={codeLanguage} onChange={(event) => setCodeLanguage(event.target.value as CodeLanguage)}>{codeLanguages.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label></div><pre className="algorithm-lab__code-preview" tabIndex={0}><code>{codeSnippet}</code></pre><div className="algorithm-lab__code-actions"><span>{codeSnippet.split("\n").length} lines · reference only</span><button type="button" className="button button--ghost" onClick={() => void copySnippet()}>Copy snippet</button></div><p className="algorithm-lab__boundary"><Sparkles size={14} /> Snippet is generated from the selected pattern; no compiler, interpreter, terminal, provider request, or durable write is involved.</p></section><aside className="algorithm-lab__card"><span className="eyebrow">Correctness lens</span><h3>What to prove</h3><div className="algorithm-lab__proof-list"><div><strong>Invariant</strong><p>{notes.invariant}</p></div><div><strong>Proof sketch</strong><p>{notes.proof}</p></div></div><h4>Edge-case checklist</h4><ul className="algorithm-lab__notes">{notes.edgeCases.map((edgeCase) => <li key={edgeCase}>{edgeCase}</li>)}</ul><p className="algorithm-lab__boundary">These notes support reasoning and review; they are not a formal proof or runtime benchmark.</p></aside></div> : null}
    {tab === "complexity" ? <div id="algorithm-lab-panel-complexity" className="algorithm-lab__complexity-layout" role="tabpanel" aria-labelledby="algorithm-lab-tab-complexity" tabIndex={0}><section className="algorithm-lab__card"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Growth playground</span><h3>Compare operation counts</h3></div><label className="algorithm-lab__inline-field"><span>n</span><input aria-label="Complexity input n" inputMode="numeric" value={state.complexityN} onChange={(event) => update("complexityN", event.target.value)} /></label></div><div className="algorithm-lab__complexity-list">{complexityRows.map((row) => <div key={row.label} className="algorithm-lab__complexity-row"><span><strong>{row.label}</strong><small>{row.notation}</small></span><div className="algorithm-lab__bar"><i style={{ width: `${Math.min(100, Math.max(5, Math.log10(row.operations + 1) * 20))}%` }} /></div><b>{row.operations.toLocaleString()}</b></div>)}</div></section><aside className="algorithm-lab__card"><span className="eyebrow">CP heuristics</span><h3>Choose the right shape</h3><div className="algorithm-lab__heuristics"><span><b>n ≤ 20</b> exponential / bitmask DP</span><span><b>n ≤ 10⁵</b> O(n log n)</span><span><b>n ≤ 10⁶</b> O(n) or tight constants</span></div><p className="algorithm-lab__boundary">Operation counts are illustrative estimates. They do not benchmark a compiler, CPU, or provider.</p></aside></div> : null}
    {tab === "export" ? <section id="algorithm-lab-panel-export" className="algorithm-lab__card algorithm-lab__export" role="tabpanel" aria-labelledby="algorithm-lab-tab-export" tabIndex={0}><div className="algorithm-lab__export-toolbar"><label><span>Format</span><select aria-label="Algorithm lab export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}>Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{payload}</code></pre></section> : null}
    <section className="algorithm-lab__history" aria-label="Algorithm lab history"><div className="algorithm-lab__card-heading"><div><span className="eyebrow">Session history</span><h3>Recent rehearsals</h3></div><History size={16} /></div>{history.length ? <div className="algorithm-lab__history-list">{history.map((entry) => <button key={entry.id} type="button" onClick={() => { setState((current) => ({ ...current, algorithm: entry.algorithm })); setStatus(`Selected ${algorithmMeta[entry.algorithm].label} from local history.`); }}><strong>{algorithmMeta[entry.algorithm].label}</strong><span>{entry.answer} · {entry.complexity}</span></button>)}</div> : <p className="algorithm-lab__empty">No rehearsals recorded yet. Run a preview to pin one here.</p>}</section>
  </section>;
}

export default AlgorithmLabPreview;
