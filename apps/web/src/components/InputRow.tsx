// The chatbox. Submitting while a turn is streaming is the interrupt path
// (UI Spec §1.4): interrupt-turn closes the envelope at the last displayed
// sentence, THEN the new turn starts. The engine decides what was durable —
// the client only reports what was seen.
import { useRef, useState } from 'react';
import { postInterruptTurn, postStartTurn } from '../commands.js';
import type { Pacing } from '../usePacing.js';
import { useSceneStore } from '../store.js';

export function InputRow(props: { pacing: Pacing }): React.JSX.Element {
  const sceneId = useSceneStore((s) => s.sceneId);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const openTurnId = useSceneStore((s) => s.openTurnId);
  const connected = useSceneStore((s) => s.connected);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const interrupting = openTurnId !== null;
  const disabled = !connected || sceneId === null || sceneEnd !== null || busy;

  async function submit(): Promise<void> {
    if (sceneId === null) return;
    const text = inputRef.current?.value.trim() ?? '';
    setBusy(true);
    try {
      if (openTurnId !== null) {
        // Close the running envelope at the seen cut before speaking.
        await postInterruptTurn(openTurnId, props.pacing.seen);
      }
      await postStartTurn(sceneId, text);
      if (inputRef.current !== null) inputRef.current.value = '';
    } finally {
      setBusy(false);
    }
  }

  function fire(): void {
    submit().catch(() => {
      // CATCH-OK: a failed command leaves the row usable; truth is the stream.
      setBusy(false);
    });
  }

  return (
    <div className="wl-input-row">
      <input
        ref={inputRef}
        placeholder={interrupting ? 'Interrupt and say…' : 'What do you do?'}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !disabled) fire();
        }}
      />
      <button
        className={interrupting ? 'wl-button wl-button-danger' : 'wl-button'}
        disabled={disabled}
        onClick={fire}
      >
        {interrupting ? '✋ Interrupt' : 'Play turn'}
      </button>
    </div>
  );
}
