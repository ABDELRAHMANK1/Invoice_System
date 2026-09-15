"use client";

import { useId, useState } from "react";
import { Icon, I } from "./Icon";

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is a real <button type="button"> — inside a <form>, a bare
 * <button> defaults to type="submit", so revealing the password would submit
 * the login form instead.
 *
 * It never leaves the field's own tab order trap: `tabIndex={-1}` keeps Tab
 * going password → submit, the way a password manager and a keyboard user both
 * expect, while the button stays clickable.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  hint,
  required = true,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  hint?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [shown, setShown] = useState(false);

  return (
    <div className="form-group">
      <label className="form-label" htmlFor={inputId}>{label}</label>
      <div className="pw-wrap">
        <input
          id={inputId}
          className="form-input pw-input"
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pw-toggle"
          tabIndex={-1}
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          title={shown ? "Hide password" : "Show password"}
        >
          <Icon d={shown ? I.eyeOff : I.eye} size={15} />
        </button>
      </div>
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  );
}
