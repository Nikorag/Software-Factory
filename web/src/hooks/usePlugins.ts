import { api } from "@/lib/api";
import type { PluginsView } from "@/lib/tasks";
import { usePoll } from "./usePoll";

/** The installed plugins and the configured instances (null until loaded; pickers fall back to the built-in instances). */
export function usePlugins() {
  const { data, error, reload } = usePoll(() => api<PluginsView>("/api/plugins"), 30000);
  return { plugins: data, error, reload };
}
