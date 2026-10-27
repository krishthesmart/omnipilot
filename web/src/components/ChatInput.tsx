import { useEffect, useRef, useState } from "react";
import { ArrowUp, AudioLines, FileText, Mic, Paperclip, Square, X } from "lucide-react";
import type { Voice } from "../hooks/useVoice";
import { parseAttachment, type Attachment } from "../api";

/** Notes, a chapter, lesson material: text files are read here; PDFs, Word and PowerPoint by the server
 * (PDFs on this computer). The server takes up to 60,000 characters. */
const ACCEPT = ".txt,.md,.markdown,.csv,.text,.pdf,.docx,.pptx";
const DOCUMENT = /\.(pdf|docx|pptx)$/i;
const MAX_CHARS = 60_000;

export function ChatInput({
  onSend,
  disabled,
  voice,
  voiceMode = false,
  onToggleVoiceMode,
  draft,
}: {
  /** Text to put in the box for the user to finish (from a page's "Add a feature…" button); `n` changes each time. */
  draft?: { text: string; n: number };
  onSend: (text: string, attachment?: Attachment) => Promise<boolean> | void;
  disabled?: boolean;
  voice: Voice;
  /** Hands-free: answers are read aloud and the mic opens again afterwards. */
  voiceMode?: boolean;
  onToggleVoiceMode?: () => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<Attachment | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draft?.text) return;
    setText(draft.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(draft.text.length, draft.text.length);
    });
  }, [draft?.n]);

  async function pickFile(f: File | undefined) {
    setFileError(null);
    if (!f) return;
    if (DOCUMENT.test(f.name)) {
      setFileError("Reading the file…");
      try {
        const doc = await parseAttachment(f);
        setFileError(doc.truncated ? "That file is long: only its first 60,000 characters are used." : null);
        return setFile({ name: doc.name, text: doc.text });
      } catch (e) {
        return setFileError(e instanceof Error ? e.message : "Couldn't read that file.");
      }
    }
    if (!/\.(txt|md|markdown|csv|text)$/i.test(f.name)) return setFileError("Attach a PDF, Word, PowerPoint or text file.");
    const content = (await f.text()).trim();
    if (!content) return setFileError("That file is empty.");
    if (content.length > MAX_CHARS) return setFileError(`That file is too long (${content.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}).`);
    setFile({ name: f.name.slice(0, 120), text: content });
  }

  async function submit() {
    const trimmed = text.trim() || (file ? "Teach me this and quiz me on it" : "");
    if (!trimmed) return;
    // Only clear the box once the message was actually sent, so nothing typed is lost.
    if ((await onSend(trimmed, file ?? undefined)) === false) return;
    setText("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function toggleMic() {
    if (voice.listening) voice.stopListening();
    else voice.listen((heard) => onSend(heard));
  }

  return (
    <>
      {file && (
        <div className="attach-chip">
          <FileText size={13} /> {file.name} <span className="attach-size">({file.text.length.toLocaleString()} characters)</span>
          <button onClick={() => setFile(null)} aria-label={`Remove ${file.name}`} title="Remove">
            <X size={12} />
          </button>
        </div>
      )}
      {fileError && <p className="voice-note" role="alert">{fileError}</p>}
      <div className="chat-input-bar">
        <textarea
          ref={textareaRef}
          value={voice.listening ? voice.interim : text}
          readOnly={voice.listening}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow(e.target);
          }}
          placeholder={voice.listening ? "Listening… speak now" : voice.transcribing ? "Turning your voice into text…" : "Ask anything"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          aria-label="Message"
        />
        <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        <button className="mic-btn" onClick={() => fileRef.current?.click()} disabled={disabled} aria-label="Attach a file" title="Attach notes or a lesson (PDF, Word, PowerPoint, .txt, .md) to learn from">
          <Paperclip size={16} />
        </button>
        {onToggleVoiceMode && (voice.canListen || voice.canSpeak) && (
          <button
            className={voiceMode ? "mic-btn voice-mode on" : "mic-btn voice-mode"}
            onClick={onToggleVoiceMode}
            aria-pressed={voiceMode}
            aria-label="Hands-free voice mode"
            title={voiceMode ? "Voice mode on: answers are read aloud, then I listen again" : "Voice mode: talk hands-free and hear answers read aloud"}
          >
            <AudioLines size={16} />
          </button>
        )}
        <button
          className={voice.listening ? "mic-btn listening" : "mic-btn"}
          onClick={toggleMic}
          disabled={!voice.canListen || disabled || voice.transcribing}
          aria-label={voice.listening ? "Stop listening and send" : "Speak your message"}
          title={voice.canListen ? (voice.listening ? "Stop and send" : "Speak") : "Voice input isn't available in this browser (try Chrome, Edge or Safari)"}
        >
          {voice.listening ? <Square size={13} /> : <Mic size={16} />}
        </button>
        <button className="send-btn" onClick={submit} disabled={disabled || voice.listening || (!text.trim() && !file)} aria-label="Send message">
          <ArrowUp size={17} />
        </button>
      </div>
      {voice.error && (
        <p className="voice-note" role="alert">
          {voice.error}
        </p>
      )}
      {voice.listening && !voice.error && (
        <p className="voice-note">
          {voice.onDevice ? "Listening on this computer. Stops when you pause." : "Listening. Your browser's speech service turns your voice into text."}
        </p>
      )}
    </>
  );
}
