# Driver Payroll (Live Collaboration)

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm start
```

4. Open from browser:

- Local: `http://localhost:3000`
- Team access: `http://<your-computer-ip>:3000`

## Notes

- All connected users see edits live.
- Shared data is saved to `data/payroll-state.json`.
- To reset all shared data, stop server and delete `data/payroll-state.json`.

## Deploy To Render (24/7)

1. Push this folder to a GitHub repo.
2. In Render, click `New +` -> `Blueprint`.
3. Select your repo and deploy.
4. Render will read `render.yaml` and create:
   - Node web service
   - Persistent disk mounted at `/var/data`
5. Share your Render URL (for example `https://driver-payroll-live.onrender.com`).

### Important

- Keep `plan: starter` (or higher) to use the persistent disk.
- Persistent shared state in production is saved to `/var/data/payroll-state.json`.
