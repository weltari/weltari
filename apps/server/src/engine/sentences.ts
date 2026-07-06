// Incremental sentence assembly for the SSE stream: deltas in, whole sentences
// out. Display pacing only — the committed turn stores the full text (B6).

export interface SentenceSplitter {
  push(delta: string): void;
  /** Emit any trailing partial sentence (end of a call). */
  flush(): void;
}

const BOUNDARY = /[.!?…]["'”’)\]]*\s/;

export function createSentenceSplitter(
  onSentence: (sentence: string) => void,
): SentenceSplitter {
  let buffer = '';

  function drain(): void {
    let match = BOUNDARY.exec(buffer);
    while (match !== null) {
      const end = match.index + match[0].length;
      const sentence = buffer.slice(0, end).trim();
      if (sentence.length > 0) onSentence(sentence);
      buffer = buffer.slice(end);
      match = BOUNDARY.exec(buffer);
    }
  }

  return {
    push(delta: string): void {
      buffer += delta;
      drain();
    },
    flush(): void {
      const rest = buffer.trim();
      buffer = '';
      if (rest.length > 0) onSentence(rest);
    },
  };
}
