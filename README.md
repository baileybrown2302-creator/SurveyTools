# SurveyTools
Level Looping tool and other survey helping tools

## Demo version (`/demo/`)

A desktop demonstration build: the app runs inside a phone frame on the left and a map with walk
controls on the right (arrow keys or on-screen buttons, click the map to jump). GPS, compass and
camera are simulated, and it keeps its own data (separate databases), preloaded with the Carson City
demo project. **Reset demo** puts it back to the starting state.

- `demo/index.html` – the desktop shell (map, controls, demo data seeding)
- `demo/demo_sim.js` – simulated GPS / compass / camera, loaded first on every demo app page
- `demo/app/` – generated copy of the main app. **Do not edit by hand**; after changing the main app run
  `python3 tools/build_demo.py`
