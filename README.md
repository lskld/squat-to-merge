# Squat-to-Merge

A fun GitHub App that requires PR authors to complete **10 squats on camera** before their pull request can be merged. Viewers can watch the squat challenge live via a shared room link.

✨ **This is a vibe-coded project made at the Chas Hack hackathon!**

## How It Works

1. Sign in with GitHub and install the app on your repositories.
2. Select repositories to watch from the dashboard.
3. When a PR is opened on a watched repo, the app posts a comment with a link to a **Squat Room**.
4. The PR author joins the room, turns on their webcam, and performs 10 squats — detected in real-time using [MediaPipe Pose Landmarker](https://developers.google.com/mediapipe/solutions/vision/pose_landmarker).
5. Anyone with the room link can watch the live video stream via [LiveKit](https://livekit.io/).
6. Once 10 squats are completed, the PR is automatically merged.

## Tech Stack

| Layer              | Technology                                                         |
| ------------------ | ------------------------------------------------------------------ |
| Frontend           | React 19, TypeScript, Vite, LiveKit Client, MediaPipe Tasks Vision |
| Backend            | ASP.NET Core (.NET 10), Minimal APIs                               |
| Orchestration      | .NET Aspire                                                        |
| Auth               | GitHub OAuth (cookie-based)                                        |
| Video              | LiveKit (WebRTC)                                                   |
| GitHub Integration | Octokit, GitHub App webhooks                                       |

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js](https://nodejs.org/) (LTS recommended)
- [Microsoft DevTunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/) — provides a public URL to your local server for GitHub webhooks and multi-user access
- A **GitHub App** with:
  - OAuth enabled (client ID + secret)
  - A private key (PEM)
  - Webhook permissions for `pull_request` events
  - Repository permissions: Pull Requests (read/write), Webhooks (read/write), Contents (read/write)
- A **LiveKit** server (cloud or self-hosted) with an API key and secret

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/lskld/squat-to-merge.git
cd squat-to-merge
```

### 2. Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

### 3. Set up Microsoft DevTunnel

DevTunnel provides a public URL that allows GitHub webhooks to reach your local server and lets multiple people connect to the app over the internet.

Install DevTunnel:

```bash
dotnet tool install -g Microsoft.DevTunnels.CLI
```

Create and host a tunnel:

```bash
devtunnel create --access public
devtunnel host
```

Note the public URL (e.g., `https://xxxxxxxx.devtunnels.ms`). You'll use this as your app's base URL.

### 4. Configure secrets

The Aspire AppHost uses [.NET User Secrets](https://learn.microsoft.com/aspnet/core/security/app-secrets). Set the required parameters from the `squat-to-merge.AppHost` project directory:

```bash
cd squat-to-merge.AppHost

dotnet user-secrets set "Parameters:github-app-id" "<your-github-app-id>"
dotnet user-secrets set "Parameters:github-app-slug" "<your-github-app-slug>"
dotnet user-secrets set "Parameters:github-client-id" "<your-github-oauth-client-id>"
dotnet user-secrets set "Parameters:github-client-secret" "<your-github-oauth-client-secret>"
dotnet user-secrets set "Parameters:github-private-key-pem" "<your-github-app-private-key-pem>"
dotnet user-secrets set "Parameters:webhook-secret" "<a-random-webhook-secret>"
dotnet user-secrets set "Parameters:livekit-api-key" "<your-livekit-api-key>"
dotnet user-secrets set "Parameters:livekit-api-secret" "<your-livekit-api-secret>"
dotnet user-secrets set "Parameters:livekit-url" "wss://<your-livekit-host>"

cd ..
```

Optionally, configure the app's base URL for DevTunnel. If not set, the app auto-detects from request headers:

```bash
cd squat-to-merge.Server

dotnet user-secrets set "App:BaseUrl" "https://your-devtunnel-url.devtunnels.ms"

cd ..
```

### 5. Run the application

Ensure **DevTunnel is running in a separate terminal**, then start the app via Aspire AppHost:

```bash
dotnet run --project squat-to-merge.AppHost
```

This launches:

- The **ASP.NET Core backend** (API + GitHub OAuth + webhook handler), accessible via your DevTunnel URL
- The **Vite dev server** for the React frontend on port `5173`

Open the Aspire dashboard URL printed in the terminal to see both services. Access the app using your **DevTunnel public URL** to share with others or test webhooks.

## Project Structure

```
squat-to-merge.AppHost/       # .NET Aspire orchestrator
squat-to-merge.Server/        # ASP.NET Core backend
  Services/
    GitHubService.cs           # GitHub App auth, webhooks, PR merging
    LiveKitService.cs          # LiveKit token generation
    RoomManager.cs             # In-memory room & watch tracking
  Program.cs                   # API endpoints (auth, repos, rooms, webhooks)
frontend/                      # React + Vite SPA
  src/
    pages/
      LoginPage.tsx            # GitHub sign-in
      DashboardPage.tsx        # Repo watching & active rooms
      RoomPage.tsx             # Live squat room (squatter + viewer)
    hooks/
      useSquatDetection.ts     # MediaPipe pose detection & squat counting
```

## License

See repository for license details.
