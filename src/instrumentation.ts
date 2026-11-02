/** Runs once when the Next.js server starts: recover tasks interrupted by a previous shutdown. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverInterrupted } = await import("./core/orchestrator");
    const n = recoverInterrupted();
    if (n) console.log(`[devrelay] marked ${n} interrupted task step(s) as failed (retryable).`);
  }
}