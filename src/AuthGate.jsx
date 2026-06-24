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
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState("");

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

  async function sendLink(e) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setStatus("sending");
    setErrorMsg("");
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: {
        // Return to this exact app URL after the link is clicked.
        emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
      },
    });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
    } else {
      setStatus("sent");
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

          {status === "sent" ? (
            <div className="bg-[#343746] border border-[#50fa7b]/40 rounded-lg p-4 text-sm text-center">
              <p className="text-[#50fa7b] font-medium">Check your email</p>
              <p className="mt-1 text-[#6272a4]">
                We sent a sign-in link to <span className="text-[#f8f8f2]">{email.trim()}</span>.
                Open it on this device to continue.
              </p>
            </div>
          ) : (
            <form onSubmit={sendLink} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]"
              />
              <button
                type="submit"
                disabled={status === "sending" || !email.trim()}
                className="w-full rounded-lg px-3 py-2.5 text-sm font-medium bg-[#bd93f9] text-[#282a36] disabled:bg-[#21222c] disabled:text-[#44475a]"
              >
                {status === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
              {status === "error" && (
                <p className="text-xs text-[#ff5555]">{errorMsg || "Something went wrong. Try again."}</p>
              )}
            </form>
          )}
        </div>
      </div>
    );
  }

  return children;
}
