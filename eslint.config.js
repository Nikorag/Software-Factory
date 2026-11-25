import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "**/dist", "node_modules", "drizzle"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
);
