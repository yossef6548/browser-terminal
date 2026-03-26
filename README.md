# Browser Terminal via Vercel + Tailscale Funnel

This repo contains a full two-part implementation:

- `frontend/` — a Next.js app for Vercel, using `xterm.js` for a real terminal UI.
- `backend/` — a Node.js PTY service for Ubuntu machine, using `node-pty` to run a real login shell.

The browser stays on Vercel domain. Vercel rewrites `/backend/*` requests to Tailscale Funnel URL, so user's browser never needs to resolve or open the Funnel domain directly.

## What you get

- real shell in the browser
- Enter to run commands
- Up arrow history
- Tab completion
- Ctrl+C, colors, prompt editing
- terminal resize support
- token-based backend auth
- one-click Vercel deployment once the repo is on GitHub

## High-level architecture

1. Browser opens Vercel app.
2. The terminal UI sends input to `/backend/...` on the same Vercel domain.
3. Vercel rewrites those requests to backend origin.
4. Ubuntu backend writes input into a real PTY running `/bin/bash -l`.
5. Output is streamed back to the browser over Server-Sent Events.

## Important note about why this design was chosen

Vercel supports rewrites to external origins and also supports streaming responses from functions/pages, while Vercel Functions do not support acting as a WebSocket server. That is why this implementation uses a real PTY plus normal HTTPS requests and SSE instead of browser WebSockets.

## Files

### Frontend

- `frontend/app/page.tsx` — terminal page
- `frontend/components/TerminalPage.tsx` — terminal logic
- `frontend/next.config.mjs` — Vercel rewrite to your backend origin
- `frontend/vercel.json` — Vercel config

### Backend

- `backend/src/server.js` — Express + PTY backend
- `backend/.env.example` — environment template
- `backend/browser-terminal.service` — optional systemd user service

---

# Step-by-step setup

## Part 1 — Prepare the backend on Ubuntu

### 1. Copy the backend folder to Ubuntu

Put the `backend/` folder somewhere under your home directory. Example:

```bash
mkdir -p ~/browser-terminal
```

Then copy the folder there so you get:

```bash
~/browser-terminal/backend
```

### 2. Install prerequisites

```bash
sudo apt update
sudo apt install -y curl build-essential python3 make g++
```

Install Node.js 20 if it is not already installed:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Check versions:

```bash
node -v
npm -v
```

### 3. Install backend dependencies

```bash
cd ~/browser-terminal/backend
npm install
```

### 4. Create the backend environment file

```bash
cp .env.example .env
nano .env
```

Set at least:

```env
PORT=5000
HOST=127.0.0.1
TERMINAL_TOKEN=replace-this-with-a-long-random-secret
SHELL_PATH=/bin/bash
IDLE_TIMEOUT_MS=21600000
MAX_SESSIONS=3
CORS_ORIGIN=
```

Generate a strong token if you want:

```bash
openssl rand -hex 32
```

### 5. Start the backend manually for the first test

```bash
cd ~/browser-terminal/backend
npm start
```

In another SSH terminal on Ubuntu, test health:

```bash
curl http://127.0.0.1:5000/health
```

You should get JSON like:

```json
{"ok":true,"sessions":0}
```

## Part 2 — Expose the backend with Tailscale Funnel

Tailscale’s current CLI docs show that `tailscale funnel <port>` exposes a local service on that port to the public internet over HTTPS.

### 6. Start Funnel

On Ubuntu, while the backend is listening on `127.0.0.1:5000`:

```bash
sudo tailscale funnel 5000
```

Tailscale should print a public HTTPS URL ending in `.ts.net`, with the local target proxied to `http://127.0.0.1:5000`.

Keep that URL. Example:

```text
https://your-node-name.some-tail.ts.net
```

### 7. Confirm the Funnel URL works from a device that can reach it

From your phone browser, open:

```text
https://your-node-name.some-tail.ts.net/health
```

You should get the same JSON health response.

## Part 3 — Deploy the frontend to GitHub and Vercel

### 8. Import the repo into Vercel

- Log in to Vercel
- Add New Project
- Import the GitHub repo
- make sure defining root as ./frontend/
- Framework preset should be detected as Next.js

### 10. Set the environment variable in Vercel

In the Vercel project settings, add:

- Name: `TERMINAL_BACKEND_ORIGIN`
- Value: your Funnel origin, for example:

```text
https://your-node-name.some-tail.ts.net
```

This is used by `frontend/next.config.mjs` to rewrite `/backend/:path*` to your backend origin. Vercel’s rewrite docs explicitly support routing to external origins while keeping the browser URL unchanged.
### 11. Deploy

Trigger the first deployment in Vercel.

After deploy, your public app will be on a Vercel domain such as:

```text
https://your-project.vercel.app
```

## Part 4 — First connection test

### 12. Open the Vercel app from your work PC

Open your Vercel URL.

### 13. Paste the token

Paste the exact value of `TERMINAL_TOKEN` from the backend `.env` file into the token field.

### 14. Click Connect

If everything is set correctly, you should see a real Bash prompt.

You can now test:

```bash
pwd
ls
cd ..
cat ~/.bashrc
```

Try these terminal-specific behaviors:

- press `Up Arrow` to recall history
- press `Tab` for completion
- press `Ctrl+C` to interrupt a command
- resize the browser window and run `stty size`

Those behaviors come from the real shell inside the PTY, not from custom browser shortcuts.

---

# Make the backend persistent on Ubuntu

## Option A — Keep it open in a tmux or screen session

Simple and fine for testing.

## Option B — systemd user service

### 15. Install the systemd unit

Copy the included service file:

```bash
mkdir -p ~/.config/systemd/user
cp ~/browser-terminal/backend/browser-terminal.service ~/.config/systemd/user/browser-terminal.service
```

### 16. Reload and start it

```bash
systemctl --user daemon-reload
systemctl --user enable --now browser-terminal.service
systemctl --user status browser-terminal.service
```

---

# Ongoing daily usage

## Start backend service

If using systemd, it starts automatically.

## Start Funnel

Unless you configured Funnel to persist in the background, start it when needed:

```bash
sudo tailscale funnel 5000
```

Then open your Vercel URL from work.

---

# Troubleshooting

## The Vercel page opens but Connect fails immediately

Check the backend logs on Ubuntu:

```bash
cd ~/browser-terminal/backend
npm start
```

Or if using systemd:

```bash
journalctl --user -u browser-terminal.service -f
```

## `/health` works on the Funnel URL but not through Vercel

Check that `TERMINAL_BACKEND_ORIGIN` in Vercel exactly matches the Funnel origin and includes `https://`.

## You get Unauthorized

The token you pasted in the Vercel UI does not match `TERMINAL_TOKEN` in `backend/.env`.

## The session disappears after inactivity

Increase `IDLE_TIMEOUT_MS` in `backend/.env`.

## Tab completion or history do not work correctly

Make sure the backend shell is really `/bin/bash` and that the PTY is being created successfully. This implementation spawns `/bin/bash -l` in a real pseudoterminal.

---

# Security notes

- Anyone with your Vercel URL still needs the backend token before they can open a shell.
- Keep the token long and random.
- Do not commit `.env`.
- This is powerful remote shell access. Treat it like SSH access.

---

