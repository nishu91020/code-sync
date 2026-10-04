export const THEMES = ["vs", "vs-dark", "hc-black", "hc-light"] as const;

/** Languages offered in the editor's language picker. */
export const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "java",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "go",
  "rust",
  "sql",
  "html",
  "css",
  "json",
  "xml",
  "yaml",
] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "javascript";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}
