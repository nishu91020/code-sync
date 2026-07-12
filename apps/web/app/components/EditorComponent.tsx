"use client";
import { useState, useEffect } from "react";
import { Editor } from "@monaco-editor/react";
import { useYSync } from "@/lib/useYSync";
import { MenuItem, Select, InputLabel, Typography } from "@mui/material";

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

const EditorComponent = ({ roomId }: { roomId: string }) => {
  const [theme, setTheme] = useState("vs-dark");
  const [language, setLanguage] = useState("javascript");

  // Use roomId to create unique binding per room
  const { isConnected, createBinding, destroyBinding } = useYSync(`room-${roomId}`);

  // Cleanup when room changes or component unmounts
  useEffect(() => {
    return () => {
      destroyBinding();
    };
  }, [roomId, destroyBinding]);

  const handleEditorMount = (editor: any) => {
    createBinding(editor);
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Top Bar */}
      <div className="flex flex-col items-center justify-between p-4 bg-gray-100 dark:bg-gray-900 border-b">
        <div className="flex items-center gap-4">
          <Typography variant="h5" fontWeight="bold">
            CodeSync
          </Typography>
          <div className="text-sm text-gray-500">
            Room: <span className="font-mono font-medium">{roomId}</span>
          </div>
          <div className={`text-sm ${isConnected ? 'text-green-600' : 'text-red-600'}`}>
            {isConnected ? "● Connected" : "○ Disconnected"}
          </div>
        </div>

        <div className="flex gap-4">
          {/* Language Selector */}
          <div>
            <InputLabel>Language</InputLabel>
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              size="small"
            >
              {LANGUAGES.map((lang) => (
                <MenuItem key={lang} value={lang}>
                  {lang}
                </MenuItem>
              ))}
            </Select>
          </div>

          {/* Theme Selector */}
          <div>
            <InputLabel>Theme</InputLabel>
            <Select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              size="small"
            >
              {THEMES.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1">
        <Editor
          theme={theme}
          height="80vh"
          width="100%"
          language={language}
          defaultValue="// Welcome to the room! Share this room ID with others to collaborate."
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: true },
            fontSize: 15,
          }}
        />
      </div>
    </div>
  );
};

export default EditorComponent;