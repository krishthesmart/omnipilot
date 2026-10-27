import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSpeechAvailable, transcribeAudio } from "../api";

// Voice in and out, free:
// - Speech to text: the mic records a short clip and OmniPilot's engine
//   transcribes it with Whisper on this computer, so audio never leaves the
//   machine (works in any browser).
// - Without that, the browser's SpeechRecognition is used
//   (on-device where the browser offers it; Chrome's default sends audio to Google).
// - speechSynthesis (every modern browser) reads answers aloud, on-device.

/** Longest recording: keeps the upload under the engine's 256 KB limit. */
const MAX_RECORDING_MS = 45_000;
/** Stop by itself after this much quiet, once someone has spoken. */
const SILENCE_MS = 1800;

type Recognition = any;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it from the icon in the address bar, then try again.",
  "service-not-allowed": "This browser won't allow speech recognition here.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  "audio-capture": "No microphone was found.",
  network: "Your browser's speech service couldn't be reached (it needs the internet unless on-device speech is available).",
  "language-not-supported": "Speech recognition doesn't support your language in this browser.",
};

function recognitionCtor(): any {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Answers are written for reading; this makes them sound right when spoken. */
export function speakableText(markdown: string): string {
  let t = markdown
    .replace(/```[\s\S]*?```/g, " (I've put the code on screen.) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/[*_#>|]/g, " ")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 1200) t = `${t.slice(0, 1200).replace(/[^.!?]*$/, "")} The rest is on screen.`;
  return t;
}

/** Sentence-sized pieces: some browsers stop long utterances partway through. */
function chunks(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]) {
    if (out.length && (out[out.length - 1] + sentence).length < 220) out[out.length - 1] += sentence;
    else out.push(sentence);
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

export function useVoice() {
  const Ctor = typeof window !== "undefined" ? recognitionCtor() : null;
  const canRecord = typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const [localSpeech, setLocalSpeech] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const canListen = Boolean(Ctor) || (localSpeech && canRecord);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (canRecord) fetchSpeechAvailable().then(setLocalSpeech);
  }, [canRecord]);

  /** Records one message and has this computer transcribe it (Whisper, in OmniPilot's engine). */
  const listenLocally = useCallback(async (onFinal: (text: string) => void) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setError((err as Error)?.name === "NotAllowedError" ? ERRORS["not-allowed"] : ERRORS["audio-capture"]);
      return;
    }
    const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);

    // Quiet detection: stop once the speaker has paused for a moment.
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let spoke = false;
    let quietSince = Date.now();
    const started = Date.now();
    const meter = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v - 128));
      if (peak > 12) {
        spoke = true;
        quietSince = Date.now();
      }
      if ((spoke && Date.now() - quietSince > SILENCE_MS) || Date.now() - started > MAX_RECORDING_MS) recorder.state === "recording" && recorder.stop();
    }, 100);

    recorder.onstop = async () => {
      clearInterval(meter);
      stream.getTracks().forEach((t) => t.stop());
      audio.close().catch(() => {});
      recorderRef.current = null;
      setListening(false);
      if (!spoke) return setError(ERRORS["no-speech"]);
      setTranscribing(true);
      const result = await transcribeAudio(new Blob(parts, { type: recorder.mimeType }));
      setTranscribing(false);
      if (result.ok) onFinal(result.text);
      else setError(result.message);
    };
    recorder.start(250);
    recorderRef.current = recorder;
    setOnDevice(true);
    setListening(true);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (canSpeak) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [canSpeak]);

  /** Listens for one utterance; `onFinal` gets the text when the speaker stops. */
  const listen = useCallback(
    async (onFinal: (text: string) => void) => {
      if (recRef.current || recorderRef.current) return;
      stopSpeaking();
      setError(null);
      if (localSpeech && canRecord) return listenLocally(onFinal);
      if (!Ctor) return;
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      // Prefer on-device recognition where the browser supports it (newer Chrome).
      let local = false;
      try {
        if ("processLocally" in rec && typeof Ctor.available === "function") {
          const opts = { langs: [rec.lang], processLocally: true };
          const availability = await Ctor.available(opts);
          if (availability === "available") local = true;
          else if (availability === "downloadable" && typeof Ctor.install === "function") local = Boolean(await Ctor.install(opts));
          if (local) rec.processLocally = true;
        }
      } catch {
        local = false;
      }
      setOnDevice(local);

      let finalText = "";
      rec.onresult = (e: any) => {
        let pending = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else pending += r[0].transcript;
        }
        setInterim((finalText + pending).trim());
      };
      rec.onerror = (e: any) => {
        if (e.error !== "aborted") setError(ERRORS[e.error] ?? `Speech recognition stopped (${e.error}).`);
      };
      rec.onend = () => {
        recRef.current = null;
        setListening(false);
        setInterim("");
        const text = finalText.trim();
        if (text) onFinal(text);
      };
      try {
        rec.start();
        recRef.current = rec;
        setListening(true);
      } catch {
        setError("Couldn't start the microphone.");
      }
    },
    [Ctor, stopSpeaking, localSpeech, canRecord, listenLocally]
  );

  /** Stops listening and sends what was heard so far. */
  const stopListening = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recRef.current?.stop();
  }, []);

  const speak = useCallback(
    (markdown: string, onDone?: () => void) => {
      if (!canSpeak) return onDone?.();
      const text = speakableText(markdown);
      window.speechSynthesis.cancel();
      const parts = chunks(text);
      if (parts.length === 0) return onDone?.();
      setSpeaking(true);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = navigator.language || "en-US";
        if (i === parts.length - 1) {
          u.onend = () => {
            setSpeaking(false);
            onDone?.();
          };
          u.onerror = () => setSpeaking(false);
        }
        window.speechSynthesis.speak(u);
      });
    },
    [canSpeak]
  );

  useEffect(
    () => () => {
      recRef.current?.abort?.();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      if (canSpeak) window.speechSynthesis.cancel();
    },
    [canSpeak]
  );

  return { canListen, canSpeak, listening, transcribing, speaking, interim, onDevice, error, listen, stopListening, speak, stopSpeaking, clearError: () => setError(null) };
}

export type Voice = ReturnType<typeof useVoice>;
