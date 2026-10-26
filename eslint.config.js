import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// HTML is escaped only by src/platform/html.ts. These patterns catch a new
// local escape helper or markup built from an unescaped template literal.
const htmlSink = "[left.property.name=/^(?:inner|outer)HTML$/]";
const builtTemplate =
  "TemplateLiteral[expressions.length>0]:not(TaggedTemplateExpression > TemplateLiteral)";
const useHtml =
  "Build markup with html`...` from src/platform/html.ts so values are escaped.";
const noLocalEscape =
  "Escape HTML only with src/platform/html.ts; do not add a local escape helper.";
const escapingRules = [
  {
    selector: `AssignmentExpression${htmlSink} > ${builtTemplate}`,
    message: useHtml,
  },
  {
    selector: `AssignmentExpression${htmlSink} > :matches(ConditionalExpression, LogicalExpression) > ${builtTemplate}`,
    message: useHtml,
  },
  {
    selector: `AssignmentExpression${htmlSink} > BinaryExpression[operator="+"]`,
    message: useHtml,
  },
  {
    selector: `CallExpression[callee.property.name="insertAdjacentHTML"] > ${builtTemplate}`,
    message: useHtml,
  },
  {
    selector: "Literal[value=/^&(?:amp|lt|gt|quot|apos|#0*39|#x0*27);$/]",
    message: noLocalEscape,
  },
  {
    selector:
      ":matches(VariableDeclarator, FunctionDeclaration)[id.name=/^(?:esc|escape)(?!Reg[Ee]xp)(?:[A-Z]\\w*)?$/]",
    message: noLocalEscape,
  },
];

export default [
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "dist/",
      "dist-transcriber/",
      "public/**/*.js",
      ".env.*/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.ts", "frontend/**/*.ts", "scripts/**/*.{js,ts}"],
    ignores: ["src/platform/html.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...escapingRules],
    },
  },
  prettier,
];
