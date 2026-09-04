// `music-tempo` ships no types, so its shape is declared once here rather than
// cast at the call site.
//
// Only what `tempo.ts` actually reads is declared, and `tempo` is deliberately
// `string`: the library returns `beatInterval` formatted through `toFixed(3)`,
// so a caller that treated it as a number would get `NaN` from arithmetic and
// `"150.000"` from a log line. `tempo.ts` reads `beats` and derives the tempo
// itself, which is what makes the octave reconciliation its own answer rather
// than a restatement of the library's.
declare module "music-tempo" {
  interface MusicTempoParams {
    /** FFT window, samples. Must be a power of two. */
    bufferSize?: number;
    /** Spacing of analysis frames, samples. The library assumes `timeStep` seconds. */
    hopSize?: number;
    /** Seconds per frame the library assumes. Default 0.01, i.e. 44100/441. */
    timeStep?: number;
    /** Longest beat interval considered, in the library's own time units. */
    maxBeatInterval?: number;
    /** Shortest beat interval considered, in the library's own time units. */
    minBeatInterval?: number;
    expiryTime?: number;
  }

  class MusicTempo {
    constructor(audioData: number[], params?: MusicTempoParams);
    /** Formatted to three decimals by the library. A string, not a number. */
    tempo: string;
    /** Beat times, in the library's own time units. */
    beats: number[];
    beatInterval: number;
  }

  export = MusicTempo;
}
