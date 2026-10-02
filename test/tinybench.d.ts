export {};

declare global {
  // Tinybench's declarations (loaded by Vitest) use this DOM alias for
  // performance.now(). Keep the Node-only project free of browser globals.
  type DOMHighResTimeStamp = number;
}
