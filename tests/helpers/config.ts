import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CONFIG_DIR, loadConfig } from "../../src/config/load.js";

/** The shipped defaults plus the generic fixture projects (the shipped projects.yaml is empty: it is a product default, not anyone's setup). */
export function fixtureConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), "factory-fixture-"));
  for (const f of ["factory.yaml", "linear.yaml", "models.yaml", "workflows.yaml"]) copyFileSync(join(BUNDLED_CONFIG_DIR, f), join(d, f));
  copyFileSync(join(process.cwd(), "tests", "fixtures", "projects.yaml"), join(d, "projects.yaml"));
  return d;
}
export const fixtureConfig = () => loadConfig(fixtureConfigDir());
