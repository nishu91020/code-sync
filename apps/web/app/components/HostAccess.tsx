"use client";

import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Popover,
} from "@mui/material";
import { useEffect, useState } from "react";

import type { HostAccess } from "@/lib/useHostAccess";

/**
 * Asks the host about everyone waiting to join. Opens by itself whenever a new
 * request arrives; "Decide later" tucks those requests into a reminder bar
 * until the host reviews them. The tab title flags waiting people too, so a
 * host working in another tab still notices.
 */
export const JoinRequests = ({ access }: { access: HostAccess }) => {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const { pending } = access;
  const first = pending[0];
  const undecided = pending.filter((request) => !dismissed.has(request.id));
  const open = undecided.length > 0;

  const titleSummary = !first
    ? ""
    : pending.length === 1
      ? `🔔 ${first.name} wants to join`
      : `🔔 ${pending.length} people want to join`;
  useEffect(() => {
    if (!titleSummary) return;
    const original = document.title;
    document.title = `${titleSummary} · CodeSync`;
    return () => {
      document.title = original;
    };
  }, [titleSummary]);

  const decide = async (requestId: string, action: "admit" | "deny") => {
    setBusy(requestId);
    try {
      await (action === "admit" ? access.admit(requestId) : access.deny(requestId));
    } finally {
      setBusy(null);
    }
  };

  const decideLater = () =>
    setDismissed((previous) => new Set([...previous, ...undecided.map((request) => request.id)]));

  return (
    <>
      {first && !open && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-blue-300 bg-blue-50 px-4 py-2 text-sm text-blue-900"
          data-testid="join-requests-reminder"
        >
          <span>
            {pending.length === 1 ? (
              <>
                <strong>{first.name}</strong> is waiting to join
              </>
            ) : (
              <>
                <strong>{pending.length} people</strong> are waiting to join
              </>
            )}
          </span>
          <Button size="small" variant="contained" onClick={() => setDismissed(new Set())}>
            Review
          </Button>
        </div>
      )}

      <Dialog
        open={open}
        onClose={decideLater}
        maxWidth="xs"
        fullWidth
        slotProps={{ paper: { "data-testid": "join-request-dialog" } as object }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          {undecided.length === 1 ? "Someone wants to join" : `${undecided.length} people want to join`}
        </DialogTitle>
        <DialogContent>
          <p className="mb-3 text-sm text-gray-500">
            They can&apos;t see or edit anything until you admit them.
          </p>
          <ul className="flex flex-col gap-3">
            {undecided.map((request) => (
              <li
                key={request.id}
                className="flex items-center justify-between gap-3"
                data-request-name={request.name}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: request.color ?? "#9ca3af" }}
                    aria-hidden
                  />
                  <strong className="truncate">{request.name}</strong>
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button
                    size="small"
                    variant="outlined"
                    color="inherit"
                    disabled={busy === request.id}
                    onClick={() => decide(request.id, "deny")}
                  >
                    Deny
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy === request.id}
                    onClick={() => decide(request.id, "admit")}
                  >
                    Admit
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </DialogContent>
        <DialogActions>
          <Button onClick={decideLater} color="inherit">
            Decide later
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

/** The host's list of admitted people, each of whom can be removed. */
export const PeopleMenu = ({ access, hostName }: { access: HostAccess; hostName: string }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <Badge badgeContent={access.pending.length} color="error">
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-label="Manage people"
          data-testid="people-menu"
          sx={{ textTransform: "none", whiteSpace: "nowrap" }}
        >
          People · {access.members.length + 1}
        </Button>
      </Badge>

      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <div className="w-72 p-3 text-sm">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            People with access
          </p>
          <ul className="flex flex-col gap-2">
            <li className="flex items-center justify-between">
              <span>
                {hostName} <span className="text-gray-500">(you, host)</span>
              </span>
            </li>
            {access.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between" data-member-name={member.name}>
                <span>{member.name}</span>
                <Button size="small" color="error" onClick={() => access.remove(member.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {access.members.length === 0 && (
            <p className="mt-2 text-gray-500">
              Nobody else yet. Share this page&apos;s link; you&apos;ll be asked before anyone gets in.
            </p>
          )}
          {access.error && <p className="mt-2 text-red-600">{access.error}</p>}
        </div>
      </Popover>
    </>
  );
};
