import { useState } from "react";
import type { UseAuthResult } from "./useAuth";

type AuthGateProps = {
  auth: UseAuthResult;
};

export function AuthGate({ auth }: AuthGateProps) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const onSendCode = async () => {
    setError(null);
    setStatus("");
    if (!email.trim()) {
      setError("Enter an email address.");
      return;
    }
    setSending(true);
    const result = await auth.sendOtp(email.trim());
    setSending(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to send code.");
      return;
    }
    setStatus("Check your email for a 6-digit code.");
  };

  const onVerifyCode = async () => {
    setError(null);
    setStatus("");
    if (!email.trim()) {
      setError("Enter the same email used for the code.");
      return;
    }
    if (!token.trim()) {
      setError("Enter the code from email.");
      return;
    }
    setVerifying(true);
    const result = await auth.verifyOtp(email.trim(), token.trim());
    setVerifying(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to verify code.");
      return;
    }
    setStatus("Signed in.");
  };

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <h1>Ceramic</h1>
        <p className="muted">Sign in with email to load your atom stream.</p>
        {auth.configMissing && (
          <p className="error">Missing Supabase config. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.</p>
        )}
        {auth.error && <p className="error">Auth error: {auth.error}</p>}
        <label>Email</label>
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <button disabled={sending || auth.configMissing} onClick={onSendCode}>
          {sending ? "Sending..." : "Send code"}
        </button>

        <label>Code</label>
        <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="6-digit code" />
        <button disabled={verifying || auth.configMissing} onClick={onVerifyCode}>
          {verifying ? "Verifying..." : "Verify code"}
        </button>

        {status && <p className="ok">{status}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
