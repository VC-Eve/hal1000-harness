import { useState } from "react";
import { PALETTE, sameColor } from "../palette";

interface Props {
  label: string;
  // The stored colour, as the server echoed it back. Never a submitted one:
  // normalization can lift or rotate a pick, and a swatch left looking
  // selected while the server kept something else is a lie about what is on
  // screen.
  value: string;
  onChange: (color: string) => void;
}

// The native picker keeps its own draft while the user scrubs, so it is
// remounted on every commit — see the nonce in ColorField. Once the settings
// broadcast lands, `value` is whatever the server stored and this shows it.
function CustomColor({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="endpoint-row">
      <input type="color" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="custom colour" />
      <button className="ghost" disabled={sameColor(draft, value)} onClick={() => onChange(draft)}>
        apply
      </button>
    </div>
  );
}

export function ColorField({ label, value, onChange }: Props) {
  // Bumped on every commit so the custom picker drops its draft and re-reads
  // the stored value, including when the server normalizes a pick straight
  // back to what was already stored and no broadcast changes `value`.
  const [nonce, setNonce] = useState(0);

  const commit = (color: string) => {
    setNonce((n) => n + 1);
    onChange(color);
  };

  return (
    <div className="color-field">
      <div className="color-field-head">
        <span>{label}</span>
        <span className="color-value">{value}</span>
      </div>
      <div className="swatches">
        {PALETTE.map((entry) => (
          <button
            key={entry.value}
            className={sameColor(entry.value, value) ? "swatch selected" : "swatch"}
            style={{ background: entry.value }}
            title={entry.name}
            aria-label={entry.name}
            onClick={() => commit(entry.value)}
          />
        ))}
      </div>
      <CustomColor key={`${value}|${nonce}`} value={value} onChange={commit} />
    </div>
  );
}
