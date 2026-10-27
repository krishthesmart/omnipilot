export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running…",
  success: "Success",
  partial_success: "Partial success",
  needs_connection: "Not connected",
  missing_permissions: "Missing permissions",
  timeout: "Timed out",
  unreachable: "Unreachable",
  failed_safe: "Blocked (safety)",
  needs_approval: "Needs approval",
};

export const STATUS_CLASS: Record<string, string> = {
  queued: "status-queued",
  running: "status-running",
  success: "status-success",
  partial_success: "status-partial",
  needs_connection: "status-warn",
  missing_permissions: "status-warn",
  timeout: "status-error",
  unreachable: "status-error",
  failed_safe: "status-error",
  needs_approval: "status-warn",
};
