export function ModelOptions({ models }: { models: string[] }) {
  return (
    <>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </>
  );
}
