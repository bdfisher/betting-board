import React, { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { setActiveUserId, migrateLocalDataToUser } from "./storage";

// Wraps the app. If Supabase Auth is configured, it requires the user to sign in
// via an email magic link before showing the board. The signed-in user's id
// becomes the board id (see storage.js), so the board syncs across every device
// the user logs into.
export default function AuthGate({ children }) {
  // undefined = still checking; null = signed out; object = signed in
  const [session, setSession] = useState(isSupabaseConfigured ? undefined : null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | checkEmail | error
  const [errorMsg, setErrorMsg] = useState("");
  const [authMode, setAuthMode] = useState("sign-in"); // sign-in | sign-up

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setActiveUserId(data.session?.user?.id ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
      setActiveUserId(s?.user?.id ?? null);
      if (s?.user?.id) migrateLocalDataToUser();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // No backend configured → run local-only, no login required.
  if (!isSupabaseConfigured) return children;

  async function handleSubmit(e) {
    e.preventDefault();
    const addr = email.trim();
    const pass = password;
    if (!addr || !pass) return;
    setStatus("submitting");
    setErrorMsg("");

    if (authMode === "sign-in") {
      const { error } = await supabase.auth.signInWithPassword({
        email: addr,
        password: pass,
      });
      if (error) {
        setStatus("error");
        setErrorMsg(error.message);
      }
    } else {
      const { data, error } = await supabase.auth.signUp({
        email: addr,
        password: pass,
      });
      if (error) {
        setStatus("error");
        setErrorMsg(error.message);
      } else if (!data.session) {
        setStatus("checkEmail");
      }
    }
  }

  if (session === undefined) {
    return (
      <div className="min-h-[100dvh] bg-[#282a36] text-[#f8f8f2] flex items-center justify-center">
        <div className="text-[#6272a4] text-sm">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-[100dvh] bg-[#282a36] text-[#f8f8f2] flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Bet Board</h1>
            <p className="mt-1 text-sm text-[#6272a4]">Sign in to sync your board across devices.</p>
          </div>

          <div className="space-y-4">
            <div className="bg-[#343746] border border-[#44475a] rounded-lg p-4 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-lg font-semibold text-[#f8f8f2]">
                    {authMode === "sign-in" ? "Sign in" : "Create account"}
                  </p>
                  <p className="mt-1 text-[#6272a4] text-sm">
                    {authMode === "sign-in"
                      ? "Use your email and password to access your synced board."
                      : "Create a new account with email and password."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode(authMode === "sign-in" ? "sign-up" : "sign-in");
                    setErrorMsg("");
                    setStatus("idle");
                  }}
                  className="text-xs font-semibold text-[#bd93f9] hover:text-[#ff79c6]"
                >
                  {authMode === "sign-in" ? "Create account" : "Sign in"}
                </button>
              </div>
            </div>

            {status === "checkEmail" ? (
              <div className="bg-[#343746] border border-[#50fa7b]/40 rounded-lg p-4 text-sm text-center">
                <p className="text-[#50fa7b] font-medium">Check your email</p>
                <p className="mt-1 text-[#6272a4]">
                  We sent a confirmation email to <span className="text-[#f8f8f2]">{email.trim()}</span>. Follow the link to finish signing up.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]"
                />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]"
                />
                <button
                  type="submit"
                  disabled={status === "submitting" || !email.trim() || !password}
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-medium bg-[#bd93f9] text-[#282a36] disabled:bg-[#21222c] disabled:text-[#44475a]"
                >
                  {status === "submitting"
                    ? authMode === "sign-in" ? "Signing in…" : "Creating account…"
                    : authMode === "sign-in" ? "Sign in" : "Sign up"}
                </button>
                {status === "error" && (
                  <p className="text-xs text-[#ff5555]">{errorMsg || "Something went wrong. Try again."}</p>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  return children;
}
