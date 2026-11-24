# Excalidraw auth server

Signs people in with Google, admits only accounts from one Google Workspace domain, and gives the app short-lived Google Drive tokens. It holds each user's refresh token, so the browser never sees one and never needs a Google popup.

## How requests flow

The reverse proxy serves everything from one domain and asks this server about each request before passing it on:

| Path | Goes to | Gated by `/auth/check` |
| --- | --- | --- |
| `/auth/*` | this server | no |
| `/api/*` | this server (stored drawings) | optional: it checks the session itself |
| `/socket.io/*` | `excalidraw-room` (live collab) | yes |
| everything else | the built app (static files) | yes |

`GET /auth/check` answers `200` with an `X-Auth-Email` header for a signed-in user. For a signed-out page load (`GET` with `Accept: text/html`) it answers `401` with a small page whose script sends the browser to sign-in. A script is used because collab and share links keep their key in the URL `#fragment`, which never reaches a server. For anything else it answers a bare `401`. The proxy must pass these responses through to the browser. It reads the original method and path from `X-Forwarded-Method` and `X-Forwarded-Uri`.

Sessions last up to 30 days, or 7 days without use. Every hour the server re-checks each active session with Google, so a disabled or deleted account loses access within about an hour. If Google can't be reached, sessions keep working for up to 24 hours from their last successful check.

## Google Cloud setup (Workspace admin)

Do this in a Google Cloud project owned by your Workspace organization.

