# Walkthrough recording

Records the bounty walkthrough of the live site (https://perpguard.app) at
1920x1080 with Playwright and converts it to MP4. Standalone: not part of the
pnpm workspace, and it touches no application code.

    npm install            # Playwright; Chromium via `npx playwright install chromium` if missing
    npm run record         # -> out/perpguard-walkthrough.mp4, out/shots.json
    npm run record:intro   # -> out/perpguard-intro.mp4, out/intro-shots.json: shots 1 to 4, exactly 29 s
    npm run probe          # prints each page's headings, table headers and controls

Needs `ffmpeg` on the PATH (`apt-get install -y ffmpeg`). `out/shots.json`
gives each shot's start and length in the MP4 and any warning raised while
recording. Options are at the top of `record.mjs` (`TRADER=4734`, `CURSOR=0`,
`HEADED=1`, `SITE=`).
