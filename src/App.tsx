import { AgentShell } from "@/agent/agent-shell";

import "@/styles/tokens.generated.css";
import "@/styles/tokens.css";
import "@/styles/base.css";

/**
 * The main application is the provider-neutral coding-agent shell. The earlier
 * workspace UI lives behind Settings → Labs (`@/labs/labs-app`) and is
 * code-split so it never loads unless opened.
 */
export default function App() {
  return <AgentShell />;
}
