"use client";

import { Separator } from "react-resizable-panels";

/**
 * Drag handle between two panels. `Group` lays its children out with flexbox,
 * so the separator needs an explicit size on the axis it divides.
 */
export const ResizeHandle = ({ orientation }: { orientation: "horizontal" | "vertical" }) => {
  // A vertical group stacks its panels, so the handle between them is a
  // horizontal bar, and vice versa.
  const isStacked = orientation === "vertical";

  return (
    <Separator
      className={`group relative shrink-0 bg-gray-800 transition-colors hover:bg-blue-500 active:bg-blue-500 ${
        isStacked ? "h-1.5 w-full" : "h-full w-1.5"
      }`}
    >
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-600 group-hover:bg-white ${
          isStacked ? "h-0.5 w-8" : "h-8 w-0.5"
        }`}
      />
    </Separator>
  );
};

export default ResizeHandle;