1. **Enable the APIs.** APIs & Services → Library → enable **Google Drive API** and **Google Picker API**.
2. **Make the app internal.** Google Auth Platform → Audience → user type **Internal**. Only accounts in your organization can then sign in, and Google doesn't review the app.
3. **Branding.** Set the app name and a support email. Add your domain under authorized domains.
4. **Data access.** Add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/drive.file`.
5. **Create the client.** Clients → Create client → **Web application**. Add the authorized redirect URI `https://<your-domain>/auth/callback`, and `http://localhost:3001/auth/callback` for local development. Copy the client ID and secret into the environment below.
6. **Create the picker key** (for "Import from Google Drive" and "Choose another folder in Google Drive", which reach files and folders the app hasn't seen yet). APIs & Services → Credentials → Create credentials → **API key**. Restrict it to **Websites** `https://<your-domain>/*` (and `http://localhost:3001/*` for development) and to the **Google Picker API**. This key is sent to browsers by design, so those restrictions are what protect it. Also note the **project number** from IAM & Admin → Settings; it must be the project that owns the OAuth client.
7. **If your organization restricts third-party apps' access to Drive**, open the Admin console → Security → API controls → App access control and mark this client as **Trusted**.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes | Origin users open, e.g. `https://draw.example.com` |
| `GOOGLE_CLIENT_ID` | yes | From step 5 |
| `GOOGLE_CLIENT_SECRET` | yes | From step 5 |
| `ALLOWED_DOMAIN` | one of these two | Workspace domain, e.g. `example.com`, matched against Google's `hd` claim |
| `ALLOWED_EMAILS` | one of these two | Comma-separated accounts let in regardless of domain, e.g. for testing with personal accounts. Leave empty in production unless you mean to make named exceptions. List Gmail or Workspace addresses: a Google account registered with another provider's email can stay "verified" after that address changes hands. Removing an account signs it out on its next request |
| `GOOGLE_PICKER_API_KEY` | no | From step 6. Without it those two links are hidden, and the app only lists drawings and folders it made itself |
| `GOOGLE_PROJECT_NUMBER` | no | From step 6. Set both picker variables or neither |
| `SESSION_SECRET` | yes | Random string of 32+ characters: `openssl rand -base64 48` |
| `DATA_DIR` | no | Where sessions and stored drawings go. Default `./data` |
| `RETENTION_DAYS` | no | Share links and collab rooms not opened for this many days are deleted, with their images. Default `180` |
| `PORT` | no | Default `3015` |

Changing `SESSION_SECRET` signs everyone out.

Build the app with `VITE_APP_AUTH_ENABLED=true` so it shows the signed-in user and fetches Drive tokens from this server.

## Storage

This server also replaces Firebase and the public share-link backend, so drawings never leave your server. The browser encrypts everything before upload; the server never sees a key. Sign-in doesn't leak one either: the key-carrying `#fragment` of a collab or share link waits in the tab's `sessionStorage` while the user signs in, rather than travelling in the return URL. Under `DATA_DIR/storage/` it keeps:

| Endpoint | Holds |
| --- | --- |
| `POST /api/v2/post/`, `GET /api/v2/<id>` | Share-link scenes. Every click on "Export to Link" creates a new one |
| `GET`/`PUT /api/rooms/<roomId>` | The latest snapshot of a collab room. A save must name the revision it started from, so two collaborators saving at once can't overwrite each other |
| `GET`/`PUT /api/files/<rooms or shareLinks>/<id>/<fileId>` | Images, stored with the room or link they belong to. The first upload of an image id is kept |

Every request needs a signed-in session, checked by this server itself. Saving a room also needs a token the browser derives from the room key, pinned by the room's first save, so a coworker who only knows a room's id can't overwrite it. Each user may upload up to 1 GiB of share links and images per day (counted in memory, reset on restart) so a runaway script can't fill the disk. Once an hour it deletes share links and rooms that nobody has opened for `RETENTION_DAYS`, along with their images. Nothing is backed up.

Build the app with `VITE_APP_STORAGE_URL=/api`, `VITE_APP_BACKEND_V2_GET_URL=/api/v2/` and `VITE_APP_BACKEND_V2_POST_URL=/api/v2/post/` to use it.

## Testing without a Workspace admin

If your company account can't create a Google Cloud project, you can test with a personal Google account instead. Google's setup is the same as above except:

- Create the project while signed in to your personal account. Its parent resource is "No organization".
- In **Audience**, choose **External**, leave the publishing status at **Testing**, and add every account that will sign in under **Test users**.
- In `server/.env`, leave `ALLOWED_DOMAIN` empty and list those accounts in `ALLOWED_EMAILS`.

In Testing mode Google's refresh tokens expire after 7 days, so expect to sign in again weekly. Use this only for testing: the production project should be Internal to your Workspace, with `ALLOWED_DOMAIN` set.

## Local development

Fill in the Google client, then start this server:

```bash
cp server/.env.example server/.env
yarn --cwd server dev
```

Live collaboration needs the `excalidraw-room` relay. Production puts it behind the proxy at `/socket.io`; locally it runs on its own port:

```bash
docker run -d --name excalidraw-room -p 3003:80 -e PORT=80 excalidraw/excalidraw-room:latest
```

In a second terminal, start the app with the same flags `deploy/app.Dockerfile` builds with, plus the relay's address:

```bash
VITE_APP_SELF_HOSTED=true \
VITE_APP_AUTH_ENABLED=true \
VITE_APP_STORAGE_URL=/api \
VITE_APP_BACKEND_V2_GET_URL=/api/v2/ \
VITE_APP_BACKEND_V2_POST_URL=/api/v2/post/ \
VITE_APP_FIREBASE_CONFIG={} \
VITE_APP_ENABLE_TRACKING=false \
VITE_APP_DISABLE_SENTRY=true \
VITE_APP_WS_SERVER_URL=http://localhost:3003 \
yarn start
```

Without `VITE_APP_SELF_HOSTED` the app shows the Excalidraw+ links and the AI features this build is meant to hide. The dev server proxies `/auth` and `/api` to this server, so open `http://localhost:3001`. Next time, `docker start excalidraw-room` brings the relay back.

Locally the relay doesn't check sign-in, since nothing runs `/auth/check` in front of it. The room key never reaches it either way.

To try collaboration with several accounts, list them in `ALLOWED_EMAILS` (and as test users if the app is in Testing), then sign each one in from a separate browser profile or a private window, and open the same collab link.
