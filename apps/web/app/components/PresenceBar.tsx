"use client";

import { Tooltip } from "@mui/material";

import { initials, type YUser } from "@/lib/identity";
import type { Peer } from "@/lib/useYSync";

const MAX_VISIBLE = 5;

function Avatar({ user, label }: { user: YUser; label: string }) {
  return (
    <Tooltip title={label} arrow>
      <div
        className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow-sm dark:border-gray-900"
        style={{ backgroundColor: user.color }}
        aria-label={label}
      >
        {initials(user.name)}
      </div>
    </Tooltip>
  );
}

export const PresenceBar = ({ self, peers }: { self: YUser; peers: Peer[] }) => {
  const visible = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.length - visible.length;

  return (
    <div className="flex items-center gap-3">
      <div className="flex -space-x-2">
        <Avatar user={self} label={`${self.name} (you)`} />
        {visible.map((peer) => (
          <Avatar key={peer.clientId} user={peer} label={peer.name} />
        ))}
        {overflow > 0 && (
          <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gray-500 text-xs font-semibold text-white shadow-sm dark:border-gray-900">
            +{overflow}
          </div>
        )}
      </div>
      <span className="text-sm text-gray-500">
        <span className="font-medium text-gray-700 dark:text-gray-200">{self.name}</span>
        {peers.length === 0 ? " · only you" : ` · ${peers.length + 1} collaborators`}
      </span>
    </div>
  );
};

export default PresenceBar;
