import { useCallback, useEffect, useId, useRef, useState } from "react";

export function useNumericValidity(onFormValidity?: (valid: boolean) => void) {
  const [invalidFields, setInvalidFields] = useState<Record<string, true>>({});
  const valid = Object.keys(invalidFields).length === 0;
  useEffect(() => { onFormValidity?.(valid); }, [valid, onFormValidity]);
  const setValidity = useCallback((field: string, accepted: boolean) => {
    setInvalidFields((previous) => {
      if (accepted) {
        if (!previous[field]) return previous;
        const { [field]: _restored, ...next } = previous;
        return next;
      }
      return previous[field] ? previous : { ...previous, [field]: true };
    });
  }, []);
  return { valid, setValidity };
}

/** Keeps typed text separate from the last validated value. Never coerces empty text to zero. */
export function ValidatedNumberInput({ label, value, onValue, minimum, maximum, integer = false, rejectionHint, disabled = false,
  commitOnChange = false, onValidity,
}: {
  label: string; value: number; onValue: (value: number) => boolean;
  minimum?: number; maximum?: number; integer?: boolean; rejectionHint?: string; disabled?: boolean;
  commitOnChange?: boolean; onValidity?: (valid: boolean) => void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState("");
  const applied = useRef(value);
  const validityRef = useRef(onValidity);
  validityRef.current = onValidity;
  const errorId = useId();
  useEffect(() => {
    // Our accepted edit already updated applied; keep its exact typed spelling.
    // A different external value replaces the draft and clears its error.
    if (Object.is(value, applied.current)) return;
    applied.current = value; setText(String(value)); setError(""); validityRef.current?.(true);
  }, [value]);
  useEffect(() => () => { validityRef.current?.(true); }, []);
  const kind = integer ? "whole number" : "finite value";
  const rangeHint = minimum !== undefined && maximum !== undefined
    ? `Enter a ${kind} from ${minimum} to ${maximum}.`
    : minimum === Number.MIN_VALUE ? "Enter a finite value greater than 0."
    : minimum !== undefined ? `Enter a ${kind} of at least ${minimum}.`
    : maximum !== undefined ? `Enter a ${kind} of at most ${maximum}.`
    : integer ? "Enter a whole number." : "Enter a finite number.";
  const commit = (draft = text) => {
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number) || (integer && !Number.isSafeInteger(number))
      || (minimum !== undefined && number < minimum) || (maximum !== undefined && number > maximum)) {
      setError(rangeHint); validityRef.current?.(false); return;
    }
    if (Object.is(number, applied.current)) { setError(""); validityRef.current?.(true); return; }
    if (!onValue(number)) { setError(rejectionHint ?? "This value is not valid for the current settings."); validityRef.current?.(false); return; }
    applied.current = number;
    setError("");
    validityRef.current?.(true);
  };
  return <><input aria-label={label} aria-invalid={Boolean(error)} aria-description={error || rangeHint}
    aria-describedby={error ? errorId : undefined} disabled={disabled}
    inputMode={integer ? "numeric" : "decimal"} value={text} title={error || rangeHint}
    onChange={(event) => {
      setText(event.target.value); setError("");
      if (commitOnChange) commit(event.target.value);
    }} onBlur={() => commit()}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (document.activeElement === event.currentTarget) event.currentTarget.blur(); else commit();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setText(String(applied.current)); setError(""); validityRef.current?.(true);
      }
    }} />{error && <small id={errorId} role="alert">{error}</small>}</>;
}
