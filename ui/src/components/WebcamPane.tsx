import { CollapseButton } from "./SectionRail";

interface Props {
  collapseDisabled: boolean;
  onCollapse: () => void;
}

/**
 * The third section, deliberately empty.
 *
 * It ships as a frame so the layout that holds three sections can be built,
 * reviewed, and lived with before anything is decided about what watching a
 * webcam means here — whether it becomes a third observation role alongside the
 * Watched Session and Monitors, or something else entirely. Nothing in this
 * file touches a device, and it must stay that way until that question is
 * answered: a permission prompt on load would be the app asking for a camera
 * before it can say what it would do with one.
 */
export function WebcamPane({ collapseDisabled, onCollapse }: Props) {
  return (
    <section className="pane webcam-pane" data-testid="webcam-pane">
      <div className="pane-header">
        <span className="pane-title">webcam analysis</span>
        <CollapseButton id="webcam" disabled={collapseDisabled} onCollapse={onCollapse} />
      </div>
      <div className="empty-state webcam-placeholder">
        <p>No eyes yet. This is where I will watch you work.</p>
      </div>
    </section>
  );
}
