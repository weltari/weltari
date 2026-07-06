import { describe, expect, it } from 'vitest';
import { createSentenceSplitter } from './sentences.js';

function collect(): {
  sentences: string[];
  splitter: ReturnType<typeof createSentenceSplitter>;
} {
  const sentences: string[] = [];
  const splitter = createSentenceSplitter((s) => sentences.push(s));
  return { sentences, splitter };
}

describe('sentence splitter', () => {
  it('emits whole sentences across arbitrary delta boundaries', () => {
    const { sentences, splitter } = collect();
    for (const delta of [
      'Rain ha',
      'mmers the inn. The f',
      'ire spits! Elias lo',
      'oks up.',
    ]) {
      splitter.push(delta);
    }
    splitter.flush();
    expect(sentences).toEqual([
      'Rain hammers the inn.',
      'The fire spits!',
      'Elias looks up.',
    ]);
  });

  it('keeps closing quotes with their sentence', () => {
    const { sentences, splitter } = collect();
    splitter.push('"Late again," he says. "Sit down." She nods.');
    splitter.flush();
    expect(sentences).toEqual([
      '"Late again," he says.',
      '"Sit down."',
      'She nods.',
    ]);
  });

  it('flush emits a trailing partial sentence', () => {
    const { sentences, splitter } = collect();
    splitter.push('No terminal punctuation here');
    splitter.flush();
    expect(sentences).toEqual(['No terminal punctuation here']);
  });
});
