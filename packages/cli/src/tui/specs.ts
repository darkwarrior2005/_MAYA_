import { enabledWorkers, type MayaConfig } from "@maya/core";
import { OPERATOR_PANE, type PaneSpec } from "./pane-state.js";

/**
 * Panes come from the configured roster rather than from whatever has spoken so
 * far, so the layout is stable from the first frame instead of rearranging
 * itself as workers start producing output.
 */
export function paneSpecs(config: MayaConfig): { operator: PaneSpec; workers: PaneSpec[] } {
  return {
    operator: { id: OPERATOR_PANE, title: config.operator.displayName },
    workers: enabledWorkers(config).map((worker) => ({
      id: worker.id,
      title: worker.displayName,
    })),
  };
}
