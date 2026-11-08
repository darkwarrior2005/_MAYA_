import type { AgentToolId } from "@maya/shared-types";
import type { AgentAdapter } from "./adapter.js";

/**
 * The only place that knows which tools exist. Orchestration code resolves
 * adapters through here and never branches on tool identity itself, so adding
 * a tool means registering one more adapter.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<AgentToolId, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(tool: AgentToolId): AgentAdapter {
    const adapter = this.adapters.get(tool);
    if (!adapter) throw new Error(`no adapter registered for tool "${tool}"`);
    return adapter;
  }

  has(tool: AgentToolId): boolean {
    return this.adapters.has(tool);
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
