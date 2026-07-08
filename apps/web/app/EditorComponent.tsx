"use client";

import { useState } from "react";
import { Editor } from "@monaco-editor/react";

const THEMES = ["vs", "vs-dark", "hc-black", "hc-light"];
const LANGUAGES = [
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
];

export const EditorComponent = () => {
  const [theme, setTheme] = useState("vs-dark");
  const [language, setLanguage] = useState("javascript");

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex gap-4 p-4 bg-gray-100 dark:bg-gray-900 rounded">
        <div className="flex flex-col gap-2">
          <label htmlFor="theme-select" className="text-sm font-medium">
            Theme
          </label>
          <select
            id="theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-sm"
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="language-select" className="text-sm font-medium">
            Language
          </label>
          <select
            id="language-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-sm"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Editor
          theme={theme}
          height="90vh"
          width="100%"
          defaultLanguage={language}
          language={language}
          defaultValue="// some comment"
        />
      </div>
    </div>
  );
};