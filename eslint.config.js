import js from "@eslint/js";
import security from "eslint-plugin-security";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

// Flat config. typescript-eslint `recommended` (non-type-checked: fast, catches no-explicit-any,
// no-unused-vars, etc.) + eslint-plugin-security. Aligned to the TS best-practices the project
// follows: prefer `unknown` over `any`, type-only imports, no implicit any (already via tsc strict).
// We can ratchet to `recommendedTypeChecked` once the app code lands.
export default tseslint.config(
  // tools/workflows/** are one-shot multi-agent orchestration scripts that run in the Workflow
  // runtime against injected globals (agent/parallel/phase/log/args/budget) — not project code; an
  // `eslint .` over them only yields false `no-undef` for those runtime globals.
  // test/fixtures/magika_corpus/** are opaque SAMPLE files (real .js/.ts/etc. copied in) that the magika
  // classifier identifies — they are inputs to a test, not project code, so they are never linted/typed.
  { ignores: ["dist/**", "node_modules/**", "vendor/**", "coverage/**", "tools/parity/run_python_ref.py", "tools/workflows/**", "test/fixtures/magika_corpus/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    plugins: { unicorn },
    rules: {
      // Enforce consistent snake_case filenames (mirrors the frozen Python source names; eases the
      // parity path-map). `.v1` / `.parity` / `.test` segments are allowed via additionalExtensions.
      "unicorn/filename-case": [
        "error",
        { case: "snakeCase", multipleFileExtensions: true, ignore: ["^_"] },
      ],
    },
  },
  {
    rules: {
      // mkosir TS style guide, enforced by tooling:
      "@typescript-eslint/no-explicit-any": "error", //  prefer `unknown`
      "@typescript-eslint/consistent-type-imports": "error", //  `import { type X }`
      "@typescript-eslint/consistent-type-definitions": ["error", "type"], //  `type` over `interface`
      "@typescript-eslint/array-type": ["error", { default: "generic", readonly: "generic" }], //  Array<T> / ReadonlyArray<T>
      "no-restricted-syntax": [
        "warn",
        { selector: "TSEnumDeclaration", message: "Avoid TS enum (runtime cost); use a union or `as const` object." },
      ],
    },
  },
  {
    // Tests + gate AST-walkers legitimately touch dynamic shapes / fs; relax the noisiest security rules.
    files: ["test/**/*.ts", "scripts/gates/**/*.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
    },
  },
);
