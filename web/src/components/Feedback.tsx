import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { sendFeedback } from "../api";

/** Thumbs up/down under an answer. A thumbs-down asks what was wrong, and OmniPilot learns from it. */
export function Feedback({ runId }: { runId: string }) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function rate(value: 1 | -1, comment = "") {
    setRating(value);
    setAsking(false);
    const r = await sendFeedback(runId, value, comment);
    if (!r) setNote("Couldn't save that.");
    else if (r.lesson) setNote(`Thanks. I'll remember: "${r.lesson.lesson}"`);
    else setNote(value === 1 ? "Thanks!" : "Thanks for telling me.");
  }

  return (
    <div className="feedback">
      <button className={rating === 1 ? "fb-btn on" : "fb-btn"} onClick={() => rate(1)} aria-label="Good answer" aria-pressed={rating === 1} title="Good answer">
        <ThumbsUp size={14} />
      </button>
      <button className={rating === -1 ? "fb-btn on" : "fb-btn"} onClick={() => (rating === -1 ? undefined : setAsking(true))} aria-label="Bad answer" aria-pressed={rating === -1} title="Bad answer">
        <ThumbsDown size={14} />
      </button>
      {asking && (
        <form
          className="fb-form"
          onSubmit={(e) => {
            e.preventDefault();
            rate(-1, reason.trim());
          }}
        >
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What was wrong? (optional)" aria-label="What was wrong" autoFocus maxLength={400} />
          <button type="submit" className="pill-btn">Send</button>
        </form>
      )}
      {note && (
        <span className="fb-note" role="status">
          {note}
        </span>
      )}
    </div>
  );
}
