"use client";
import { useState } from "react";
import { Editor } from "@monaco-editor/react";
import { useYSync } from "@/lib/useYSync";
import { MenuItem, Select, InputLabel, Typography } from "@mui/material";
import '@fontsource/roboto/300.css';

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
  const { isConnected, createBinding, destroyBinding } =
    useYSync("shared-editor");

  const handleEditorMount = (editor: any) => {
    createBinding(editor);
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex gap-4 p-4 bg-gray-100 dark:bg-gray-900 rounded">
        <div className="flex flex-col gap-4" style={{ padding: '10px', width: "25%"}}>
          <div className="flex flex-col gap-4">
            <Typography variant="h5" component="h5" style={{ fontWeight: 'bold', marginBottom: '10px' }}>
              CodeSync
            </Typography>
          </div>
          <div className="flex flex-col gap-4">
            <InputLabel id="demo-simple-select-label">Language</InputLabel>
            <Select
              labelId="demo-simple-select-label"
              id="demo-simple-select"
              value={language}
              label="Language"
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <MenuItem key={lang} value={lang}>
                  {lang}
                </MenuItem>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-4">
            <InputLabel id="demo-simple-select-label">Theme</InputLabel>
            <Select
              style={{ width: '100%'}}
              labelId="demo-simple-select-label"
              id="demo-simple-select"
              value={theme}
              label="Theme"
              onChange={(e) => setTheme(e.target.value)}
            >
              {THEMES.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex-1">
          <Editor
            theme={theme}
            height="100vh"
            width="100%"
            defaultLanguage={language}
            language={language}
            defaultValue="// Start typing... (synced in real-time)"
            onMount={handleEditorMount}
          />
        </div>
      </div>
    </div>
  );
};
