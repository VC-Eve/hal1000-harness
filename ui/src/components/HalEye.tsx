// The eye is a living indicator, not a static icon (review decision):
// idle = slow breathing pulse, streaming = brisk pulse, narrating = flicker,
// error = steady bright, disconnected = dim.
export type EyeState = "idle" | "streaming" | "narrating" | "error" | "disconnected";

export function HalEye({ state }: { state: EyeState }) {
  return (
    <div className={`hal-eye ${state}`} title={`HAL status: ${state}`} data-testid="hal-eye">
      <div className="hal-eye-glow" />
      <div className="hal-eye-core" />
    </div>
  );
}
