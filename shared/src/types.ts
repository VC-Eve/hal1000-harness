// Shared WebSocket message contract between the HAL core (server) and its
// clients (web UI now, desktop shell later). Both sides compile against this
// file; it is the single source of truth for wire shapes.

export const HAL_VERSION = "0.1.0";

export type SessionState = "live" | "idle" | "ended" | "unreadable";

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: "hello";
  app: "hal1000";
  version: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage = HelloMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface PingMessage {
  type: "ping";
}

export type ClientMessage = PingMessage;
