import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "**/dist", "node_modules", "drizzle"] },
  ...tseslint.configs.recommended,
  { files: ["desktop/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } }, // the Electron main process is CommonJS
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
);
