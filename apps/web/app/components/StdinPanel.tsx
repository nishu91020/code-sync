"use client";

/**
 * Program input for the next run. It sits beside the output panel rather than
 * in the toolbar because stdin is frequently multi-line.
 */
export const StdinPanel = ({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) => {
  return (
    <div className="flex h-full w-full min-w-0 flex-col border-t border-r border-gray-800 bg-gray-950 text-gray-200">
      <div className="flex items-center gap-3 border-b border-gray-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">stdin</span>
        <span className="text-[11px] text-gray-600">one line per input</span>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        placeholder={"Program input…\nLine 1\nLine 2"}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none disabled:opacity-60"
      />
    </div>
  );
};

export default StdinPanel;
