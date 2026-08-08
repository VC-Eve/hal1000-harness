// SFace: an aligned 112x112 face in, a comparable vector out.
//
// The vector is L2-normalised before it leaves. Cosine similarity ignores
// magnitude anyway, so normalising at the boundary costs nothing and makes the
// contract unambiguous — a client compares two faces with a plain dot product
// and cannot accidentally compare unnormalised vectors from one call against
// normalised ones from another.

import ort from "onnxruntime-node";
import { SESSION_OPTIONS } from "./tensor.js";

export const EMBEDDING_DIMS = 128;

export class Embedder {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(modelPath: string): Promise<Embedder> {
    const session = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
    return new Embedder(session);
  }

  async embed(aligned: ort.Tensor): Promise<number[]> {
    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];
    if (!inputName || !outputName) throw new Error("The embedder model exposes no input or output.");

    const out = await this.session.run({ [inputName]: aligned });
    const raw = out[outputName]?.data as Float32Array | undefined;
    if (!raw) throw new Error("The embedder returned no output tensor.");
    return normalise(Array.from(raw));
  }
}

export function normalise(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  // A zero vector cannot be normalised and is not a face. Returning it
  // unchanged keeps this total rather than throwing deep in a request.
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

// Both vectors are unit length by the time a caller has them, so this is a dot
// product. Kept here so tests and any future caller share one definition.
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
