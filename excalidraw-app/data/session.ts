import { useEffect, useState } from "react";

import { atom, appJotaiStore } from "../app-jotai";

export type CurrentUser = {
  email: string;
  name: string;
  picture: string | null;
  driveAccess: boolean;
  picker: { apiKey: string; appId: string } | null;
};

/** The auth server's session is gone; only a new sign-in fixes it. */
export class SignedOutError extends Error {
  constructor() {
    // collab shows this text as-is
    super("Your session has ended. Reload the page to sign in again.");
    this.name = "SignedOutError";
  }
}

export const isAuthEnabled = () =>
  import.meta.env.VITE_APP_AUTH_ENABLED === "true";

export const currentUserAtom = atom<CurrentUser | null>(null);

// Collab and share links keep their encryption key in the #fragment. Sending
// it through sign-in would hand it to the server, so it waits in this tab's
// sessionStorage instead. The server's sign-in page writes the same record.
const RETURN_HASH_KEY = "excalidraw-return-hash";
// long enough for a Google sign-in, short enough not to resurface later
const RETURN_HASH_MAX_AGE_MS = 10 * 60 * 1000;

type ReturnHash = { path: string; hash: string; at: number };

const currentPath = () =>
  `${window.location.pathname}${window.location.search}`;

export const signInUrl = () => {
  try {
    if (window.location.hash) {
      const record: ReturnHash = {
        path: currentPath(),
        hash: window.location.hash,
        at: Date.now(),
      };
      sessionStorage.setItem(RETURN_HASH_KEY, JSON.stringify(record));
    }
  } catch {
    // storage blocked: the link opens without its room after sign-in
  }
  return `/auth/login?${new URLSearchParams({ returnTo: currentPath() })}`;
};

/** Puts a link's #fragment back once sign-in returns to the same page. */
export const restoreHashAfterSignIn = () => {
  try {
    const raw = sessionStorage.getItem(RETURN_HASH_KEY);
    if (!raw) {
      return;
    }
    sessionStorage.removeItem(RETURN_HASH_KEY);
    const saved = JSON.parse(raw) as ReturnHash;
    if (
      !window.location.hash &&
      saved.path === currentPath() &&
      Date.now() - saved.at < RETURN_HASH_MAX_AGE_MS
    ) {
      window.history.replaceState(null, "", `${saved.path}${saved.hash}`);
    }
  } catch {
    // unreadable record: nothing to restore
  }
};

// at import: the app reads location.hash for the room while it first renders
restoreHashAfterSignIn();

export const fetchCurrentUser = async (): Promise<CurrentUser> => {
  const response = await fetch("/auth/me", { credentials: "same-origin" });
  if (response.status === 401) {
    throw new SignedOutError();
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the signed-in user (${response.status})`);
  }
  return response.json();
};

export const signOut = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.assign("/auth/signed-out");
};

/**
 * Loads the signed-in user and returns whether the app may render. In
 * production the reverse proxy already blocks signed-out visitors; this covers
 * the dev server, which has no proxy, and would otherwise show the canvas
 * until the redirect to sign-in lands.
 */
export const useSessionReady = () => {
  const [ready, setReady] = useState(!isAuthEnabled());
  useEffect(() => {
    if (!isAuthEnabled()) {
      return;
    }
    fetchCurrentUser().then(
      (user) => {
        appJotaiStore.set(currentUserAtom, user);
        setReady(true);
      },
      (error) => {
        if (error instanceof SignedOutError) {
          window.location.assign(signInUrl());
        } else {
          // auth server unreachable: keep the app usable for local drawing
          console.error(error);
          setReady(true);
        }
      },
    );
  }, []);
  return ready;
};
