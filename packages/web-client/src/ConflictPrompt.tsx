import { useState, type ReactElement } from "react";
import type { ConflictOption } from "@maya/shared-types";
import { answerConflict } from "./api.js";

export interface PendingConflict {
  question: string;
  options: ConflictOption[];
}

/**
 * The wireframe's "resolve this tie, user": the Operator's question with the
 * proposed answers as buttons and a slot for one of the user's own.
 *
 * The same question is on screen in the terminal at the same moment, and
 * either can answer it. The daemon says so when the other got there first,
 * which is a race rather than a failure.
 */
export function ConflictPrompt({
  pending,
  answerable,
}: {
  pending: PendingConflict;
  answerable: boolean;
}): ReactElement {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const answer = async (value: string): Promise<void> => {
    if (busy || value.trim() === "") return;
    setBusy(true);
    setNote(null);
    try {
      await answerConflict(value);
      setCustom("");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="conflict" aria-live="polite">
      <h3>Needs a decision</h3>
      <p className="question">{pending.question}</p>

      {!answerable && (
        <p className="muted">This session answers merge questions in its own terminal.</p>
      )}

      {answerable && (
        <>
          <div className="options">
            {pending.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                onClick={() => void answer(String(index + 1))}
              >
                {option.label}
                {option.proposedBy && <span className="by">{option.proposedBy}</span>}
              </button>
            ))}
          </div>

          <form
            className="custom"
            onSubmit={(event) => {
              event.preventDefault();
              void answer(custom);
            }}
          >
            <input
              value={custom}
              onChange={(change) => setCustom(change.target.value)}
              placeholder="…or answer in your own words"
              aria-label="Your own answer"
              disabled={busy}
            />
            <button type="submit" disabled={busy || custom.trim() === ""}>
              Answer
            </button>
          </form>
        </>
      )}

      {note && <p className="error">{note}</p>}
    </section>
  );
}
