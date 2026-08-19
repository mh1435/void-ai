/*
 * Void Music — a music player for open catalogues.
 * Copyright (C) 2026 Void Music contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License in LICENSE for details.
 */
package dev.voidmusic.app;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.accounts.AccountManagerFuture;
import android.accounts.AuthenticatorDescription;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;

/**
 * Signing in with the Google account that is already on the phone.
 *
 * <p>This is the path that asks nothing of the user but a tap: Android shows
 * its own account picker, then Google's own "allow Void Music to see your
 * YouTube account?" prompt, and hands back a token. No client ID, no Cloud
 * console, no pasting. The account manager remembers the grant, so every later
 * token comes back silently — it behaves like staying signed in.
 *
 * <p>It cannot work everywhere, and the app says so when it does not. Google's
 * account manager may refuse a scope for an app it does not recognise, and a
 * phone without Google Play Services has no {@code com.google} authenticator at
 * all. Both failures fall back to the OAuth flow with a client ID, which always
 * works but costs a one-time setup. Trying the easy way first costs one tap to
 * find out.
 *
 * <p>Note what is <em>not</em> needed here: the {@code GET_ACCOUNTS} permission.
 * Since Android 8 an app sees only the accounts it has been granted, and
 * choosing one in the system picker is itself that grant. The app never gets to
 * look at the account list.
 */
final class AccountAuth {

    private static final String TAG = "VoidMusic";
    private static final String PREFS = "void_account";
    private static final String KEY_ACCOUNT = "account_name";

    private static final String GOOGLE = "com.google";
    private static final String SCOPE = "oauth2:https://www.googleapis.com/auth/youtube.readonly";

    /** Google's tokens last about an hour; treat ours as stale well before that. */
    private static final long TOKEN_LIFETIME_MS = 45 * 60 * 1000L;

    private static String cachedToken = "";
    private static long cachedAt;

    private AccountAuth() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** True when the phone has a Google account authenticator to ask at all. */
    static boolean available(Context context) {
        try {
            for (AuthenticatorDescription d : AccountManager.get(context).getAuthenticatorTypes()) {
                if (GOOGLE.equals(d.type)) return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "no account manager: " + e.getMessage());
        }
        return false;
    }

    static String accountName(Context context) {
        return prefs(context).getString(KEY_ACCOUNT, "");
    }

    static boolean signedIn(Context context) {
        return !accountName(context).isEmpty();
    }

    static synchronized void signOut(Context context) {
        prefs(context).edit().remove(KEY_ACCOUNT).apply();
        cachedToken = "";
        cachedAt = 0;
    }

    /** The account picker Android draws itself. */
    static Intent chooserIntent() {
        return AccountManager.newChooseAccountIntent(
                null, null, new String[]{ GOOGLE }, null, null, null, null);
    }

    /**
     * The user picked an account. Ask for a token, which is what makes Google
     * show its consent prompt the first time.
     *
     * <p>Runs off the main thread: {@code getAuthToken} may put a screen in
     * front of the user and blocks until they answer it.
     */
    static void authorise(Activity activity, String name) {
        if (name == null || name.isEmpty()) {
            fail("No account chosen");
            return;
        }

        final Context app = activity.getApplicationContext();

        new Thread(() -> {
            AccountManager manager = AccountManager.get(app);
            Account account = new Account(name, GOOGLE);

            try {
                // Passing the Activity is the whole point: it is what allows
                // the authenticator to put the consent screen on top of us.
                AccountManagerFuture<Bundle> future =
                        manager.getAuthToken(account, SCOPE, null, activity, null, null);
                Bundle result = future.getResult();
                String token = result.getString(AccountManager.KEY_AUTHTOKEN);

                if (token == null || token.isEmpty()) {
                    report(false, "Google did not grant access");
                    return;
                }

                remember(app, name, token);
                report(true, "");
            } catch (Exception e) {
                Log.w(TAG, "account sign-in failed: " + e.getMessage());
                report(false, describe(e));
            }
        }, "void-account-auth").start();
    }

    private static synchronized void remember(Context context, String name, String token) {
        prefs(context).edit().putString(KEY_ACCOUNT, name).apply();
        cachedToken = token;
        cachedAt = System.currentTimeMillis();
    }

    /**
     * A usable token for the signed-in account, or an empty string.
     *
     * <p>Called from the JavaScript bridge, which already runs on a worker
     * thread, so blocking here is correct. A token is reused until it is old
     * enough to be worth replacing; then the stale copy is invalidated, because
     * the account manager would otherwise keep handing back the same dead
     * string until it expired from its own cache.
     */
    static synchronized String token(Context context) {
        String name = accountName(context);
        if (name.isEmpty()) return "";

        if (!cachedToken.isEmpty() && System.currentTimeMillis() - cachedAt < TOKEN_LIFETIME_MS) {
            return cachedToken;
        }

        Context app = context.getApplicationContext();
        AccountManager manager = AccountManager.get(app);
        Account account = new Account(name, GOOGLE);

        try {
            if (!cachedToken.isEmpty()) {
                manager.invalidateAuthToken(GOOGLE, cachedToken);
                cachedToken = "";
            }

            // No Activity here: this must never try to show a screen from the
            // background. The grant already exists, so it comes back silently.
            AccountManagerFuture<Bundle> future =
                    manager.getAuthToken(account, SCOPE, null, false, null, null);
            String fresh = future.getResult().getString(AccountManager.KEY_AUTHTOKEN);
            if (fresh == null || fresh.isEmpty()) return "";

            cachedToken = fresh;
            cachedAt = System.currentTimeMillis();
            return fresh;
        } catch (Exception e) {
            Log.w(TAG, "could not get an account token: " + e.getMessage());
            return "";
        }
    }

    /** Tell the page a sign-in did not happen, without an exception to explain it. */
    static void fail(String reason) {
        report(false, reason);
    }

    /** Turn the account manager's exceptions into something worth reading. */
    private static String describe(Exception e) {
        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();

        if (message.contains("UNREGISTERED_ON_API_CONSOLE") || message.contains("INVALID_SCOPE")) {
            return "Google will not sign this app in this way — use the advanced setup below";
        }
        if (message.contains("NetworkError") || message.contains("Unable to resolve host")) {
            return "No connection to Google";
        }
        if (message.contains("canceled") || message.contains("cancelled")) {
            return "You cancelled the sign-in";
        }
        return message;
    }

    private static void report(boolean ok, String error) {
        WebAppHolder.eval("window.__voidAccount && window.__voidAccount("
                + ok + ",\"" + error.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ") + "\")");
    }
}
